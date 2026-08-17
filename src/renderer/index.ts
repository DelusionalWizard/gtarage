/**
 * Renderer.
 *
 * Deliberately framework-free and, just as deliberately, built entirely with
 * DOM calls rather than HTML strings. Mod names and file paths come from
 * archives written by strangers; funnelling them through `textContent` means
 * a mod called `<img onerror=...>` is just an oddly named mod.
 *
 * There are no top-level imports here on purpose: the shared types arrive
 * ambiently from `globals.d.ts`, which keeps this file a classic script that
 * TypeScript emits verbatim -- no bundler, no module loader, nothing for the
 * strict CSP to object to.
 */

const api = window.gtarage;

// --- local view state -------------------------------------------------------

/**
 * Settings is not in this list: it lives in the header and opens as its own
 * view, because it is app configuration rather than one of the things you
 * switch between while managing mods.
 */
type TabId =
  | 'home'
  | 'profile'
  | 'library'
  | 'tools'
  | 'settings'
  | 'speedrun'
  | 'saves';

let state: AppState | null = null;
// Home is the landing screen: nearly every session is 'play what I already
// set up', not 'manage my library'.
let tab: TabId = 'home';
let search = '';
let filter = 'all';
/** Hide mods switched off in the current profile, to keep the list readable. */
let hideDisabled = false;
let saves: SaveSnapshotView[] = [];
/** Hand-installed files found in the game folder, offered for import. */
let adoptable: AdoptGroupView[] = [];
/** Speedrun tools, refreshed when that tab is opened. */
let speedrunTools: SpeedrunToolView[] = [];
/** Community links for the speedrun tab, fetched once from the main process. */
let speedrunGroups: SpeedrunResourceGroup[] = [];
/** Kept in step with PRACTICE_PROFILE_NAME in shared/speedrun.ts. */
const PRACTICE_PROFILE = 'Practice';
/** Set once the ScriptHookV prompt has been shown or dismissed this session. */
let hookPromptSettled = false;
/**
 * Whether the game is running right now.
 *
 * Not part of AppState: it changes without anything in the app happening, so
 * it is polled rather than pushed. Drives the difference between 'Play now'
 * and 'Running'.
 */
let gameRunning = false;
let runningTimer: number | null = null;

async function refreshRunning(): Promise<void> {
  const id = state?.currentGameId;
  if (!id) return;
  try {
    const now = await api.gameRunning(id);
    if (now !== gameRunning) {
      gameRunning = now;
      render();
    }
  } catch {
    // Not being able to tell is not worth reporting; the buttons simply stay
    // as they were.
  }
}
/** Timer used while waiting for a ScriptHookV download to appear. */
let hookWatchTimer: number | null = null;


// --- tiny DOM helpers -------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Byte formatter. Kept local so the renderer needs no runtime imports. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A precise, local, unambiguous timestamp.
 *
 * "3 days ago" is fine for a mod's import date, but useless when you are
 * picking which of six snapshots to restore, so those show the real time.
 */
function formatExact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${date}, ${time} (${formatDate(iso)})`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
}

// --- toasts -----------------------------------------------------------------

function toast(message: string, kind: 'ok' | 'warn' | 'error' | 'info' = 'info'): void {
  const stack = byId('toasts');
  const node = el('div', `toast toast-${kind}`, message);
  stack.appendChild(node);
  setTimeout(() => node.remove(), kind === 'error' ? 9000 : 5000);
}

/** Run an async action with the busy overlay up, turning throws into toasts. */
async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  showOverlay(label);
  try {
    return await fn();
  } catch (err) {
    toast((err as Error).message, 'error');
    return null;
  } finally {
    hideOverlay();
  }
}

// --- overlay ----------------------------------------------------------------

function showOverlay(title: string): void {
  byId('overlay-title').textContent = title;
  byId('overlay-detail').textContent = '';
  byId('overlay-fill').style.width = '0%';
  byId('overlay').hidden = false;
}

function hideOverlay(): void {
  byId('overlay').hidden = true;
}

window.gtarageEvents.onProgress(({ done, total, label }) => {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  byId('overlay-fill').style.width = `${pct}%`;
  byId('overlay-detail').textContent = `${done}/${total} · ${label}`;

  // An Essentials download reports through the same channel. Update that row
  // in place rather than re-rendering the page on every chunk.
  if (toolInstalling && /^Downloading/.test(label)) {
    toolBusy.set(toolInstalling, { received: done, total });
    const fill = document.getElementById(`essbar-${toolInstalling}`);
    if (fill) fill.style.width = `${pct}%`;
    const text = document.getElementById(`esspct-${toolInstalling}`);
    if (text) text.textContent = `${pct}%`;
  }
});

/**
 * Downloads captured by the embedded mod-site browser arrive here, not
 * through a call the UI made, so they get their own listener.
 */
window.gtarageEvents.onSiteEvent((event) => {
  if (event.kind === 'progress') {
    // Deliberately silent: a toast per chunk would be a stream of noise, and
    // the completion event already reports the outcome.
    return;
  }
  toast(
    event.message,
    event.kind === 'imported' ? 'ok' : event.kind === 'staged' ? 'warn' : 'error',
  );
  if (event.kind === 'imported') void refresh();
});

// --- modal ------------------------------------------------------------------

interface ModalOptions {
  title: string;
  subtitle?: string;
  build: (body: HTMLElement) => void;
  /** Footer buttons. Returning true closes the modal. */
  actions: Array<{
    label: string;
    kind?: 'primary' | 'danger' | 'plain';
    disabled?: boolean;
    onClick: () => boolean | Promise<boolean>;
  }>;
}

function openModal(options: ModalOptions): void {
  const scrim = byId('modal-scrim');
  byId('modal-title').textContent = options.title;
  const sub = byId('modal-sub');
  sub.textContent = options.subtitle ?? '';
  sub.hidden = !options.subtitle;

  const body = byId('modal-body');
  clear(body);
  options.build(body);

  const foot = byId('modal-foot');
  clear(foot);
  foot.appendChild(el('div', 'spacer'));

  for (const action of options.actions) {
    const cls =
      action.kind === 'primary'
        ? 'small-btn is-primary'
        : action.kind === 'danger'
          ? 'danger-btn'
          : 'small-btn';
    const btn = el('button', cls, action.label);
    btn.disabled = Boolean(action.disabled);
    btn.addEventListener('click', async () => {
      if (await action.onClick()) closeModal();
    });
    foot.appendChild(btn);
  }

  scrim.hidden = false;
  body.querySelector('input, select')?.dispatchEvent(new Event('focus'));
  (body.querySelector('input, select') as HTMLElement | null)?.focus();
}

function closeModal(): void {
  byId('modal-scrim').hidden = true;
}

/** Ask for one line of text. Resolves null when cancelled. */
function promptModal(title: string, label: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    let input: HTMLInputElement;
    openModal({
      title,
      build: (body) => {
        body.appendChild(el('div', 'field-label', label));
        input = el('input', 'text-input') as HTMLInputElement;
        input.type = 'text';
        input.value = value;
        body.appendChild(input);
        // The field is the only thing here, so focusing it saves a click.
        window.setTimeout(() => input.select(), 30);
      },
      actions: [
        { label: 'Cancel', onClick: () => (resolve(null), true) },
        {
          label: 'Save',
          kind: 'primary',
          onClick: () => (resolve(input.value.trim() || null), true),
        },
      ],
    });
  });
}

function confirmModal(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    openModal({
      title,
      build: (body) => {
        body.appendChild(el('div', 'alert-body', message));
      },
      actions: [
        { label: 'Cancel', onClick: () => (resolve(false), true) },
        { label: confirmLabel, kind: 'danger', onClick: () => (resolve(true), true) },
      ],
    });
  });
}

// --- rendering: title bar ---------------------------------------------------

const ERA_LABEL: Record<GameView['era'], string> = {
  hd: 'HD era',
  de: 'Definitive Edition',
  '3d': '3D era (original)',
};


// --- rendering: sidebar -----------------------------------------------------


/** Rename / duplicate / delete, offered on right-click. */
function profileMenu(profile: Profile): void {
  openModal({
    title: profile.name,
    subtitle: profile.vanillaLock
      ? 'This is the vanilla-locked profile. It deploys nothing and is the safe state to play online from.'
      : `${profile.enabled.length} of ${profile.order.length} mods enabled.`,
    build: (body) => {
      // Settings that travel with this profile.
      const gfx = el('div');
      gfx.appendChild(el('div', 'field-label', 'Graphics & launch settings'));
      const summary = el('div', 'alert-body', 'Checking…');
      gfx.appendChild(summary);
      const gfxActions = el('div', 'alert-actions');
      gfx.appendChild(gfxActions);
      body.appendChild(gfx);

      void api.graphicsFor(profile.id).then((view) => {
        clear(summary);
        clear(gfxActions);

        if (!view.supported) {
          summary.textContent = 'GTArage does not track settings files for this game yet.';
          return;
        }

        summary.textContent = view.captured
          ? `Saved ${formatDate(view.capturedAt ?? '')}. These are restored whenever you apply this profile.`
          : 'Nothing saved yet. Applying this profile will leave your current settings alone; save them here to pin them to this profile.';

        for (const file of view.files) {
          const row = el('div', 'gfx-row');
          const main = el('div', 'gfx-name');
          main.appendChild(document.createTextNode(file.label));
          main.appendChild(el('div', 'gfx-path', file.path));
          row.appendChild(main);
          row.appendChild(
            el(
              'div',
              `gfx-state ${file.captured ? 'status-ok' : file.live ? 'status-off' : 'status-warn'}`,
              file.captured ? 'saved' : file.live ? 'not saved' : 'no file yet',
            ),
          );
          gfx.insertBefore(row, gfxActions);
        }

        const save = el('button', 'small-btn is-primary', 'Save current settings');
        save.addEventListener('click', async () => {
          const result = await guard('Saving settings…', () =>
            api.captureGraphics(profile.id),
          );
          if (!result) return;
          apply(result.state);
          toast(
            result.count > 0
              ? `Saved ${result.count} settings file(s) to "${profile.name}".`
              : 'No settings files found yet — launch the game once, then try again.',
            result.count > 0 ? 'ok' : 'warn',
          );
          closeModal();
        });
        gfxActions.appendChild(save);

        if (view.captured) {
          const forget = el('button', 'small-btn', 'Forget');
          forget.addEventListener('click', async () => {
            const next = await guard('Clearing…', () => api.clearGraphics(profile.id));
            if (next) apply(next);
            closeModal();
          });
          gfxActions.appendChild(forget);
        }
      });

      if (profile.vanillaLock) return;
      body.appendChild(el('div', 'field-label', 'Name'));
      const input = el('input', 'text-input');
      input.type = 'text';
      input.value = profile.name;
      input.id = 'profile-rename';
      body.appendChild(input);
    },
    actions: [
      { label: 'Close', onClick: () => true },
      {
        label: 'Duplicate',
        onClick: async () => {
          const name = `${profile.name} copy`;
          const next = await guard('Duplicating profile…', () =>
            api.createProfile(profile.gameId, name, profile.id),
          );
          if (next) apply(next);
          return true;
        },
      },
      {
        label: 'Delete',
        kind: 'danger',
        disabled: profile.vanillaLock,
        onClick: async () => {
          const ok = await confirmModal(
            `Delete "${profile.name}"?`,
            'The profile is removed. Mod files stay in the library and no game files are touched.',
            'Delete profile',
          );
          if (!ok) return true;
          const next = await guard('Deleting…', () => api.deleteProfile(profile.id));
          if (next) apply(next);
          return true;
        },
      },
      {
        label: 'Save name',
        kind: 'primary',
        disabled: profile.vanillaLock,
        onClick: async () => {
          const input = document.getElementById('profile-rename') as HTMLInputElement | null;
          if (!input) return true;
          const next = await guard('Renaming…', () =>
            api.renameProfile(profile.id, input.value),
          );
          if (next) apply(next);
          return true;
        },
      },
    ],
  });
}

// --- rendering: mods table --------------------------------------------------

function conflictMap(conflicts: Conflict[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of conflicts) {
    for (const id of c.modIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * A one-line summary of what a mod actually contains.
 *
 * `files[0]` is alphabetical, so it is usually `LICENSE.txt` — true, and
 * useless. Lead with the file that makes the mod do something.
 */
function describeFiles(mod: Mod): string {
  const interesting = mod.files.find((f) => /\.(asi|pak|dll|cs|cm|lua|oiv|rpf)$/i.test(f));
  const lead = interesting ?? mod.files[0] ?? '';
  const rest = mod.files.length - 1;
  return rest > 0 ? `${lead} +${rest} more` : lead;
}

function visibleMods(s: AppState): Mod[] {
  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  const order = profile ? profile.order : [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const conflicts = conflictMap(s.conflicts);
  const needle = search.trim().toLowerCase();

  const enabled = new Set(profile?.enabled ?? []);

  return s.mods
    .filter((m) => {
      if (needle && !`${m.name} ${m.category} ${m.kind}`.toLowerCase().includes(needle)) {
        return false;
      }
      // Switched-off mods stay in the library and stay listed by default, so
      // you can find and re-enable them; this just collapses the noise when a
      // library gets big.
      if (hideDisabled && !enabled.has(m.id)) return false;
      if (filter === 'all') return true;
      if (filter === 'conflicts') return conflicts.has(m.id);
      if (filter === 'enabled') return profile?.enabled.includes(m.id) ?? false;
      return m.category === filter;
    })
    .sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
}


function renderModsTable(s: AppState, view: HTMLElement): void {
  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  const mods = visibleMods(s);

  if (s.mods.length === 0) {
    view.appendChild(
      emptyState(
        'No mods yet',
        'Drag a mod in anywhere \u2014 a .zip, .rar or .oiv archive, a folder, or a loose file. Mods are kept in GTArage\u2019s own folder, so your game is not touched until you apply a profile.',
        'Add mod files',
        () => installMod('files'),
      ),
    );
    return;
  }

  const head = el('div', 'table-head');
  // "Kind", not "Category": this column shows what decides where the mod is
  // deployed, which is the thing worth seeing at a glance.
  for (const label of ['#', 'Mod', 'Version', 'Kind', 'Status', 'On']) {
    const cell = el('div', '', label);
    if (label === 'On') cell.style.textAlign = 'right';
    head.appendChild(cell);
  }
  view.appendChild(head);

  const conflicts = conflictMap(s.conflicts);

  // A visible target, rather than relying on people guessing that the window
  // accepts drops. Sits above the table so it is the first thing seen.
  const drop = el(
    'div',
    'dropzone dropzone-inline',
    'drop a .zip / .oiv / .rar / .asi / .pak / folder anywhere here to add it',
  );
  wireDropzone(drop);
  view.appendChild(drop);

  mods.forEach((mod, index) => {
    const on = profile?.enabled.includes(mod.id) ?? false;
    const row = el('div', `row${on ? '' : ' is-off'}`);

    row.appendChild(el('div', 'row-index', String(index + 1).padStart(2, '0')));

    // These two are ellipsised when the column is narrow, so the full value
    // has to stay reachable on hover rather than being simply lost.
    const nameCell = el('div');
    const nameEl = el('div', 'mod-name', mod.name);
    nameEl.title = mod.name;
    nameCell.appendChild(nameEl);
    const fileEl = el('div', 'mod-file', describeFiles(mod));
    fileEl.title = mod.files.join('\n');
    nameCell.appendChild(fileEl);
    row.appendChild(nameCell);

    row.appendChild(el('div', 'cell-mono', mod.version));
    row.appendChild(el('div', 'cell-mono', mod.kind));

    const conflictCount = conflicts.get(mod.id) ?? 0;
    let statusText: string;
    let statusClass: string;
    if (mod.core) {
      statusText = 'required';
      statusClass = 'status-core';
    } else if (conflictCount > 0 && on) {
      statusText = `conflict x${conflictCount}`;
      statusClass = 'status-warn';
    } else if (on) {
      statusText = 'ok';
      statusClass = 'status-ok';
    } else {
      statusText = 'disabled';
      statusClass = 'status-off';
    }
    row.appendChild(el('div', `cell-status ${statusClass}`, statusText));

    const toggle = el('button', `switch${on ? ' is-on' : ''}`);
    toggle.appendChild(el('div', 'switch-knob'));
    toggle.title = profile?.vanillaLock
      ? 'The Vanilla profile is deliberately empty \u2014 it is what keeps you safe online. Make a new profile to turn mods on.'
      : on
        ? 'Disable'
        : 'Enable';
    toggle.disabled = !profile || profile.vanillaLock;
    toggle.addEventListener('click', async () => {
      if (!profile) return;
      const next = await guard('Updating…', () => api.toggleMod(profile.id, mod.id, !on));
      if (next) apply(next);
    });
    row.appendChild(toggle);

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      modMenu(mod);
    });

    view.appendChild(row);
  });
}

/**
 * One mod: what it contains, and which of its files this setup actually uses.
 *
 * The per-file switches are the Mod Organizer 2 behaviour people leave Vortex
 * to get - drop a single file out of a mod so it loses a conflict, without
 * unpacking and repacking the archive. The planner, the API and six tests for
 * it shipped a while ago; the UI was written twice and lost twice, to a revert
 * and then to a rebuild, which left the whole feature unreachable.
 *
 * Exclusions belong to the profile, not the mod, so this needs a profile to
 * act on. With none - or on the vanilla lock, which deploys nothing - the list
 * is still worth showing, just read-only.
 */
function modMenu(mod: Mod): void {
  openModal({
    title: mod.name,
    subtitle: `${plainKind(mod.kind)} · ${mod.files.length} file${mod.files.length === 1 ? '' : 's'} · ${formatBytes(mod.size)} · added ${formatDate(mod.addedAt)}`,
    build: (body) => {
      const s = state;
      if (!s) return;
      const profile = s.profiles.find((p) => p.id === s.activeProfileId);
      const host = el('div');
      body.appendChild(host);
      fileList(s, mod, profile, host);
    },
    actions: [
      { label: 'Close', onClick: () => true },
      {
        label: 'Rename…',
        onClick: async () => {
          const name = await promptModal('Rename this mod', 'Name', mod.name);
          if (!name || name === mod.name) return true;
          const next = await guard('Renaming…', () => api.updateMod(mod.id, { name }));
          if (next) apply(next);
          return true;
        },
      },
      {
        label: 'Remove from library',
        kind: 'danger',
        onClick: async () => {
          const ok = await confirmModal(
            `Remove "${mod.name}"?`,
            'It comes out of every setup that uses it and its files are deleted from the library. Your game folder is put back first, and the archive you originally installed from is not touched. This one cannot be undone.',
            'Remove mod',
          );
          if (!ok) return true;
          const next = await guard('Removing…', () => api.removeMod(mod.id));
          if (next) {
            librarySelection = null;
            apply(next);
            toast(`${mod.name} removed from the library.`, 'ok');
          }
          return true;
        },
      },
    ],
  });
}

/**
 * The file list, with a switch per file when a setup can act on it.
 *
 * The conflict verdict beside a file is what makes this worth showing at all.
 * A bare list of paths asks the user to already know which file matters;
 * naming the mod currently winning each contested path turns it into a
 * decision they can actually make.
 */
function fileList(
  s: AppState,
  mod: Mod,
  profile: Profile | undefined,
  host: HTMLElement,
): void {
  clear(host);
  const locked = !profile || profile.vanillaLock;
  const excluded = new Set(profile?.excludedFiles?.[mod.id] ?? []);

  host.appendChild(
    el(
      'div',
      'field-help',
      locked
        ? profile?.vanillaLock
          ? 'The vanilla setup installs nothing, so there is nothing here to switch off. Open another setup to change individual files.'
          : 'Open a setup to switch individual files on or off.'
        : `Switch a file off to keep the rest of ${mod.name} but let another mod win that file. This applies to "${profile!.name}" only — your other setups keep the whole mod.`,
    ),
  );

  const nameOf = new Map(s.mods.map((m) => [m.id, m.name]));
  const list = el('div', 'files');
  // Capped: a texture pack can carry thousands of files and a dialog is not a
  // file manager.
  const shown = mod.files.slice(0, 300);

  for (const file of shown) {
    const off = excluded.has(file);
    const row = el('label', `file-row${off ? ' is-off' : ''}`);

    const box = el('input') as HTMLInputElement;
    box.type = 'checkbox';
    box.checked = !off;
    box.disabled = locked;
    box.addEventListener('change', async () => {
      if (!profile) return;
      const next = await guard('Updating…', () =>
        api.setFileExcluded({
          profileId: profile.id,
          modId: mod.id,
          file,
          excluded: !box.checked,
        }),
      );
      if (!next) return;
      apply(next);
      // Rebuild in place: switching one file off can change which mod wins
      // every other contested file in this mod, and that would otherwise be
      // invisible until the dialog was reopened.
      fileList(next, mod, next.profiles.find((p) => p.id === profile.id), host);
    });
    row.appendChild(box);
    row.appendChild(el('span', 'file-path', file));

    // Conflicts are keyed by full deploy target; matching on the tail lines
    // them up with the mod-relative paths shown here.
    const clash = s.conflicts.find(
      (c) => c.target.endsWith(file) && c.modIds.includes(mod.id),
    );
    if (clash) {
      const winner = clash.winnerId === mod.id;
      const others = clash.modIds
        .filter((id) => id !== mod.id)
        .map((id) => nameOf.get(id) ?? id);
      row.appendChild(
        el(
          'span',
          'file-note',
          winner
            ? `wins over ${others.join(', ')}`
            : `loses to ${nameOf.get(clash.winnerId) ?? 'another mod'}`,
        ),
      );
    }
    list.appendChild(row);
  }
  host.appendChild(list);

  if (mod.files.length > shown.length) {
    host.appendChild(
      el('div', 'field-help', `… and ${mod.files.length - shown.length} more files, not shown.`),
    );
  }

  if (excluded.size > 0 && profile) {
    const reset = el('button', 'btn', `Switch all ${excluded.size} back on`);
    reset.addEventListener('click', async () => {
      let next: AppState | null = null;
      for (const file of [...excluded]) {
        next = await api.setFileExcluded({
          profileId: profile.id,
          modId: mod.id,
          file,
          excluded: false,
        });
      }
      if (!next) return;
      apply(next);
      fileList(next, mod, next.profiles.find((p) => p.id === profile.id), host);
    });
    host.appendChild(reset);
  }
}

// --- shell: breadcrumb + secondary nav --------------------------------------

/**
 * The breadcrumb, which is the whole of this design's navigation state.
 *
 * Design 2a shows a dot and the app name; 2b shows "GTArage › <setup>". That
 * is the entire model - one level of drill-down - so there is no tab strip and
 * no profile rail to keep in step with it.
 */
function renderCrumbs(s: AppState): void {
  const host = byId('crumbs');
  clear(host);

  if (tab === 'home') {
    host.appendChild(el('div', 'crumb-dot'));
    host.appendChild(el('div', 'crumb is-current', 'GTArage'));
    return;
  }

  const back = el('button', 'crumb', 'GTArage');
  back.addEventListener('click', () => {
    tab = 'home';
    render();
  });
  host.appendChild(back);
  host.appendChild(el('div', 'crumb-sep', '›'));

  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  const label = tab === 'profile' ? (profile?.name ?? 'Setup') : TAB_LABELS[tab];
  host.appendChild(el('div', 'crumb is-current', label));
}

const TAB_LABELS: Record<string, string> = {
  home: 'Setups',
  library: 'Library',
  tools: 'Tools',
  settings: 'Settings',
  profile: 'Setup',
  saves: 'Backups',
  speedrun: 'Speedrun',
};

/** The screens that are not part of the drill-down: tools, not places. */
function renderTopnav(s: AppState): void {
  const host = byId('topnav');
  clear(host);

  const items: TabId[] = ['home', 'tools', 'library'];
  if (s.settings.speedrunMode) items.push('speedrun');
  items.push('saves');
  items.push('settings');

  for (const id of items) {
    const btn = el('button', tab === id ? 'is-active' : undefined, TAB_LABELS[id]);
    btn.addEventListener('click', () => {
      tab = id;
      render();
      if (id === 'speedrun') void loadSpeedrun();
    });
    host.appendChild(btn);
  }
}

function renderGamePicker(s: AppState): void {
  const select = byId<HTMLSelectElement>('game-select');
  clear(select);
  for (const game of s.games) {
    const option = el('option', undefined, game.installed ? game.shortName : `${game.shortName} — not found`);
    option.value = game.id;
    option.disabled = !game.installed;
    if (game.id === s.currentGameId) option.selected = true;
    select.appendChild(option);
  }
  select.hidden = s.games.filter((g) => g.installed).length < 2;
}

// --- notices ----------------------------------------------------------------

/**
 * The things the app worked out but had no way to say.
 *
 * Every one of these was computed on every state rebuild, tested, and then
 * displayed nowhere - a game update that silently stopped every script mod
 * from loading, a corrupt config, mods whose files had vanished, and a game
 * folder full of hand-installed mods waiting to be adopted. Building the
 * detection and never wiring the output is the same as not building it, and
 * worse, because it costs the work on every refresh.
 *
 * They share one shape deliberately: a titled card with a sentence and at
 * most two buttons. A person should be able to tell at a glance whether
 * something needs them, without learning a different pattern per warning.
 */
function renderNotices(s: AppState, host: HTMLElement): void {
  // A damaged config is first because everything else is untrustworthy until
  // it is dealt with: the app is running on defaults and the real file is
  // sitting aside, unread.
  if (s.configError) {
    host.appendChild(
      notice(
        'warn',
        'Your settings file could not be read',
        `GTArage started with default settings so it could open at all. Your original file has been kept at ${s.configError.backupPath} — nothing was overwritten. (${s.configError.message})`,
        [
          {
            label: 'Show me the file',
            onClick: () => void api.openPath('config'),
          },
        ],
      ),
    );
  }

  if (s.buildAlert) {
    const alert = s.buildAlert;
    const hit = alert.affected.length;
    const names = alert.affected.slice(0, 3).map((m) => m.name).join(', ');
    const rest = hit - Math.min(hit, 3);

    // Three genuinely different situations, and saying the wrong one is worse
    // than saying nothing. "unknown" is common: a copy adopted out of a game
    // folder is just ScriptHookV.dll, with no build named anywhere in it.
    const hook =
      alert.hook.state === 'mismatch'
        ? ` The Script Hook V you have is built for ${alert.hook.builds.join(' / ')}, so it will not load until you update it.`
        : alert.hook.state === 'match'
          ? ' Your Script Hook V already names this build, so it should still work.'
          : ' GTArage cannot tell which build your Script Hook V was made for, so it may or may not still work.';

    host.appendChild(
      notice(
        hit > 0 ? 'warn' : 'info',
        `${alert.gameName} has been updated`,
        hit === 0
          ? `It went from ${alert.previous} to ${alert.current}. Nothing you have switched on runs through Script Hook V, so this probably changes nothing for you.${hook}`
          : `It went from ${alert.previous} to ${alert.current}. Every game update moves the internals Script Hook V hooks into, so script mods stop loading until it catches up. This is not something you broke.${hook} Affected: ${names}${rest > 0 ? ` and ${rest} more` : ''}.`,
        [
          {
            label: 'Get the latest Script Hook V',
            primary: hit > 0,
            // Kept in step with SCRIPTHOOKV_URL in main/scripthook.ts; the
            // renderer has no imports, so the constant cannot be shared.
            onClick: () => void api.openExternal('http://www.dev-c.com/gtav/scripthookv/'),
          },
          {
            label: 'Got it',
            onClick: async () => {
              const next = await guard('', () => api.acknowledgeBuild(alert.gameId));
              if (next) apply(next);
            },
          },
        ],
      ),
    );
  }

  if (s.brokenMods.length > 0) {
    const first = s.brokenMods[0]!;
    host.appendChild(
      notice(
        'warn',
        s.brokenMods.length === 1
          ? `${first.name} is missing some of its files`
          : `${s.brokenMods.length} mods are missing files`,
        `Files that should be in the library are not there any more — ${first.name} is missing ${first.missing}. Something outside GTArage deleted them. Installing again is the fix; the mods will not deploy correctly as they are.`,
        [
          {
            label: 'Open Library',
            onClick: () => {
              tab = 'library';
              render();
            },
          },
        ],
      ),
    );
  }

  // Mods sitting in the game folder that GTArage did not put there. The scan
  // already ran on every refresh; until now its result was thrown away.
  const fresh = adoptable.filter((g) => !g.alreadyInLibrary);
  if (fresh.length > 0) {
    const bytes = fresh.reduce((n, g) => n + g.bytes, 0);
    host.appendChild(
      notice(
        'info',
        `${fresh.length} mod${fresh.length === 1 ? '' : 's'} already in your game folder`,
        `${fresh.map((g) => g.name).slice(0, 4).join(', ')}${fresh.length > 4 ? ` and ${fresh.length - 4} more` : ''} — ${formatBytes(bytes)} installed by hand rather than by GTArage. Taking them in moves them to the library so setups can switch them on and off. Nothing is deleted.`,
        [
          {
            label: `Take ${fresh.length === 1 ? 'it' : 'them'} in`,
            primary: true,
            onClick: () => void adoptAll(fresh),
          },
        ],
      ),
    );
  }
}

/**
 * Add-on packs and memory limits, shown inside a setup.
 *
 * Separate from renderNotices because it is about what this setup installs,
 * not about the game or the app - so it belongs beside the switches that
 * caused it rather than on the home screen.
 */
function renderDlcNotices(s: AppState, host: HTMLElement): void {
  const dlc = s.dlc;
  if (!dlc) return;

  if (dlc.gaps.length > 0) {
    const first = dlc.gaps[0]!;
    host.appendChild(
      notice(
        'warn',
        dlc.gaps.length === 1
          ? `${first.modName} needs a line in dlclist.xml`
          : `${dlc.gaps.length} add-on packs need a line in dlclist.xml`,
        // The wording turns on `confirmed`. When no dlclist could be read we
        // genuinely do not know whether the line is already there, and saying
        // "missing" would be a lie to anyone who added it by hand.
        `${
          dlc.confirmed
            ? 'This line is not in your dlclist.xml'
            : 'GTArage cannot read your dlclist.xml, because it lives inside update.rpf'
        }. Without the entry the pack installs perfectly and the game ignores it completely. Add it with OpenIV or CodeWalker: ${first.line}`,
        dlc.gaps.length > 1
          ? [
              {
                label: `Show all ${dlc.gaps.length} lines`,
                onClick: () =>
                  openModal({
                    title: 'Lines to add to dlclist.xml',
                    subtitle:
                      'Paste these inside the <Paths> block, then save the file back into update.rpf.',
                    build: (body) => {
                      for (const gap of dlc.gaps) {
                        const row = el('div', 'mono-list', gap.line);
                        row.title = gap.modName;
                        body.appendChild(row);
                      }
                    },
                    actions: [{ label: 'Close', onClick: () => true }],
                  }),
              },
            ]
          : [],
      ),
    );
  }

  if (dlc.needsGameconfig) {
    host.appendChild(
      notice(
        'info',
        'A collection this size needs a bigger gameconfig',
        `You have ${dlc.packCount} add-on packs switched on. Past roughly this many, the game runs out of the fixed memory it sets aside for vehicles and props and crashes while loading, with nothing on screen to say that is the reason. A replacement gameconfig.xml raises those limits.`,
        [],
      ),
    );
  }
}

/** One titled card. Shared by every notice so they all read the same way. */
function notice(
  tone: 'warn' | 'info',
  title: string,
  body: string,
  actions: Array<{ label: string; onClick: () => void; primary?: boolean }> = [],
): HTMLElement {
  const node = el('div', `notice notice-${tone}`);
  node.appendChild(el('div', 'notice-title', title));
  node.appendChild(el('div', 'notice-body', body));
  if (actions.length > 0) {
    const row = el('div', 'notice-acts');
    for (const action of actions) {
      const btn = el('button', `btn${action.primary ? ' is-primary' : ''}`, action.label);
      btn.addEventListener('click', action.onClick);
      row.appendChild(btn);
    }
    node.appendChild(row);
  }
  return node;
}

/** Take every hand-installed mod into the library, one at a time. */
async function adoptAll(groups: AdoptGroupView[]): Promise<void> {
  const s = state;
  if (!s?.currentGameId) return;
  let taken = 0;
  let last: AppState | null = null;
  for (const group of groups) {
    try {
      const result = await guard(`Taking in ${group.name}…`, () =>
        api.adopt(s.currentGameId!, group.id),
      );
      if (result) {
        last = result.state;
        taken += 1;
      }
    } catch (err) {
      toast(`${group.name}: ${(err as Error).message}`, 'error');
    }
  }
  if (last) apply(last);
  // Re-scan, or the notice keeps offering mods that are now in the library.
  adoptable = await api.scanAdoptable(s.currentGameId).catch(() => []);
  render();
  if (taken > 0) toast(`Took in ${taken} mod${taken === 1 ? '' : 's'}.`, 'ok');
}

// --- 2a: which setup do you want to play? -----------------------------------

/**
 * The home screen, design 2a.
 *
 * The question at the top is the whole thesis of this direction. Nearly every
 * session is "play the thing I already set up", not "manage my library", so
 * the app opens by asking the only question that matters and puts one obvious
 * button on each answer.
 */
function renderHome(s: AppState, view: HTMLElement): void {
  const current = s.games.find((g) => g.id === s.currentGameId);
  if (!current?.installed && tab !== 'settings') {
    renderSetup(s, view);
    return;
  }

  const home = el('div', 'home');

  // Anything the app worked out that the user needs to know before choosing
  // a setup: a game update, a damaged config, mods it can take in.
  const notices = el('div', 'notices');
  renderNotices(s, notices);
  home.appendChild(notices);

  const head = el('div', 'home-head');
  // Which game these setups belong to. Without it the question is ambiguous
  // the moment someone has both Legacy and Enhanced installed.
  head.appendChild(el('div', 'home-game', current?.name ?? ''));
  head.appendChild(el('h1', 'ask', 'Which setup do you want to play?'));
  head.appendChild(
    el(
      'p',
      'lede',
      'Pick a setup and press Play. GTArage swaps the mods and your save files for you, and keeps a backup of everything it touches.',
    ),
  );
  home.appendChild(head);

  const grid = el('div', 'setups');
  for (const profile of s.profiles) grid.appendChild(setupCard(s, profile));
  home.appendChild(grid);

  const foot = el('div', 'home-foot');
  foot.appendChild(backupCard(s));

  const add = el('button', 'note-card is-dashed');
  add.appendChild(el('div', 'note-icon', '+'));
  const addMain = el('div', 'note-main');
  addMain.appendChild(el('div', 'note-title', 'Make a new setup'));
  addMain.appendChild(el('div', 'note-body', 'Start empty, or copy one you already have'));
  add.appendChild(addMain);
  add.addEventListener('click', () => newProfile());
  foot.appendChild(add);

  home.appendChild(foot);
  view.appendChild(home);
}

function setupCard(s: AppState, profile: Profile): HTMLElement {
  const live = s.deployed?.profileId === profile.id;
  const card = el('div', `setup${live ? ' is-live' : ''}`);

  const head = el('div', 'setup-head');
  head.appendChild(
    el('div', `setup-chip${live ? ' is-live' : profile.vanillaLock ? ' is-safe' : ''}`),
  );
  head.appendChild(el('div', 'setup-name', profile.name));
  if (live) head.appendChild(el('div', 'setup-tag is-good', 'IN USE'));
  else if (profile.vanillaLock) head.appendChild(el('div', 'setup-tag is-good', 'SAFE'));

  // Rename, duplicate and delete live here. The rebuild dropped the profile
  // rail that used to hold them, which left no way to remove a setup at all.
  const more = el('button', 'more-btn', '⋯');
  more.title = `More actions for ${profile.name}`;
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    profileMenu(profile);
  });
  head.appendChild(more);
  card.appendChild(head);
  card.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    profileMenu(profile);
  });

  card.appendChild(el('div', 'setup-blurb', blurbFor(s, profile)));

  const enabled = profile.vanillaLock ? [] : s.mods.filter((m) => profile.enabled.includes(m.id));
  const bytes = enabled.reduce((sum, m) => sum + m.size, 0);

  const facts = el('div', 'setup-facts');
  facts.appendChild(fact('Mods', enabled.length === 0 ? 'None' : `${enabled.length} on`));
  facts.appendChild(fact('Size on disk', enabled.length === 0 ? '—' : formatBytes(bytes)));
  facts.appendChild(
    fact('Last played', profile.lastLaunchedAt ? formatDate(profile.lastLaunchedAt) : 'Never'),
  );
  card.appendChild(facts);

  card.appendChild(el('div', 'setup-grow'));

  // The card body is a second way in, alongside the explicit button. The
  // handler ignores clicks that land on a button so the two never fight.
  if (!profile.vanillaLock) {
    card.tabIndex = 0;
    card.title = `Open ${profile.name}`;
  }
  const enter = (event: Event) => {
    if (profile.vanillaLock) return;
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    void openProfile(profile);
  };
  card.addEventListener('click', enter);
  card.addEventListener('keydown', (event) => {
    if (profile.vanillaLock) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void openProfile(profile);
    }
  });

  if (!profile.vanillaLock) {
    const open = el('button', 'btn btn-wide', 'Open this setup');
    open.addEventListener('click', () => void openProfile(profile));
    card.appendChild(open);
  }

  /*
   * Three states, not two.
   *
   * "Play now" used to mean "this setup is the one installed", which is not
   * the same as "the game is open" — so pressing it and watching it stay on
   * Play now read as nothing having happened. Running is its own state, and
   * starting a second copy is a separate, explicitly labelled button rather
   * than the same button pressed twice.
   */
  if (live && gameRunning) {
    const running = el('button', 'btn btn-wide is-running', 'Running');
    running.disabled = true;
    running.title = 'The game is open with this setup installed';
    card.appendChild(running);

    const again = el('button', 'btn btn-wide', 'Launch another instance');
    again.title =
      'Start a second copy. Both share the same save files and mod folder.';
    again.addEventListener('click', () => void startGame(profile.gameId));
    card.appendChild(again);
  } else {
    // Switching and playing are two presses, not one. The old combined
    // button started the game as a side effect of choosing a setup, which
    // gave no moment to look at what had changed before the game opened.
    const play = el(
      'button',
      `btn btn-wide ${live ? 'is-blue' : 'is-switch'}`,
      live ? 'Play now' : `Switch to ${profile.name}`,
    );
    if (!live) play.title = `Install this setup's mods. The game does not start yet.`;
    play.addEventListener('click', () =>
      void (live ? switchAndPlay(profile) : switchTo(profile)),
    );
    card.appendChild(play);
  }

  return card;
}

function fact(label: string, value: string): HTMLElement {
  const row = el('div', 'setup-fact');
  row.appendChild(el('span', undefined, label));
  row.appendChild(el('b', undefined, value));
  return row;
}

/** A setup described the way someone would describe it out loud. */
function blurbFor(s: AppState, profile: Profile): string {
  if (profile.vanillaLock) {
    return 'No mods at all. Use this before going online so you do not get banned.';
  }
  const on = s.mods.filter((m) => profile.enabled.includes(m.id) && !m.core);
  if (on.length === 0) return 'Nothing switched on yet. Open it to add some mods.';
  const named = on.slice(0, 3).map((m) => m.name);
  const rest = on.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${rest} more.` : `${named.join(', ')}.`;
}

function backupCard(s: AppState): HTMLElement {
  const card = el('div', 'note-card');
  const ok = s.settings.backupSavesOnSwap;
  card.appendChild(el('div', `note-icon${ok ? ' is-good' : ''}`, ok ? '✓' : '!'));
  const main = el('div', 'note-main');
  main.appendChild(
    el('div', 'note-title', ok ? 'Everything is backed up' : 'Save backups are switched off'),
  );
  const newest = saves[0];
  main.appendChild(
    el(
      'div',
      'note-body',
      ok
        ? newest
          ? `Last backup ${formatDate(newest.createdAt)} · ${saves.length} restore point${saves.length === 1 ? '' : 's'} kept`
          : 'No snapshots yet — one is taken before your first switch'
        : 'Your saves are not copied before a switch. Turn this back on in Settings.',
    ),
  );
  card.appendChild(main);
  const view = el('button', 'btn', 'View backups');
  view.addEventListener('click', () => {
    tab = 'saves';
    render();
  });
  card.appendChild(view);
  return card;
}

// --- 2b: inside a setup ------------------------------------------------------

/**
 * One setup's contents, design 2b.
 *
 * The list is on/off switches with a plain-language sentence under each name,
 * and the panel on the right holds the single action plus the reassurances
 * about what a switch actually does to your files. Load order, conflicts and
 * deploy mechanics are still there, but they are stated in words rather than
 * shown as a table to be interpreted.
 */
function renderProfile(s: AppState, view: HTMLElement): void {
  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  if (!profile) {
    view.appendChild(emptyState('No setup selected', 'Go back and pick one.'));
    return;
  }

  const wrap = el('div', 'inside');

  const main = el('div', 'inside-main');
  const head = el('div');
  head.appendChild(el('div', 'inside-title', "What's in this setup"));
  head.appendChild(
    el(
      'div',
      'inside-lede',
      profile.vanillaLock
        ? 'This setup deliberately installs nothing. That is what makes it safe to play online from, so it cannot be changed.'
        : 'Turn things on or off. Nothing changes in your game until you press Play.',
    ),
  );
  main.appendChild(head);

  // Re-check the game folder. People delete mod files by hand and the app
  // went on insisting they were installed.
  const rescan = el('button', 'btn', 'Re-check my game folder');
  rescan.title =
    'Look at the game folder again and forget anything that is no longer there';
  rescan.addEventListener('click', async () => {
    if (!s.currentGameId) return;
    const report = await guard('Checking the game folder…', () =>
      api.rescan(s.currentGameId!),
    );
    if (!report) return;
    const next = await api.getState();
    apply(next);
    if (report.dropped === 0 && report.orphans === 0) {
      toast('Everything matches — nothing has been touched by hand.', 'ok');
    } else {
      const bits: string[] = [];
      if (report.dropped > 0) {
        bits.push(`forgot ${report.dropped} file(s) no longer in the game folder`);
      }
      if (report.restored > 0) {
        bits.push(`put back ${report.restored} original game file(s)`);
      }
      if (report.orphans > 0) {
        bits.push(`found ${report.orphans} file(s) GTArage did not install`);
      }
      toast(bits.join(' · '), 'warn');
    }
  });
  const install = el('button', 'btn is-primary', 'Install a mod');
  install.title = 'Add a .zip, .rar, .oiv, a loose file, or a folder';
  install.addEventListener('click', () => installMod('files'));
  head.appendChild(install);

  const installFolder = el('button', 'btn', 'Add a folder');
  installFolder.addEventListener('click', () => installMod('folder'));
  head.appendChild(installFolder);

  head.appendChild(rescan);

  // About what this setup installs, so it sits beside the switches that
  // caused it rather than on the home screen.
  const dlcNotices = el('div', 'notices');
  renderDlcNotices(s, dlcNotices);
  main.appendChild(dlcNotices);

  main.appendChild(renderPills(s, profile));

  const mods = thingsFor(s, profile);
  if (mods.length === 0) {
    main.appendChild(
      emptyState(
        profile.vanillaLock ? 'Nothing here, on purpose' : 'Nothing in this setup yet',
        profile.vanillaLock
          ? 'The vanilla setup is empty by design.'
          : 'Drag a mod in anywhere, or add mod files below.',
        profile.vanillaLock ? undefined : 'Add mod files',
        profile.vanillaLock ? undefined : () => installMod('files'),
      ),
    );
  } else {
    main.appendChild(renderThings(s, profile, mods));
  }
  wrap.appendChild(main);

  wrap.appendChild(readyPanel(s, profile));
  view.appendChild(wrap);
}

/**
 * The plain-language filters.
 *
 * These are the categories a player recognises, not the kinds the deploy
 * engine sorts by. "Needed to run mods" is a real thing someone can reason
 * about; "asi" is not.
 */
const PLAIN_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'Everything' },
  // The split people actually care about is 'things I chose' versus 'things
  // that have to be there', not which deploy root a file lands in.
  { id: 'installed', label: 'Installed' },
  { id: 'core', label: 'Required' },
];

function renderPills(s: AppState, profile: Profile): HTMLElement {
  const row = el('div', 'pills');
  for (const group of PLAIN_GROUPS) {
    const count = group.id === 'all' ? undefined : thingsFor(s, profile, group.id).length;
    if (count === 0) continue;
    const pill = el('button', `pill${filter === group.id ? ' is-active' : ''}`, group.label);
    pill.addEventListener('click', () => {
      filter = group.id;
      render();
    });
    row.appendChild(pill);
  }
  return row;
}

function thingsFor(s: AppState, profile: Profile, which = filter): Mod[] {
  const inProfile = profile.order
    .map((id) => s.mods.find((m) => m.id === id))
    .filter((m): m is Mod => m !== undefined);
  if (which === 'core') return inProfile.filter((m) => m.core);
  if (which === 'installed') return inProfile.filter((m) => !m.core);
  return inProfile;
}

/**
 * The mod list, with load order folded in.
 *
 * There used to be a separate "Load order" screen holding exactly this same
 * information as a drag list. Splitting it out asked people to keep two
 * screens in their head - which mods are on, and what order they load in -
 * when both questions are answered by the same list of rows. Dragging a row
 * here does the same thing the old screen's stack did: it moves the mod
 * within `profile.order`, and later still wins a shared file.
 *
 * Reordering only makes sense against the whole profile, and only the
 * "Everything" pill shows every mod in that real order - "Installed" and
 * "Required" are subsets, so a row's position in a filtered list does not
 * correspond to a real index to drop it at. Dragging is switched off outside
 * "Everything" rather than silently computing the wrong index.
 */
function renderThings(s: AppState, profile: Profile, mods: Mod[]): HTMLElement {
  const list = el('div', 'things');
  const draggable = filter === 'all' && !profile.vanillaLock && mods.length > 1;

  if (draggable) {
    list.appendChild(
      el(
        'div',
        'things-hint',
        'Drag the grip to reorder. When two mods change the same file, the one lower in this list wins.',
      ),
    );
  }

  // Shared by every row drawn in this pass, so a drop handler on row B can
  // see what row A's dragstart put down.
  const dragState: { id: string | null } = { id: null };
  mods.forEach((mod, index) => {
    list.appendChild(thingRow(s, profile, mod, draggable ? { index, dragState } : null));
  });
  return list;
}

function thingRow(
  s: AppState,
  profile: Profile,
  mod: Mod,
  drag: { index: number; dragState: { id: string | null } } | null,
): HTMLElement {
  const on = profile.enabled.includes(mod.id);
  const conflicts = conflictMap(s.conflicts).get(mod.id) ?? 0;
  const row = el('div', 'thing');

  if (drag) {
    row.classList.add('is-draggable');

    const grip = el('div', 'thing-grip');
    grip.appendChild(el('span'));
    grip.appendChild(el('span'));
    grip.appendChild(el('span'));
    grip.title = `Drag to move ${mod.name}`;
    row.appendChild(grip);

    /*
     * Only a drag that starts on the grip counts, so pressing the switch or
     * the "⋯" button never yanks the row instead of activating it.
     *
     * Gating that on `dragstart`'s target does not work, and looked like it
     * did: on `dragstart` the target is the element carrying `draggable`,
     * which is the row, never the grip - so the check failed every time and
     * cancelled every drag. Arming `draggable` on mousedown over the grip is
     * what actually distinguishes them, because mousedown does report the
     * element under the cursor.
     */
    row.draggable = false;
    grip.addEventListener('mousedown', () => {
      row.draggable = true;
    });
    row.addEventListener('mouseup', () => {
      row.draggable = false;
    });

    row.addEventListener('dragstart', (event) => {
      drag.dragState.id = mod.id;
      row.classList.add('is-dragging');
      // Firefox refuses to start a drag unless the payload is set.
      event.dataTransfer?.setData('text/plain', mod.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      drag.dragState.id = null;
      row.draggable = false;
      row.classList.remove('is-dragging');
    });
    row.addEventListener('dragover', (event) => {
      if (!drag.dragState.id) return;
      event.preventDefault();
      row.classList.add('is-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-over'));
    row.addEventListener('drop', async (event) => {
      event.preventDefault();
      row.classList.remove('is-over');
      const draggedId = drag.dragState.id;
      if (!draggedId || draggedId === mod.id) return;
      const next = await guard('Reordering…', () => api.moveMod(profile.id, draggedId, drag.index));
      if (next) apply(next);
    });
  }

  row.appendChild(el('div', 'thing-icon'));

  const main = el('div', 'thing-main');
  const head = el('div', 'thing-head');
  head.appendChild(el('div', 'thing-name', mod.name));

  // One badge, in words. The conflict badge wins when there is one, because
  // that is the only state that needs a decision.
  if (conflicts > 0 && on) {
    head.appendChild(el('div', 'thing-badge is-warn', 'conflict'));
  } else if (mod.core) {
    head.appendChild(el('div', 'thing-badge', 'required'));
  } else {
    head.appendChild(el('div', 'thing-badge', plainKind(mod.kind)));
  }
  main.appendChild(head);
  main.appendChild(el('div', 'thing-blurb', plainBlurb(s, profile, mod, on, conflicts)));
  row.appendChild(main);

  const more = el('button', 'more-btn', '⋯');
  more.title = `More actions for ${mod.name}`;
  more.addEventListener('click', () => modMenu(mod));
  row.appendChild(more);
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    modMenu(mod);
  });

  const sw = el('button', `sw${on ? ' is-on' : ''}`);
  sw.appendChild(el('div', 'sw-knob'));
  sw.disabled = profile.vanillaLock;
  sw.title = profile.vanillaLock
    ? 'The vanilla setup is deliberately empty'
    : on
      ? `Switch ${mod.name} off`
      : `Switch ${mod.name} on`;
  sw.addEventListener('click', async () => {
    const next = await guard('Updating…', () => api.toggleMod(profile.id, mod.id, !on));
    if (next) apply(next);
  });
  row.appendChild(sw);
  return row;
}

/** Mod kinds, said the way a player would say them. */
function plainKind(kind: string): string {
  switch (kind) {
    case 'graphics':
      return 'how it looks';
    case 'asi':
    case 'script':
    case 'cleo':
      return 'how it plays';
    case 'replace':
    case 'oiv':
      return 'game files';
    case 'modloader':
      return 'required';
    default:
      return kind;
  }
}

/**
 * A sentence about what this mod is doing right now.
 *
 * The conflict case is the one that earns its place: rather than "conflict
 * x1", it names the mod that is winning and why, which is the difference
 * between a status and an explanation.
 */
function plainBlurb(
  s: AppState,
  profile: Profile,
  mod: Mod,
  on: boolean,
  conflicts: number,
): string {
  if (conflicts > 0 && on) {
    const clash = s.conflicts.find((c) => c.modIds.includes(mod.id));
    const winner = clash ? s.mods.find((m) => m.id === clash.winnerId) : undefined;
    if (winner && winner.id !== mod.id) {
      return `Changes the same file as ${winner.name}, which is winning it. Move this one later in the load order to flip that.`;
    }
    if (winner) {
      const others = (clash?.modIds ?? [])
        .filter((id) => id !== mod.id)
        .map((id) => s.mods.find((m) => m.id === id)?.name)
        .filter(Boolean);
      return `Wins a file that ${others.join(' and ')} also changes.`;
    }
  }
  if (mod.core) return 'One of the pieces that lets any of this run. Leave it on.';
  if (!on) return 'Switched off, so none of its files go into your game.';
  return `${mod.files.length} file${mod.files.length === 1 ? '' : 's'} · ${formatBytes(mod.size)}`;
}

/**
 * The swap summary, kept in step with the switches.
 *
 * The app tells people "nothing changes in your game until you press Play",
 * which is true — toggling only edits the profile. But until this existed the
 * app could only *assert* that restraint, never show it: pressing Play simply
 * did the work, and the only preview was a dialog shown after the decision had
 * already been made, which is a nag rather than information.
 *
 * So this sits in the panel permanently and updates as switches move. Seeing
 * the number change while you are still deciding is strictly more useful than
 * a confirmation afterwards, and it is the one safety claim in the app that
 * was otherwise unevidenced.
 */
let swapSummary: SwapPlan | null = null;
let swapSummaryKey = '';

/** What the plan depends on. Anything else changing cannot alter the answer. */
function swapKey(profile: Profile): string {
  return [
    profile.id,
    profile.order.join(','),
    profile.enabled.join(','),
    JSON.stringify(profile.excludedFiles ?? {}),
  ].join('|');
}

async function refreshSwapSummary(profile: Profile, host: HTMLElement): Promise<void> {
  const key = swapKey(profile);
  if (key === swapSummaryKey && swapSummary) {
    paintSwapSummary(host, swapSummary);
    return;
  }
  try {
    const plan = await api.planSwap(profile.id);
    swapSummaryKey = key;
    swapSummary = plan;
    // The panel may have been rebuilt or the tab changed while this was in
    // flight; painting into a detached node would be invisible and confusing
    // to debug later.
    if (host.isConnected) paintSwapSummary(host, plan);
  } catch {
    // A plan that cannot be built is not worth interrupting for. Apply reports
    // the same problem properly, with the context to act on it.
  }
}

function paintSwapSummary(host: HTMLElement, plan: SwapPlan): void {
  clear(host);
  const moving = plan.filesIn + plan.filesOut;

  if (moving === 0) {
    host.appendChild(
      el('div', 'swapline-main', 'Nothing to move — this setup is already in your game folder.'),
    );
    return;
  }

  const line = el('div', 'swapline-main');
  const part = (n: number, label: string, tone: string) => {
    const chunk = el('span', `swapline-part ${tone}`);
    chunk.appendChild(el('b', undefined, String(n)));
    chunk.appendChild(document.createTextNode(` ${label}`));
    line.appendChild(chunk);
  };
  part(plan.filesIn, 'in', 'is-in');
  part(plan.filesOut, 'out', 'is-out');
  part(plan.filesKept, 'left alone', 'is-keep');
  host.appendChild(line);

  const notes: string[] = [];
  if (plan.bytesToWrite > 0) notes.push(`about ${formatBytes(plan.bytesToWrite)} written`);
  notes.push('anything replaced is shelved, not deleted');
  host.appendChild(el('div', 'swapline-note', notes.join(' · ')));

  // Blockers are the one thing worth colouring: they stop Apply outright.
  for (const blocker of plan.blockers) {
    host.appendChild(el('div', 'swapline-blocker', blocker));
  }
}

function readyPanel(s: AppState, profile: Profile): HTMLElement {
  const panel = el('div', 'ready');

  const on = profile.vanillaLock ? 0 : profile.enabled.length;
  const off = Math.max(0, profile.order.length - on);

  const head = el('div');
  head.appendChild(el('div', 'ready-title', 'Ready to play'));
  head.appendChild(
    el(
      'div',
      'ready-sub',
      profile.vanillaLock
        ? 'This setup puts your game back to completely unmodded.'
        : `${on} thing${on === 1 ? '' : 's'} on, ${off} off · ${formatBytes(s.activeBytes)}.`,
    ),
  );
  panel.appendChild(head);

  // Sits under the count it explains: 'x on, y off' is the decision, this is
  // what that decision does to the game folder.
  if (!profile.vanillaLock || s.deployed) {
    const swapline = el('div', 'swapline');
    swapline.appendChild(el('div', 'swapline-main', 'Working out what moves…'));
    panel.appendChild(swapline);
    void refreshSwapSummary(profile, swapline);
  }

  // The one conflict worth surfacing, phrased as a decision rather than an
  // error. Design 2b puts exactly one of these here, not a list.
  const clash = s.conflicts[0];
  if (clash) {
    const winner = s.mods.find((m) => m.id === clash.winnerId);
    const loser = s.mods.find((m) => m.id === clash.modIds.find((id) => id !== clash.winnerId));
    if (winner && loser) {
      const notice = el('div', 'notice');
      notice.appendChild(el('div', 'notice-title', 'Two mods want the same file'));
      const body = el('div', 'notice-body');
      body.appendChild(document.createTextNode('Only one can change it. We have kept '));
      body.appendChild(el('b', undefined, winner.name));
      body.appendChild(
        document.createTextNode(
          ` on, because it is later in the load order. ${
            s.conflicts.length > 1 ? `${s.conflicts.length - 1} other file(s) are contested too.` : ''
          }`,
        ),
      );
      notice.appendChild(body);
      const acts = el('div', 'notice-acts');
      const fine = el('button', 'btn is-primary', 'Sounds good');
      fine.addEventListener('click', () => toast('Left as it is.', 'ok'));
      acts.appendChild(fine);
      const flip = el('button', 'btn', `Use ${loser.name}`);
      flip.addEventListener('click', async () => {
        const next = await guard('Reordering…', () =>
          api.moveMod(profile.id, loser.id, profile.order.length - 1),
        );
        if (next) apply(next);
      });
      acts.appendChild(flip);
      notice.appendChild(acts);
      panel.appendChild(notice);
    }
  }

  panel.appendChild(el('div', 'ready-grow'));

  const live = s.deployed?.profileId === profile.id;
  if (live && gameRunning) {
    const running = el('button', 'play is-running', 'Running');
    running.disabled = true;
    panel.appendChild(running);
    const again = el('button', 'btn', 'Launch another instance');
    again.title = 'Start a second copy. Both share the same saves and mod folder.';
    again.addEventListener('click', () => void startGame(profile.gameId));
    panel.appendChild(again);
  } else {
    const play = el('button', 'play', live ? 'Play with this setup' : 'Apply and play');
    play.addEventListener('click', () => void applyProfile(true));
    panel.appendChild(play);
  }

  const alt = el('div', 'play-alt');
  alt.appendChild(document.createTextNode('or '));
  const save = el('button', undefined, 'save without playing');
  save.addEventListener('click', () => void applyProfile(false));
  alt.appendChild(save);
  panel.appendChild(alt);

  return panel;
}

/** Make a setup current and drill into it. */
async function openProfile(profile: Profile): Promise<void> {
  if (state?.activeProfileId !== profile.id) {
    const next = await guard('Opening…', () =>
      api.setActiveProfile(profile.gameId, profile.id),
    );
    if (!next) return;
    apply(next);
  }
  filter = 'all';
  tab = 'profile';
  render();
}

/**
 * Switch to a setup and play it.
 *
 * Routed through the same apply path as the button inside the setup, rather
 * than a shortcut of its own: the preview, the blockers and the online check
 * all still have to happen. This is a faster route to the same decision, not
 * a way around it.
 */
/**
 * Make a setup the installed one, and stop there.
 *
 * The button then becomes Play now, because `live` is true once this
 * finishes -- which is the point: you get to see what was swapped before
 * anything launches.
 */
async function switchTo(profile: Profile): Promise<void> {
  if (state?.activeProfileId !== profile.id) {
    const next = await guard('Switching setup…', () =>
      api.setActiveProfile(profile.gameId, profile.id),
    );
    if (!next) return;
    apply(next);
  }
  await applyProfile(false);
}

async function switchAndPlay(profile: Profile): Promise<void> {
  if (state?.activeProfileId !== profile.id) {
    const next = await guard('Switching setup…', () =>
      api.setActiveProfile(profile.gameId, profile.id),
    );
    if (!next) return;
    apply(next);
  }
  await applyProfile(true);
}

// --- Settings ---------------------------------------------------------------

/**
 * Settings, rebuilt from the mockup.
 *
 * The organising idea is in the design's own title: weight made visible. The
 * three settings that prevent a lost save or a ban are grouped first, marked
 * recommended, and explained in terms of what goes wrong without them. The
 * cosmetic ones come after and look like preferences, because they are.
 */
/**
 * The BattlEye toggle for GTA V Enhanced.
 *
 * Reads its own state rather than taking it from AppState: it lives in
 * Steam's config, not ours, and the user can change it in Steam behind our
 * back. Rendered disabled until that read comes back, so it can never show
 * "Disable" for something already disabled.
 */
function battlEyeButton(): HTMLElement {
  const btn = el('button', 'btn', 'Checking BattlEye…');
  btn.disabled = true;

  const paint = (view: BattlEyeView): void => {
    if (!view.known) {
      btn.textContent = 'BattlEye: unknown';
      btn.title =
        'GTArage could not find a Steam account file to read, so it cannot tell whether BattlEye is off. Set -nobattleye in your launcher yourself.';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    btn.textContent = view.enabled ? 'Turn BattlEye back on' : 'Disable BattlEye';
    btn.title = view.enabled
      ? 'Remove -nobattleye from this game’s Steam launch options.'
      : 'Add -nobattleye to this game’s Steam launch options so script mods can load. Story mode only — never go online with mods.';
    btn.classList.toggle('is-on', view.enabled);
  };

  const load = (): void => {
    void api
      .battlEyeState()
      .then(paint)
      .catch(() => {
        btn.textContent = 'BattlEye: unknown';
        btn.disabled = true;
      });
  };

  btn.addEventListener('click', async () => {
    const view = await api.battlEyeState().catch(() => null);
    if (!view) return;
    const turningOff = !view.enabled;

    if (turningOff) {
      const ok = await confirmModal(
        'Disable BattlEye for GTA V Enhanced?',
        'This adds -nobattleye to the game’s Steam launch options, which is what lets script mods load at all. It is for story mode. Going online with mods loaded — with or without BattlEye — is what gets accounts banned, so keep using the vanilla setup before you go online. Steam has to be closed: it rewrites its own settings when it exits, and would undo this.',
        'Disable it',
      );
      if (!ok) return;
    }

    btn.disabled = true;
    try {
      const result = await api.setBattlEye(turningOff);
      apply(result.state);
      toast(result.message, turningOff ? 'warn' : 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      load();
    }
  });

  load();
  return btn;
}

function renderSettings(s: AppState, view: HTMLElement): void {
  const sheet = el('div', 'sheet');

  const groups = el('div', 'groups');
  const sections: Array<[string, string]> = [];

  const section = (
    id: string,
    title: string,
    opts: { badge?: string; note?: string; blurb?: string } = {},
  ): HTMLElement => {
    const g = el('div', 'group');
    g.id = id;
    sections.push([id, title]);
    const head = el('div', 'group-head');
    head.appendChild(el('div', 'group-title', title));
    if (opts.badge) head.appendChild(el('div', 'group-badge', opts.badge));
    if (opts.note) head.appendChild(el('div', 'group-note', opts.note));
    g.appendChild(head);
    if (opts.blurb) g.appendChild(el('div', 'group-blurb', opts.blurb));
    groups.appendChild(g);
    return g;
  };

  const set = (patch: Partial<AppState['settings']>) => async () => {
    const next = await guard('Saving…', () => api.updateSettings(patch));
    if (next) apply(next);
  };

  const toggleRow = (
    host: HTMLElement,
    name: string,
    desc: string,
    on: boolean,
    onChange: () => void,
    tag?: string,
  ): HTMLElement => {
    const row = el('div', 'srow');
    const main = el('div', 'srow-main');
    const nameEl = el('div', 'srow-name');
    nameEl.appendChild(document.createTextNode(name));
    if (tag) nameEl.appendChild(el('span', 'srow-tag', tag));
    main.appendChild(nameEl);
    main.appendChild(el('div', 'srow-desc', desc));
    row.appendChild(main);
    const sw = el('button', `sw${on ? ' is-on' : ''}`);
    sw.appendChild(el('div', 'sw-knob'));
    sw.addEventListener('click', onChange);
    row.appendChild(sw);
    host.appendChild(row);
    return row;
  };

  // --- safety ---------------------------------------------------------------
  const safety = section('s-safety', 'Keeping your saves safe', {
    badge: 'RECOMMENDED ON',
    note: 'These three prevent a lost save or a ban',
  });
  const safetyRows = el('div', 'rows');

  const backupRow = toggleRow(
    safetyRows,
    'Copy my saves before every switch',
    'A snapshot is taken before anything moves, so a bad switch can be undone.',
    s.settings.backupSavesOnSwap,
    set({ backupSavesOnSwap: !s.settings.backupSavesOnSwap }),
  );
  // The keep-count sits with the setting it belongs to rather than in a list
  // of numbers elsewhere.
  const stepper = el('div', 'stepper');
  const dec = el('button', undefined, '–');
  dec.title = 'Keep fewer snapshots';
  dec.addEventListener('click', (e) => {
    e.stopPropagation();
    void set({ saveBackupLimit: Math.max(1, s.settings.saveBackupLimit - 1) })();
  });
  const count = el('span', undefined, String(s.settings.saveBackupLimit));
  const inc = el('button', undefined, '+');
  inc.title = 'Keep more snapshots';
  inc.addEventListener('click', (e) => {
    e.stopPropagation();
    void set({ saveBackupLimit: Math.min(99, s.settings.saveBackupLimit + 1) })();
  });
  stepper.append(dec, count, inc);
  backupRow.insertBefore(stepper, backupRow.lastElementChild);

  toggleRow(
    safetyRows,
    'Do not touch the game folder while the game is running',
    'Half-applied mods are the most common cause of a broken install.',
    s.settings.blockWhileGameRunning,
    set({ blockWhileGameRunning: !s.settings.blockWhileGameRunning }),
  );

  const online = s.games.filter((g) => g.hasOnline && g.installed).map((g) => g.shortName);
  toggleRow(
    safetyRows,
    'Warn me before modding a game that has an online mode',
    'Taking a modded game online can get the account banned.',
    s.settings.warnAboutOnline,
    set({ warnAboutOnline: !s.settings.warnAboutOnline }),
    online.join(' · '),
  );
  safety.appendChild(safetyRows);

  // --- game folders ---------------------------------------------------------
  const folders = section('s-games', 'Where the games are');
  const gameRows = el('div', 'rows');
  for (const game of s.games) {
    const row = el('div', 'gamerow');
    row.appendChild(el('div', 'gamerow-name', game.shortName));
    row.appendChild(
      el(
        'div',
        `gamerow-path${game.installed ? '' : ' is-missing'}`,
        game.path ?? 'No folder found — choose it yourself if the game is installed',
      ),
    );
    // Per game, because every one of these acts on a single folder and doing
    // them from a shared row at the bottom meant they silently applied to
    // whichever game happened to be selected.
    const pick = el('button', 'btn', 'Choose folder');
    pick.title = `Point GTArage at the ${game.shortName} folder yourself`;
    pick.addEventListener('click', () => void chooseFolderFor(game.id));
    row.appendChild(pick);

    if (game.installed) {
      const strip = el('button', 'btn', 'Remove all mods');
      strip.title = 'Put this game folder back to how it was, without deleting anything';
      strip.addEventListener('click', () => void removeAllMods(game.id, game.shortName));
      row.appendChild(strip);

      // Forgetting drops the folder from GTArage; it touches neither the game
      // nor the library.
      const forget = el('button', 'btn', 'Forget');
      forget.title = `Stop managing ${game.shortName}. Nothing is deleted.`;
      forget.addEventListener('click', async () => {
        const ok = await confirmModal(
          `Forget ${game.shortName}?`,
          'GTArage stops managing this folder. Your game, your mods and your library are all left exactly as they are, and you can point it back at the folder any time.',
          'Forget it',
        );
        if (!ok) return;
        const next = await guard('Forgetting…', () => api.forgetGame(game.id));
        if (next) apply(next);
      });
      row.appendChild(forget);

      // Enhanced ships BattlEye, which stops script mods loading at all. The
      // flag is Steam's, not ours, so this only appears for a Steam copy.
      if (game.id === 'gta5e' && game.source === 'steam') {
        row.appendChild(battlEyeButton());
      }
    }
    gameRows.appendChild(row);
  }
  folders.appendChild(gameRows);
  const folderActs = el('div', 'notice-acts');
  const again = el('button', 'btn', 'Search again');
  again.addEventListener('click', () => detect_());
  folderActs.appendChild(again);
  folders.appendChild(folderActs);

  // --- how files are placed -------------------------------------------------
  const placing = section('s-files', 'How files are placed', {
    blurb:
      'A link is a second name for a file that already exists, so it costs almost nothing. A copy duplicates it — a 6 GB texture pack in two setups becomes 12 GB on disk.',
  });
  const picks = el('div', 'picks');
  const pick = (name: string, desc: string, on: boolean, onPick: () => void) => {
    const card = el('button', `pick${on ? ' is-on' : ''}`);
    card.appendChild(el('div', 'pick-name', name));
    card.appendChild(el('div', 'pick-desc', desc));
    card.addEventListener('click', onPick);
    picks.appendChild(card);
  };
  pick(
    'Link files where possible',
    'Falls back to copying when a setup and a game sit on different drives.',
    s.settings.useHardlinks,
    set({ useHardlinks: true }),
  );
  pick(
    'Always copy',
    'Slower and uses far more space. Works on every drive and setup.',
    !s.settings.useHardlinks,
    set({ useHardlinks: false }),
  );
  placing.appendChild(picks);

  // --- graphics -------------------------------------------------------------
  const gfx = section('s-graphics', 'Graphics settings per setup');
  const gfxRows = el('div', 'rows');
  toggleRow(
    gfxRows,
    'Each setup keeps its own graphics settings',
    "Its own settings.xml and launch options, applied on the switch.",
    s.settings.graphicsPerProfile,
    set({ graphicsPerProfile: !s.settings.graphicsPerProfile }),
  );
  gfx.appendChild(gfxRows);

  // --- updates --------------------------------------------------------------
  const updates = section('s-updates', 'Updates', { note: `Version ${s.appVersion}` });
  const updRows = el('div', 'rows');
  const updRow = el('div', 'srow');
  const updMain = el('div', 'srow-main');
  updMain.appendChild(el('div', 'srow-name', 'When a new version is published'));
  updMain.appendChild(
    el('div', 'srow-desc', 'Downloads are checked against their published checksum before anything runs.'),
  );
  updRow.appendChild(updMain);
  const seg = el('div', 'seg');
  for (const [value, label] of [
    ['notify', 'Tell me'],
    ['auto', 'Auto'],
    ['off', 'Never check'],
  ] as Array<['notify' | 'auto' | 'off', string]>) {
    const b = el('button', s.settings.autoUpdate === value ? 'is-on' : undefined, label);
    b.addEventListener('click', set({ autoUpdate: value }));
    seg.appendChild(b);
  }
  updRow.appendChild(seg);
  updRows.appendChild(updRow);
  updates.appendChild(updRows);
  const checkActs = el('div', 'notice-acts');
  const check = el('button', 'btn', 'Check now');
  check.addEventListener('click', () => void checkForUpdate(true));
  checkActs.appendChild(check);
  updates.appendChild(checkActs);

  // --- appearance -----------------------------------------------------------
  const look = section('s-look', 'Appearance');
  const lookRows = el('div', 'rows');
  const lookRow = el('div', 'srow');
  const lookMain = el('div', 'srow-main');
  lookMain.appendChild(el('div', 'srow-name', 'Theme'));
  lookMain.appendChild(el('div', 'srow-desc', 'The interface is designed light. Dark is available if you prefer it.'));
  lookRow.appendChild(lookMain);
  const themeSeg = el('div', 'seg');
  for (const [value, label] of [
    ['light', 'Light'],
    ['dark', 'Dark'],
  ] as Array<['light' | 'dark', string]>) {
    const b = el('button', (s.settings.theme ?? 'light') === value ? 'is-on' : undefined, label);
    // themeChosen marks a real decision, so the one-time retirement of the old
    // default never overrides it again.
    b.addEventListener('click', set({ theme: value, themeChosen: true }));
    themeSeg.appendChild(b);
  }
  lookRow.appendChild(themeSeg);
  lookRows.appendChild(lookRow);
  look.appendChild(lookRows);

  // --- extras ---------------------------------------------------------------
  const extras = section('s-extras', 'Extra tools');
  const extraRows = el('div', 'rows');
  toggleRow(
    extraRows,
    'Speedrunning tools',
    'Adds a tab with the timers, launchers and routing resources runners use.',
    s.settings.speedrunMode,
    set({ speedrunMode: !s.settings.speedrunMode }),
  );
  extras.appendChild(extraRows);

  // --- where files live -----------------------------------------------------
  const where = section('s-where', 'Where your files live');
  const whereRows = el('div', 'rows');
  for (const [name, dir, kind] of [
    ['Library', s.libraryPath, 'library'],
    ['Shelf', s.shelfPath, 'shelf'],
  ] as Array<[string, string, 'library' | 'shelf']>) {
    const row = el('div', 'gamerow');
    row.appendChild(el('div', 'gamerow-name', name));
    row.appendChild(el('div', 'gamerow-path', dir));
    const open = el('button', 'btn', 'Open');
    open.addEventListener('click', () => void api.openPath(kind));
    row.appendChild(open);
    whereRows.appendChild(row);
  }
  where.appendChild(whereRows);

  // --- start over -----------------------------------------------------------
  const purge = section('s-purge', 'Start over', {
    blurb:
      'Every game is put back to unmodded first, then the library, the shelf and this settings file are deleted. Your games, and the archives you installed mods from, are left alone — but everything GTArage made is gone, and the shelf that makes the rest of the app undoable goes with it.',
  });
  const purgeRows = el('div', 'rows');
  const purgeRow = el('div', 'srow');
  const purgeMain = el('div', 'srow-main');
  purgeMain.appendChild(el('div', 'srow-name', 'Remove GTArage from this PC'));
  purgeMain.appendChild(
    el(
      'div',
      'srow-desc',
      'The app closes afterwards. This one genuinely cannot be undone.',
    ),
  );
  purgeRow.appendChild(purgeMain);
  const purgeBtn = el('button', 'btn is-danger', 'Remove everything…');
  purgeBtn.addEventListener('click', () => void purgeEverything(s));
  purgeRow.appendChild(purgeBtn);
  purgeRows.appendChild(purgeRow);
  purge.appendChild(purgeRows);

  // The rail is built last, from the sections that actually exist.
  const rail = el('div', 'onpage');
  rail.appendChild(el('div', 'onpage-label', 'ON THIS PAGE'));
  for (const [id, title] of sections) {
    const link = el('button', undefined, title);
    link.addEventListener('click', () => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    rail.appendChild(link);
  }

  sheet.append(rail, groups);
  view.appendChild(sheet);
}

// --- Tools --------------------------------------------------------------------

/**
 * Tools: where a mod comes from.
 *
 * Built from the "Settings & Browse" mockup, which argues that the routes in
 * should look as different as they behave. They are not variations on a
 * listing: Essentials is a short fixed list with real install buttons, and a
 * community site is a doorway where all the app can do is catch what you
 * download. The mockup's drop band was removed by request -- dropping a file
 * still works anywhere in the window, it just is not advertised here.
 *
 * There is deliberately no search. The previous version had one, over a
 * catalogue that does not exist, and people reasonably concluded the app was
 * broken when it returned nothing.
 */

/** Essentials for the game currently on screen. Null until first fetched. */
let essentials: EssentialsView | null = null;
let essentialsFor_: GameId | null = null;
let essentialsLoading = false;

/**
 * In-flight and failed downloads, keyed by entry id.
 *
 * Session state, not app state: it belongs to this window and this attempt,
 * so it lives here rather than being round-tripped through AppState.
 */
const toolBusy = new Map<string, { received: number; total: number }>();
let toolInstalling: string | null = null;
const toolFailed = new Map<string, string>();

/** Community sites for the current game. */
let sites: ModSite[] = [];

async function loadEssentials(gameId: GameId, refresh = false): Promise<void> {
  if (essentialsLoading) return;
  essentialsLoading = true;
  if (refresh) essentials = null;
  try {
    essentials = await api.listEssentials(gameId, refresh);
    essentialsFor_ = gameId;
  } catch (err) {
    essentials = { entries: [], error: (err as Error).message };
    essentialsFor_ = gameId;
  } finally {
    essentialsLoading = false;
    if (tab === 'tools') render();
  }
}

async function loadSites(gameId: GameId): Promise<void> {
  try {
    sites = await api.listSites(gameId);
    if (tab === 'tools') render();
  } catch {
    // Site list is static data; a failure here is not worth a toast.
  }
}

async function installEssential(entry: EssentialView, gameId: GameId): Promise<void> {
  toolFailed.delete(entry.id);
  toolBusy.set(entry.id, { received: 0, total: entry.sizeBytes });
  toolInstalling = entry.id;
  render();
  try {
    const result = await api.installEssential(entry.id, gameId);
    state = result.state;
    toast(result.message, result.imported ? 'ok' : 'warn');
    await loadEssentials(gameId, true);
  } catch (err) {
    toolFailed.set(entry.id, (err as Error).message);
    toast((err as Error).message, 'error');
  } finally {
    toolBusy.delete(entry.id);
    toolInstalling = null;
    render();
  }
}

/** One Essentials row, in whichever of its six states applies. */
function essentialRow(entry: EssentialView, gameId: GameId): HTMLElement {
  const row = el('div', 'ess-row');
  const main = el('div', 'ess-main');

  const nameLine = el('div', 'ess-nameline');
  nameLine.appendChild(el('div', 'ess-name', entry.name));

  const busy = toolBusy.get(entry.id);
  const failed = toolFailed.get(entry.id);

  if (busy) {
    const total = busy.total || entry.sizeBytes;
    nameLine.appendChild(
      el(
        'div',
        'ess-ver',
        total > 0
          ? `${formatBytes(busy.received)} of ${formatBytes(total)}`
          : 'downloading',
      ),
    );
  } else if (failed) {
    nameLine.appendChild(el('div', 'ess-pill is-failed', 'FAILED'));
  } else if (entry.outdated) {
    nameLine.appendChild(
      el(
        'div',
        'ess-pill is-update',
        `${entry.installedVersion} → ${entry.version} AVAILABLE`,
      ),
    );
  } else if (entry.manualOnly) {
    nameLine.appendChild(el('div', 'ess-pill is-manual', 'MANUAL ONLY'));
  } else {
    nameLine.appendChild(el('div', 'ess-ver', entry.version));
  }
  main.appendChild(nameLine);

  if (busy) {
    const bar = el('div', 'ess-bar');
    const total = busy.total || entry.sizeBytes;
    const pct = total > 0 ? Math.min(100, Math.round((busy.received / total) * 100)) : 0;
    const fill = el('div', 'ess-bar-fill');
    fill.id = `essbar-${entry.id}`;
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    main.appendChild(bar);
  } else {
    // The second line answers "what is this and where do I stand with it",
    // which differs by state: a size and an install date once it is here, the
    // reason it cannot be fetched when it is manual, the summary otherwise.
    let sub: string;
    if (failed) {
      sub = `${failed} Try again, or open the page yourself.`;
    } else if (entry.manualOnly) {
      sub =
        entry.manualReason ??
        'No downloadable release — GTArage opens the project page, you bring the file back.';
    } else if (entry.installedAt) {
      const size = entry.sizeBytes > 0 ? `${formatBytes(entry.sizeBytes)} · ` : '';
      sub = `${size}installed ${formatDate(entry.installedAt)}`;
    } else {
      const size = entry.sizeBytes > 0 ? `${formatBytes(entry.sizeBytes)} · ` : '';
      sub = `${size}${entry.summary}`;
    }
    main.appendChild(el('div', 'ess-sub', sub));
  }

  row.appendChild(main);

  // The right-hand affordance. Exactly one per row, and only the plain
  // not-installed case gets the blue: an update and a manual link-out are
  // both things the user may reasonably ignore.
  if (busy) {
    const total = busy.total || entry.sizeBytes;
    const pct = total > 0 ? Math.min(100, Math.round((busy.received / total) * 100)) : 0;
    const pctText = el('div', 'ess-pct', `${pct}%`);
    pctText.id = `esspct-${entry.id}`;
    row.appendChild(pctText);
  } else if (failed) {
    const retry = el('button', 'btn btn-sm', 'Retry');
    retry.addEventListener('click', () => void installEssential(entry, gameId));
    row.appendChild(retry);
  } else if (entry.manualOnly) {
    const open = el('button', 'btn btn-sm', 'Open page');
    open.addEventListener('click', () => {
      void api.openExternal(entry.url).catch((err: Error) => toast(err.message, 'error'));
    });
    row.appendChild(open);
  } else if (entry.outdated) {
    const update = el('button', 'btn btn-sm', 'Update');
    update.addEventListener('click', () => void installEssential(entry, gameId));
    row.appendChild(update);
  } else if (entry.installedVersion) {
    row.appendChild(el('div', 'ess-ok', '✓ Up to date'));
  } else {
    const install = el('button', 'btn btn-sm is-blue', 'Install');
    install.addEventListener('click', () => void installEssential(entry, gameId));
    row.appendChild(install);
  }

  return row;
}

/** The Essentials column, including its offline and loading states. */
function essentialsPanel(s: AppState, gameId: GameId): HTMLElement {
  const col = el('div', 'tools-col is-essentials');

  const head = el('div', 'tools-colhead');
  head.appendChild(el('div', 'tools-colhead-title', 'Essentials'));
  const game = s.games.find((g) => g.id === gameId);
  head.appendChild(el('div', 'tools-gamepill', game ? game.shortName : 'this game'));
  head.appendChild(el('div', 'tools-spacer'));
  head.appendChild(el('div', 'tools-colhead-note', 'from official GitHub releases'));
  col.appendChild(head);

  const card = el('div', 'tools-card');

  if (essentialsLoading && !essentials) {
    card.classList.add('is-centred');
    card.appendChild(el('div', 'tools-quiet', 'Checking the release pages…'));
  } else if (essentials?.error) {
    // Panel-level, never page-level: dropping a file and the community sites
    // do not go through GitHub and still work perfectly.
    card.classList.add('is-centred');
    card.appendChild(el('div', 'tools-quiet-icon', '⚠'));
    card.appendChild(el('div', 'tools-quiet-title', 'Can’t reach GitHub right now'));
    card.appendChild(
      el(
        'div',
        'tools-quiet',
        'Essentials will load again once you’re back online. Dropping a file and community sites still work fine.',
      ),
    );
    const again = el('button', 'btn btn-sm', 'Try again');
    again.addEventListener('click', () => void loadEssentials(gameId, true));
    card.appendChild(again);
  } else if (essentials && essentials.entries.length === 0) {
    card.classList.add('is-centred');
    card.appendChild(el('div', 'tools-quiet', 'No essentials are listed for this game.'));
  } else if (essentials) {
    for (const entry of essentials.entries) card.appendChild(essentialRow(entry, gameId));
  }

  col.appendChild(card);
  return col;
}

/** The community-site column: a doorway, with nothing to rank. */
function sitesPanel(gameId: GameId): HTMLElement {
  const col = el('div', 'tools-col is-sites');

  const head = el('div', 'tools-colhead is-stacked');
  head.appendChild(el('div', 'tools-colhead-title', 'Community sites'));
  head.appendChild(
    el(
      'div',
      'tools-colhead-sub',
      'No listing here. Log in and download like normal — GTArage catches the file when it lands.',
    ),
  );
  col.appendChild(head);

  const card = el('div', 'tools-card is-sites');
  // docsOnly sites are reference material, not places you download from.
  // Listing the GTAMods wiki under "log in and download" would be a lie about
  // what pressing it does.
  for (const site of sites.filter((site) => !site.docsOnly)) {
    const row = el('button', 'site-row');
    row.appendChild(el('div', 'site-dot'));
    row.appendChild(el('div', 'site-name', site.name));
    row.appendChild(el('div', 'site-open', 'Open ↗'));
    row.addEventListener('click', () => {
      void api.openSite(site.id, gameId).catch((err: Error) => toast(err.message, 'error'));
    });
    card.appendChild(row);
  }
  col.appendChild(card);

  col.appendChild(
    el('div', 'tools-foot', 'Nothing to search or rank — this is a doorway, not a catalogue.'),
  );
  return col;
}

/**
 * First run: nothing in the library at all.
 *
 * The drop zone becomes the whole screen, because it is the one route that
 * works with no network, no account and nothing else set up.
 */
function toolsFirstRun(s: AppState, gameId: GameId): HTMLElement {
  const wrap = el('div', 'tools-empty');

  const lead = el('div', 'tools-empty-lead');
  lead.appendChild(el('div', 'tools-empty-title', 'Nothing here yet'));
  lead.appendChild(
    el(
      'div',
      'tools-empty-sub',
      'Install one of the essential tools, or open a community site and download as you normally would.',
    ),
  );
  wrap.appendChild(lead);

  const cards = el('div', 'tools-empty-cards');

  const count = essentials?.entries.length ?? 0;
  const game = s.games.find((g) => g.id === gameId);
  const first = el('div', 'tools-empty-card');
  first.appendChild(el('div', 'tools-empty-card-title', 'Nothing installed yet'));
  first.appendChild(
    el(
      'div',
      'tools-empty-card-body',
      count > 0
        ? `${count} essential${count === 1 ? '' : 's'} for ${game ? game.shortName : 'this game'}, fetched from ${count === 1 ? 'its' : 'their'} official page${count === 1 ? '' : 's'}.`
        : 'The essential tools are fetched from their official pages.',
    ),
  );
  const viewEss = el('button', 'linkish', 'View essentials →');
  viewEss.addEventListener('click', () => {
    toolsShowAll = true;
    render();
  });
  first.appendChild(viewEss);
  cards.appendChild(first);

  const second = el('div', 'tools-empty-card');
  second.appendChild(el('div', 'tools-empty-card-title', 'Or find one on a community site'));
  second.appendChild(
    el(
      'div',
      'tools-empty-card-body',
      sites
        .filter((site) => !site.docsOnly)
        .map((site) => site.name)
        .join(', '),
    ),
  );
  const viewSites = el('button', 'linkish', 'Open a site →');
  viewSites.addEventListener('click', () => {
    toolsShowAll = true;
    render();
  });
  second.appendChild(viewSites);
  cards.appendChild(second);

  wrap.appendChild(cards);
  return wrap;
}

/** Set once the user asks past the first-run screen, for this session. */
let toolsShowAll = false;

function renderTools(s: AppState, view: HTMLElement): void {
  const page = el('div', 'tools');
  const gameId = s.currentGameId;

  if (!gameId) {
    page.appendChild(
      el('div', 'tools-quiet', 'Choose a game first — the tools differ between them.'),
    );
    view.appendChild(page);
    return;
  }

  if (essentialsFor_ !== gameId && !essentialsLoading) void loadEssentials(gameId);
  if (sites.length === 0) void loadSites(gameId);

  const head = el('div', 'tools-head');
  head.appendChild(el('div', 'tools-title', 'Get mods into GTArage'));
  head.appendChild(
    el('div', 'tools-sub', 'There’s no catalogue here — mods come from the essentials list or a community site.'),
  );
  page.appendChild(head);

  const empty = s.mods.filter((m) => m.gameId === gameId).length === 0;
  if (empty && !toolsShowAll) {
    page.appendChild(toolsFirstRun(s, gameId));
    view.appendChild(page);
    return;
  }

  const cols = el('div', 'tools-cols');
  cols.appendChild(essentialsPanel(s, gameId));
  cols.appendChild(sitesPanel(gameId));
  page.appendChild(cols);

  view.appendChild(page);
}

// --- Library ------------------------------------------------------------------

/** Which mod the Library detail panel is showing. */
let librarySelection: string | null = null;
let librarySearch = '';
let libraryFilter = 'all';

/**
 * The Library, from mockup 2a.
 *
 * A mod lives here whether or not a setup uses it, and that is the whole point
 * of the screen: before this existed, a mod imported while one setup was open
 * was invisible from every other setup, still on disk, with no way to add it
 * to a second setup short of importing it again.
 *
 * The design's other insistence is that "take out of a setup" and "delete from
 * the library" must never be confusable. The first is a link beside each setup
 * name; the second is a bordered warning card at the bottom of the panel that
 * names what would break. Deleting is the only irreversible thing in the app.
 */
function renderLibrary(s: AppState, view: HTMLElement): void {
  const mods = s.mods;
  if (mods.length === 0) {
    view.appendChild(emptyLibrary());
    return;
  }

  // Keep the selection pointing at something that still exists.
  if (!librarySelection || !mods.some((m) => m.id === librarySelection)) {
    librarySelection = mods[0]?.id ?? null;
  }

  const wrap = el('div', 'lib');
  const left = el('div', 'lib-left');

  // --- heading and totals ---------------------------------------------------
  const head = el('div', 'lib-head');
  const headText = el('div');
  const gameName = s.games.find((g) => g.id === s.currentGameId)?.shortName ?? 'this game';
  headText.appendChild(el('div', 'ask', `Everything you have for ${gameName}`));
  headText.appendChild(
    el(
      'div',
      'lede',
      'A mod lives here whether or not a setup uses it. Adding it to a setup does not copy it again.',
    ),
  );
  head.appendChild(headText);

  const bytes = mods.reduce((n, m) => n + m.size, 0);
  const unused = mods.filter((m) => setupsUsing(s, m.id).length === 0);
  const unusedBytes = unused.reduce((n, m) => n + m.size, 0);
  const totals = el('div', 'lib-totals');
  totals.appendChild(
    el('div', 'lib-total', `${mods.length} mod${mods.length === 1 ? '' : 's'} · ${formatBytes(bytes)}`),
  );
  // Only worth saying when it is true; "0 B used by nothing" is noise.
  if (unused.length > 0) {
    totals.appendChild(el('div', 'lib-total-sub', `${formatBytes(unusedBytes)} used by nothing`));
  }
  head.appendChild(totals);
  left.appendChild(head);

  // --- search and filters ---------------------------------------------------
  const bar = el('div', 'lib-bar');
  const search = el('input', 'lib-search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = `Search ${mods.length} mod${mods.length === 1 ? '' : 's'}`;
  search.value = librarySearch;
  search.addEventListener('input', () => {
    librarySearch = search.value;
    renderLibraryRows(s, rowHost);
  });
  bar.appendChild(search);

  const pills = el('div', 'lib-pills');
  const filters: Array<[string, string]> = [
    ['all', 'Everything'],
    ['plays', 'Installed'],
    ['looks', 'How it looks'],
    ['files', 'Game files'],
    ['core', 'Required'],
  ];
  for (const [id, label] of filters) {
    if (id !== 'all' && libraryMods(s, id, '').length === 0) continue;
    const pill = el('button', `pill${libraryFilter === id ? ' is-active' : ''}`, label);
    pill.addEventListener('click', () => {
      libraryFilter = id;
      render();
    });
    pills.appendChild(pill);
  }
  bar.appendChild(pills);
  left.appendChild(bar);

  // --- the table ------------------------------------------------------------
  const table = el('div', 'lib-table');
  const thead = el('div', 'lib-thead');
  thead.appendChild(el('div', 'lib-col-mod', 'MOD'));
  thead.appendChild(el('div', 'lib-col-used', 'USED BY'));
  thead.appendChild(el('div', 'lib-col-size', 'SIZE'));
  table.appendChild(thead);
  const rowHost = el('div', 'lib-rows');
  table.appendChild(rowHost);
  renderLibraryRows(s, rowHost);
  left.appendChild(table);

  wrap.appendChild(left);
  wrap.appendChild(libraryDetail(s, mods.find((m) => m.id === librarySelection)!));
  view.appendChild(wrap);
}

/** The setups that reference a mod, by name. */
function setupsUsing(s: AppState, modId: string): Profile[] {
  return s.profiles.filter((p) => !p.vanillaLock && p.order.includes(modId));
}

function libraryMods(s: AppState, which: string, needle: string): Mod[] {
  const q = needle.trim().toLowerCase();
  return s.mods.filter((mod) => {
    if (q && !mod.name.toLowerCase().includes(q)) return false;
    switch (which) {
      case 'core':
        return mod.core || mod.kind === 'modloader';
      case 'looks':
        return mod.kind === 'graphics';
      case 'files':
        return mod.kind === 'replace' || mod.kind === 'oiv';
      case 'plays':
        return ['asi', 'script', 'cleo'].includes(mod.kind);
      default:
        return true;
    }
  });
}

function renderLibraryRows(s: AppState, host: HTMLElement): void {
  clear(host);
  const rows = libraryMods(s, libraryFilter, librarySearch);
  if (rows.length === 0) {
    host.appendChild(el('div', 'lib-empty', 'Nothing matches that.'));
    return;
  }
  for (const mod of rows) {
    const used = setupsUsing(s, mod.id);
    const row = el('div', `lib-row${mod.id === librarySelection ? ' is-selected' : ''}`);

    const main = el('div', 'lib-col-mod');
    const title = el('div', 'lib-row-title');
    title.appendChild(el('span', 'lib-name', mod.name));
    const needers = s.mods.filter((m) => m.requires.includes(mod.id));
    if (needers.length > 0) {
      title.appendChild(
        el('span', 'tag', `${needers.length} mod${needers.length === 1 ? '' : 's'} need it`),
      );
    }
    main.appendChild(title);
    main.appendChild(
      el(
        'div',
        'lib-row-meta',
        `${mod.version} · ${mod.files.length} file${mod.files.length === 1 ? '' : 's'} · added ${formatDate(mod.addedAt)}`,
      ),
    );
    row.appendChild(main);

    const usedCell = el(
      'div',
      'lib-col-used',
      used.length === 0
        ? ''
        : used.length <= 2
          ? used.map((p) => p.name).join(', ')
          : `${used.length} setups`,
    );
    usedCell.title = used.map((p) => p.name).join(', ');
    row.appendChild(usedCell);

    row.appendChild(el('div', 'lib-col-size', formatBytes(mod.size)));

    row.addEventListener('click', () => {
      librarySelection = mod.id;
      render();
    });
    host.appendChild(row);
  }
}

function libraryDetail(s: AppState, mod: Mod): HTMLElement {
  const panel = el('div', 'lib-detail');

  const head = el('div');
  const nameRow = el('div', 'lib-detail-head');
  nameRow.appendChild(el('div', 'lib-detail-name', mod.name));
  // Deleting lives here, not in a standing warning card: the same "⋯" menu
  // that removes a setup or a mod from a setup, so there is one place in the
  // app that means "more actions on this thing" rather than two.
  const more = el('button', 'more-btn', '⋯');
  more.title = `More actions for ${mod.name}`;
  more.addEventListener('click', () => modMenu(mod));
  nameRow.appendChild(more);
  head.appendChild(nameRow);
  const sub = el('div', 'lib-detail-sub');
  sub.appendChild(el('span', 'tag', plainKind(mod.kind)));
  sub.appendChild(el('span', 'lib-detail-ver', mod.version));
  head.appendChild(sub);
  panel.appendChild(head);

  // The four facts, as a 2x2.
  const deployedProfile = s.profiles.find((p) => p.id === s.deployed?.profileId);
  const live = Boolean(deployedProfile?.enabled.includes(mod.id));
  const needers = s.mods.filter((m) => m.requires.includes(mod.id));

  const facts = el('div', 'lib-facts');
  const factCell = (label: string, value: string, good = false) => {
    const cell = el('div');
    cell.appendChild(el('div', 'lib-fact-label', label));
    cell.appendChild(el('div', `lib-fact-value${good ? ' is-good' : ''}`, value));
    facts.appendChild(cell);
  };
  factCell('SIZE ON DISK', `${formatBytes(mod.size)} · ${mod.files.length} files`);
  factCell('ADDED', formatDate(mod.addedAt));
  factCell('IN THE GAME FOLDER', live ? '✓ Yes, right now' : 'Not right now', live);
  factCell(
    'NEEDED BY',
    needers.length === 0 ? 'Nothing else' : `${needers.length} of your mods`,
  );
  panel.appendChild(facts);

  // --- the setups using it --------------------------------------------------
  const used = setupsUsing(s, mod.id);
  const usable = s.profiles.filter((p) => !p.vanillaLock);
  const section = el('div');
  section.appendChild(
    el(
      'div',
      'lib-detail-h',
      used.length === 0
        ? 'Not in any setup yet'
        : `In ${used.length} of your ${usable.length} setup${usable.length === 1 ? '' : 's'}`,
    ),
  );
  const list = el('div', 'lib-setups');
  for (const profile of used) {
    const row = el('div', 'lib-setup');
    row.appendChild(el('div', 'lib-setup-name', profile.name));
    const out = el('button', 'lib-take-out', 'Take out');
    out.addEventListener('click', async () => {
      const next = await guard('Updating…', () =>
        api.setModInProfile({ profileId: profile.id, modId: mod.id, present: false }),
      );
      if (next) apply(next);
    });
    row.appendChild(out);
    list.appendChild(row);
  }
  section.appendChild(list);
  section.appendChild(
    el('div', 'lib-detail-note', 'Taking it out leaves the mod here in the library.'),
  );
  panel.appendChild(section);

  // --- add to another setup -------------------------------------------------
  // Shown for every mod, not only the ones with somewhere left to go.
  // Hiding it when a mod is already in every setup meant the control came and
  // went between selections, which reads as the button being broken rather
  // than as there being nothing to add it to.
  const free = usable.filter((p) => !p.order.includes(mod.id));
  {
    const add = el('select', 'lib-add') as HTMLSelectElement;
    const placeholder = el('option', undefined, 'Add to a setup');
    placeholder.value = '';
    add.appendChild(placeholder);
    for (const profile of free) {
      const option = el('option', undefined, profile.name);
      option.value = profile.id;
      add.appendChild(option);
    }
    if (free.length === 0) {
      add.disabled = true;
      placeholder.textContent =
        usable.length === 0 ? 'No setups to add it to yet' : 'Already in every setup';
    }
    add.addEventListener('change', async () => {
      if (!add.value) return;
      const next = await guard('Adding…', () =>
        api.setModInProfile({ profileId: add.value, modId: mod.id, present: true }),
      );
      if (next) apply(next);
    });
    panel.appendChild(add);
  }

  panel.appendChild(el('div', 'lib-grow'));

  return panel;
}

/** Mockup 2c: the empty state points at both ways in. */
function emptyLibrary(): HTMLElement {
  const wrap = el('div', 'lib-empty-state');
  const inner = el('div', 'lib-empty-inner');
  inner.appendChild(el('div', 'ask', 'Nothing in your library yet'));
  inner.appendChild(
    el(
      'div',
      'lede',
      'Mods land here first. Once one is in the library you can put it in any setup, as many times as you like, without downloading it again.',
    ),
  );

  const cards = el('div', 'lib-empty-cards');

  const second = el('div', 'note-card is-dashed lib-empty-card');
  const secondMain = el('div', 'note-main');
  secondMain.appendChild(el('div', 'note-title', 'Drop in a file you have'));
  secondMain.appendChild(
    el('div', 'note-body', '.zip, .rar, .7z, .oiv or a folder. Drop it anywhere on this window.'),
  );
  second.appendChild(secondMain);
  const choose = el('button', 'btn btn-wide', 'Choose a file');
  choose.addEventListener('click', () => installMod('files'));
  second.appendChild(choose);
  wireDropzone(second);
  cards.appendChild(second);

  inner.appendChild(cards);
  wrap.appendChild(inner);
  return wrap;
}

// --- rendering: speedrun ----------------------------------------------------

/**
 * The speedrunning tab.
 *
 * A launcher and a directory, not a wrapper: GTArage does not reimplement
 * LiveSplit or install anything on your behalf - it finds what you already
 * have, starts it, and links what it cannot install.
 *
 * Rebuilt in the 2a/2b language. The content is unchanged; it was written in
 * the dark control room's card vocabulary and never translated.
 */
function renderSpeedrun(s: AppState, view: HTMLElement): void {
  const page = el('div', 'page');

  const head = el('div', 'home-head');
  head.appendChild(el('h1', 'ask', 'Speedrunning'));
  head.appendChild(
    el(
      'p',
      'lede',
      'The timers, launchers and routing resources runners use. GTArage starts what you already have and links the rest — it does not install these for you.',
    ),
  );
  page.appendChild(head);

  // --- tools ----------------------------------------------------------------
  const tools = el('div', 'group');
  const toolHead = el('div', 'group-head');
  toolHead.appendChild(el('div', 'group-title', 'Tools'));
  toolHead.appendChild(
    el(
      'div',
      'group-note',
      speedrunTools.length === 0
        ? 'Looking…'
        : `${speedrunTools.filter((t) => t.installed).length} of ${speedrunTools.length} found on this PC`,
    ),
  );
  tools.appendChild(toolHead);

  const toolRows = el('div', 'rows');
  for (const tool of speedrunTools) {
    const row = el('div', 'srow');
    const main = el('div', 'srow-main');
    const title = el('div', 'srow-name');
    title.appendChild(document.createTextNode(tool.name));
    if (tool.core) title.appendChild(el('span', 'tag', 'essential'));
    main.appendChild(title);
    main.appendChild(el('div', 'srow-desc', tool.summary));
    if (tool.path) main.appendChild(el('div', 'srow-desc', tool.path));
    row.appendChild(main);

    if (tool.installed) {
      const start = el('button', 'btn is-primary', 'Start');
      start.addEventListener('click', async () => {
        if (!s.currentGameId) return;
        try {
          await api.launchSpeedrunTool(tool.id, s.currentGameId);
          toast(`Starting ${tool.name}…`, 'ok');
        } catch (err) {
          toast((err as Error).message, 'error');
        }
      });
      row.appendChild(start);
    } else {
      // Portable tools - LiveSplit especially - live wherever the user
      // extracted them, so probing install directories finds them for almost
      // nobody.
      const locate = el('button', 'btn', 'Locate…');
      locate.title = 'Point GTArage at it if you already have it';
      locate.addEventListener('click', async () => {
        if (!s.currentGameId) return;
        const list = await guard('Looking…', () =>
          api.locateSpeedrunTool(tool.id, s.currentGameId!),
        );
        if (list) {
          speedrunTools = list;
          render();
        }
      });
      row.appendChild(locate);

      const get = el('button', 'btn', 'Get it');
      get.addEventListener('click', () => {
        void api.openExternal(tool.url).catch((err: Error) => toast(err.message, 'error'));
      });
      row.appendChild(get);
    }
    toolRows.appendChild(row);
  }
  if (speedrunTools.length > 0) tools.appendChild(toolRows);
  page.appendChild(tools);

  // --- practice setup -------------------------------------------------------
  const practice = el('div', 'group');
  const pHead = el('div', 'group-head');
  pHead.appendChild(el('div', 'group-title', 'Practice mods'));
  practice.appendChild(pHead);
  practice.appendChild(
    el(
      'div',
      'group-blurb',
      'Practice mods must never be in a submitted run. Keeping them in their own setup means switching back to a clean game is one click — which is the whole reason a setup manager is useful here.',
    ),
  );

  const hasPractice = s.profiles.some((p) => p.name === PRACTICE_PROFILE);
  const pRows = el('div', 'rows');
  const pRow = el('div', 'srow');
  const pMain = el('div', 'srow-main');
  pMain.appendChild(el('div', 'srow-name', `"${PRACTICE_PROFILE}" setup`));
  pMain.appendChild(
    el(
      'div',
      'srow-desc',
      hasPractice
        ? 'Ready. Install practice mods into it, and switch to the vanilla setup before a real attempt.'
        : 'Not made yet. GTArage can create an empty one to keep practice mods separate.',
    ),
  );
  pRow.appendChild(pMain);
  if (!hasPractice) {
    const make = el('button', 'btn is-primary', 'Create it');
    make.addEventListener('click', async () => {
      if (!s.currentGameId) return;
      const next = await guard('Creating…', () =>
        api.createProfile(s.currentGameId!, PRACTICE_PROFILE),
      );
      if (next) {
        apply(next);
        toast(`"${PRACTICE_PROFILE}" setup created.`, 'ok');
      }
    });
    pRow.appendChild(make);
  }
  pRows.appendChild(pRow);
  practice.appendChild(pRows);
  page.appendChild(practice);

  // --- resources ------------------------------------------------------------
  for (const group of speedrunGroups) {
    const section = el('div', 'group');
    const gHead = el('div', 'group-head');
    gHead.appendChild(el('div', 'group-title', group.title));
    section.appendChild(gHead);
    section.appendChild(el('div', 'group-blurb', group.blurb));

    const rows = el('div', 'rows');
    for (const item of group.items) {
      const row = el('div', 'srow');
      const main = el('div', 'srow-main');
      const name = el('div', 'srow-name');
      name.appendChild(document.createTextNode(item.name));
      if (item.discord) name.appendChild(el('span', 'tag', 'discord'));
      main.appendChild(name);
      if (item.note) main.appendChild(el('div', 'srow-desc', item.note));
      row.appendChild(main);

      const open = el('button', 'btn', 'Open');
      open.addEventListener('click', () => {
        void api.openExternal(item.url).catch((err: Error) => toast(err.message, 'error'));
      });
      row.appendChild(open);
      rows.appendChild(row);
    }
    section.appendChild(rows);
    page.appendChild(section);
  }

  view.appendChild(page);
}

// --- rendering: saves -------------------------------------------------------

/**
 * Save snapshots.
 *
 * Rebuilt in the 2a/2b language rather than the dark control room's card
 * vocabulary it was written in. The content is unchanged - this screen was
 * never wrong, it was just speaking the previous design's dialect.
 */
function renderSaves(s: AppState, view: HTMLElement): void {
  const page = el('div', 'page');

  const head = el('div', 'home-head');
  head.appendChild(el('h1', 'ask', 'Your save backups'));
  head.appendChild(
    el(
      'p',
      'lede',
      s.settings.backupSavesOnSwap
        ? 'A snapshot is taken automatically before every switch, so this list fills itself in as you use the app. Restoring is itself undoable — your current saves are snapshotted first.'
        : 'Automatic snapshots are switched off, so nothing is copied before a switch. You can still take one by hand, and turn the automatic ones back on in Settings.',
    ),
  );
  page.appendChild(head);

  const acts = el('div', 'notice-acts');
  const snapshot = el('button', 'btn is-primary', 'Take a snapshot now');
  snapshot.addEventListener('click', () => backupSaves());
  acts.appendChild(snapshot);
  const openSaves = el('button', 'btn', 'Open my saves folder');
  openSaves.title = "Open the game's own save folder in Explorer";
  openSaves.addEventListener('click', () => {
    if (s.currentGameId) {
      void api.openPath('saves', s.currentGameId).catch((err: Error) => toast(err.message, 'error'));
    }
  });
  acts.appendChild(openSaves);
  page.appendChild(acts);

  if (saves.length === 0) {
    page.appendChild(
      emptyState(
        'No snapshots yet',
        'GTArage takes one before every switch. Until then there is nothing here to restore.',
      ),
    );
    view.appendChild(page);
    return;
  }

  const group = el('div', 'group');
  const groupHead = el('div', 'group-head');
  groupHead.appendChild(el('div', 'group-title', 'Snapshots'));
  groupHead.appendChild(
    el('div', 'group-note', `${saves.length} kept · oldest ${formatDate(saves[saves.length - 1]!.createdAt)}`),
  );
  group.appendChild(groupHead);

  const rows = el('div', 'rows');
  for (const snap of saves) {
    const row = el('div', 'srow');
    const main = el('div', 'srow-main');
    main.appendChild(el('div', 'srow-name', snap.label));
    // Two different times, and the difference matters: the snapshot time is
    // when you swapped setups, the save time is how far along the save itself
    // actually is.
    main.appendChild(el('div', 'srow-desc', `Snapshot taken ${formatExact(snap.createdAt)}`));
    main.appendChild(
      el(
        'div',
        'srow-desc',
        snap.savedAt ? `Game last saved ${formatExact(snap.savedAt)}` : 'Game save time unknown',
      ),
    );
    main.appendChild(
      el(
        'div',
        'srow-desc',
        `${snap.fileCount} file${snap.fileCount === 1 ? '' : 's'} · ${formatBytes(snap.size)}`,
      ),
    );
    row.appendChild(main);

    const restore = el('button', 'btn', 'Restore');
    restore.addEventListener('click', async () => {
      if (!s.currentGameId) return;
      const ok = await confirmModal(
        'Restore this snapshot?',
        'Your current saves are snapshotted first, so this is itself undoable.',
        'Restore saves',
      );
      if (!ok) return;
      const list = await guard('Restoring saves…', () =>
        api.restoreSave(s.currentGameId!, snap.id),
      );
      if (list) {
        saves = list;
        toast('Saves restored.', 'ok');
        render();
      }
    });
    row.appendChild(restore);
    rows.appendChild(row);
  }
  group.appendChild(rows);
  page.appendChild(group);
  view.appendChild(page);
}

// --- rendering: settings ----------------------------------------------------


// --- rendering: inspector ---------------------------------------------------


// --- updates ----------------------------------------------------------------

/** Set once an update has been offered this session, so it asks only once. */
let updateOffered = false;

/**
 * Check for a newer GTArage.
 *
 * `manual` means the user pressed the button, so silence is not an acceptable
 * answer — they get told either way. The automatic check stays quiet when
 * there is nothing to say.
 */
async function checkForUpdate(manual = false): Promise<void> {
  const s = state;
  if (!s) return;
  if (!manual && (s.settings.autoUpdate ?? 'notify') === 'off') return;
  if (!manual && updateOffered) return;

  let info: UpdateView;
  try {
    info = manual
      ? ((await guard('Checking for updates…', () => api.checkForUpdate())) as UpdateView)
      : await api.checkForUpdate();
    if (!info) return;
  } catch (err) {
    if (manual) toast((err as Error).message, 'error');
    return;
  }

  if (!info.newer) {
    if (manual) toast(`GTArage ${info.current} is the latest version.`, 'ok');
    return;
  }

  updateOffered = true;

  // "Install automatically" still shows what is happening; it just does not
  // wait to be asked.
  if (!manual && (s.settings.autoUpdate ?? 'notify') === 'auto' && !info.cannotSelfUpdate) {
    await runUpdate(info);
    return;
  }

  showUpdatePrompt(info);
}

function showUpdatePrompt(info: UpdateView): void {
  openModal({
    title: `GTArage ${info.version} is available`,
    subtitle: `You are on ${info.current}.`,
    build: (body) => {
      if (info.cannotSelfUpdate) {
        body.appendChild(
          el(
            'div',
            'warning',
            'You are running the portable build, which cannot replace itself. Download the new portable exe and swap it in.',
          ),
        );
      }
      body.appendChild(
        el(
          'div',
          info.verifiable ? 'alert-body' : 'warning',
          info.verifiable
            ? 'The download is checked against the checksum published with the release, and refused if it does not match.'
            : 'This release did not publish a checksum, so the download cannot be verified. Installing from the releases page yourself would be safer.',
        ),
      );

      // Release notes, trimmed: the full text can be long.
      const notes = info.notes.split('\n').slice(0, 24).join('\n').trim();
      if (notes) {
        body.appendChild(el('div', 'field-label', "What's new"));
        body.appendChild(el('div', 'mono-list', notes));
      }
    },
    actions: [
      { label: 'Not now', onClick: () => true },
      {
        label: 'Release page',
        onClick: () => {
          void api.openExternal(info.url).catch((err: Error) => toast(err.message, 'error'));
          return true;
        },
      },
      {
        label: info.cannotSelfUpdate ? 'Download' : 'Install and restart',
        kind: 'primary',
        onClick: () => {
          void runUpdate(info);
          return true;
        },
      },
    ],
  });
}

async function runUpdate(info: UpdateView): Promise<void> {
  const result = await guard(`Downloading GTArage ${info.version}…`, () =>
    api.installUpdate(),
  );
  if (!result) return;
  toast(result.message, result.started ? 'ok' : 'warn');
}

// --- speedrunning -----------------------------------------------------------

/** Probe for installed tools and load the resource list, then re-render. */
async function loadSpeedrun(): Promise<void> {
  const s = state;
  if (!s?.currentGameId) return;

  const [tools, groups] = await Promise.all([
    api.speedrunTools(s.currentGameId).catch(() => [] as SpeedrunToolView[]),
    speedrunGroups.length > 0
      ? Promise.resolve(speedrunGroups)
      : api.speedrunResources().catch(() => [] as SpeedrunResourceGroup[]),
  ]);

  // Only re-render if something actually changed, or opening the tab would
  // loop: render -> load -> render.
  const changed =
    tools.length !== speedrunTools.length ||
    tools.some((t, i) => t.installed !== speedrunTools[i]?.installed);
  speedrunTools = tools;
  speedrunGroups = groups;
  if (changed || groups.length !== speedrunGroups.length) render();
}


// --- ScriptHookV setup ------------------------------------------------------

const GAME_LABEL: Record<string, string> = {
  gta5: 'GTA V',
  gta5e: 'GTA V Enhanced',
};



function hookCandidateRow(candidate: HookCandidateView, missing: string[]): HTMLElement {
  const row = el('div', 'diff-row');
  row.appendChild(
    el('div', 'diff-sign', candidate.source === 'downloads' ? 'ZIP' : 'GAME'),
  );

  const main = el('div', 'diff-name');
  main.appendChild(
    el(
      'div',
      '',
      candidate.source === 'downloads'
        ? `In Downloads${candidate.version ? ` · v${candidate.version}` : ''}`
        : 'Already installed in a game folder',
    ),
  );
  main.appendChild(el('div', 'stack-meta', candidate.path));
  if (candidate.contents.length > 0) {
    main.appendChild(el('div', 'stack-meta', candidate.contents.slice(0, 4).join(', ')));
  }
  row.appendChild(main);

  // The same build serves every game, so one copy sets up all of them.
  const targets = candidate.gameId ? [candidate.gameId] : missing;
  const label =
    targets.length > 1
      ? `Set up ${targets.length} games`
      : `Set up ${GAME_LABEL[targets[0] ?? ''] ?? 'this game'}`;

  const use = el('button', 'small-btn is-primary', label);
  use.addEventListener('click', async () => {
    closeModal();
    const result = await guard('Setting up ScriptHookV…', () =>
      api.installHook(candidate.path, targets as GameId[]),
    );
    if (!result) return;
    apply(result.state);
    toast(result.message, 'ok');
    await refresh();
  });
  row.appendChild(use);
  return row;
}



async function adoptGroup(
  group: AdoptGroupView,
  s: AppState,
  quiet = false,
): Promise<void> {
  if (!s.currentGameId) return;
  const result = await guard(`Importing ${group.name}…`, () =>
    api.adopt(s.currentGameId!, group.id),
  );
  if (!result) return;
  apply(result.state);
  if (!quiet) {
    toast(result.message, 'ok');
    await refresh();
  }
}

async function installDependency(dep: ModDependency, s: AppState): Promise<void> {
  if (!dep.essentialId || !s.currentGameId) return;
  const result = await guard(`Fetching ${dep.label}…`, () =>
    api.installDependency(dep.essentialId!, s.currentGameId!),
  );
  if (!result) return;
  apply(result.state);
  toast(result.message, result.imported ? 'ok' : 'warn');
}

/**
 * Everything the library is missing, with the evidence for each.
 *
 * Showing *why* GTArage thinks a dependency exists matters: the detection is
 * good but not infallible, and a user who can see "imports ScriptHookV.dll"
 * can tell that apart from "the readme mentions it".
 */
function showDependencies(s: AppState): void {
  openModal({
    title: 'Mods that need something else first',
    subtitle:
      'Some mods only work if another tool is installed first \u2014 without it they simply do nothing. GTArage works these out by reading the mod files themselves, and shows you the evidence for each so you can judge it.',
    build: (body) => {
      for (const entry of s.missingDeps) {
        body.appendChild(el('div', 'field-label', entry.modName));
        for (const dep of entry.deps) {
          const row = el('div', 'diff-row diff-out');
          row.appendChild(el('div', 'diff-sign', 'NEED'));
          const main = el('div', 'diff-name');
          main.appendChild(el('div', '', dep.label));
          main.appendChild(el('div', 'stack-meta', dep.reason));
          row.appendChild(main);
          if (dep.essentialId) {
            const btn = el('button', 'small-btn is-primary', 'Install');
            btn.addEventListener('click', async () => {
              closeModal();
              await installDependency(dep, s);
            });
            row.appendChild(btn);
          } else {
            row.appendChild(el('div', 'diff-path', 'install manually'));
          }
          body.appendChild(row);
        }
      }
    },
    actions: [
      {
        label: 'Re-scan library',
        onClick: async () => {
          if (!s.currentGameId) return true;
          const next = await guard('Re-scanning…', () =>
            api.rescanDependencies(s.currentGameId!),
          );
          if (next) apply(next);
          return true;
        },
      },
      { label: 'Close', kind: 'primary', onClick: () => true },
    ],
  });
}

function showConflicts(s: AppState): void {
  openModal({
    title: `${s.conflicts.length} file conflict${s.conflicts.length === 1 ? '' : 's'}`,
    subtitle:
      'When two mods change the same file, only one can win: the one lower in the load order. Drag the list on the Load order tab to change who that is.',
    build: (body) => {
      for (const c of s.conflicts.slice(0, 100)) {
        const row = el('div', 'diff-row');
        row.appendChild(el('div', 'diff-sign', 'WIN'));
        const name = el('div', 'diff-name', s.mods.find((m) => m.id === c.winnerId)?.name ?? c.winnerId);
        row.appendChild(name);
        row.appendChild(el('div', 'diff-path', c.target));
        body.appendChild(row);
      }
    },
    actions: [{ label: 'Close', kind: 'primary', onClick: () => true }],
  });
}

// --- first run --------------------------------------------------------------

/**
 * What a new user meets before anything is set up.
 *
 * This replaces a bare "not set up" message. Someone opening a mod manager for
 * the first time needs three things: to know nothing has been changed yet, to
 * know what the whole process is going to be, and to have one obvious button.
 * The steps double as the explanation of how GTArage works, which is where the
 * words "library" and "profile" get introduced -- in context, before they turn
 * up as bare labels elsewhere in the UI.
 */
function renderSetup(s: AppState, view: HTMLElement): void {
  const current = s.games.find((g) => g.id === s.currentGameId);
  const name = current?.name ?? 'your game';
  const anyInstalled = s.games.some((g) => g.installed);

  const card = el('div', 'setup-card');

  card.appendChild(
    el('div', 'ask', anyInstalled ? `Set up ${name}` : 'Welcome to GTArage'),
  );
  card.appendChild(
    el(
      'div',
      'setup-lead',
      anyInstalled
        ? `GTArage has not found ${name} yet. Point it at the folder and it will take care of the rest.`
        : "GTArage keeps your mods in its own folder and only copies them into the game when you ask. Your game folder is not touched until you press Apply, and nothing is ever deleted — so it is safe to experiment.",
    ),
  );

  const steps: Array<[string, string]> = [
    [
      'Find your game',
      'GTArage checks Steam, Epic, the Rockstar launcher and your drives. If it comes up empty, you can point it at the folder yourself.',
    ],
    [
      'Add some mods',
      'Drag in a .zip or a folder, or use Add mod files. Mods go into GTArage\u2019s own library, not into the game.',
    ],
    [
      'Turn them on and press Apply',
      'A profile is just a named set of mods that are switched on. Applying it copies those mods into the game folder, and shows you exactly what will change first.',
    ],
  ];

  const list = el('ol', 'setup-steps');
  for (const [title, body] of steps) {
    const li = el('li');
    li.appendChild(el('div', 'setup-step-title', title));
    li.appendChild(el('div', 'setup-step-body', body));
    list.appendChild(li);
  }
  card.appendChild(list);

  const row = el('div', 'setup-actions');
  const find = el('button', 'small-btn is-primary', 'Find my game');
  find.addEventListener('click', () => void detect_());
  row.appendChild(find);

  const pick = el('button', 'small-btn', 'Choose the folder myself');
  pick.addEventListener('click', () => void browseForGame());
  row.appendChild(pick);
  card.appendChild(row);

  card.appendChild(
    el(
      'div',
      'setup-foot',
      'Nothing on your computer changes until you apply a profile.',
    ),
  );

  view.appendChild(card);
}

// --- empty state ------------------------------------------------------------

function emptyState(
  title: string,
  body: string,
  actionLabel?: string,
  onAction?: () => void,
): HTMLElement {
  const node = el('div', 'empty');
  node.appendChild(el('div', 'empty-title', title));
  node.appendChild(el('div', 'empty-body', body));
  if (actionLabel && onAction) {
    const btn = el('button', 'small-btn is-primary', actionLabel);
    btn.addEventListener('click', onAction);
    node.appendChild(btn);
  }
  return node;
}

// --- actions ----------------------------------------------------------------

function apply(next: AppState): void {
  state = next;
  render();
}

async function refresh(): Promise<void> {
  const next = await api.getState();
  apply(next);
  if (next.currentGameId) {
    void refreshRunning();
    if (runningTimer === null) {
      // Polled, because the game starting or stopping is not something the app
      // is told about. Slow enough to be invisible in a process list.
      runningTimer = window.setInterval(() => void refreshRunning(), 4000);
    }
    saves = await api.listSaves(next.currentGameId);
    // Best-effort: a scan failure must not stop the app from rendering.
    adoptable = await api.scanAdoptable(next.currentGameId).catch(() => []);
    render();
    // The ScriptHookV and speedrun prompts are gone: greeting someone with a
    // modal before they have seen the app is the wrong way to raise either.
    // ScriptHookV needs re-raising somewhere calmer once Browse is rebuilt.
    // Quiet unless there is something to say.
    void checkForUpdate();
  }
}

/**
 * First load, with a visible failure.
 *
 * `render()` does nothing until `state` exists, so an error here used to leave
 * a permanently blank window with no message and no way back. A newcomer would
 * reasonably conclude the app is broken -- so say what happened and offer a
 * retry instead.
 */
async function boot(): Promise<void> {
  try {
    await refresh();
  } catch (err) {
    const view = byId('view');
    clear(view);
    view.appendChild(
      emptyState(
        'GTArage could not start up',
        `Something went wrong while loading your settings: ${(err as Error).message}`,
        'Try again',
        () => void boot(),
      ),
    );
  }
}

async function detect_(): Promise<void> {
  const next = await guard('Looking for games…', () => api.detectGames());
  if (next) {
    apply(next);
    const found = next.games.filter((g) => g.installed).length;
    toast(found ? `Found ${found} game${found === 1 ? '' : 's'}.` : 'No installs found.', found ? 'ok' : 'warn');
  }
}

/**
 * Delete everything GTArage has put on this PC.
 *
 * Gated behind typing the word rather than a plain confirm. Every other
 * destructive action in the app is recoverable from the shelf, and this is the
 * one that removes the shelf - so it should be impossible to reach by
 * clicking through a dialog out of habit.
 */
async function purgeEverything(s: AppState): Promise<void> {
  const typed = await promptModal(
    'Remove GTArage from this PC?',
    'Type REMOVE to confirm',
    '',
  );
  if (typed?.trim().toUpperCase() !== 'REMOVE') {
    if (typed !== null) toast('Nothing was removed.', 'ok');
    return;
  }

  const result = await guard('Removing everything…', () => api.purgeEverything());
  if (!result) return;
  for (const problem of result.problems) toast(problem, 'warn');
  toast(
    `Removed ${result.removed.length} folder(s). GTArage will close.`,
    result.problems.length > 0 ? 'warn' : 'ok',
  );
}

/** Point GTArage at one game folder, whichever game the row is for. */
async function chooseFolderFor(gameId: GameId): Promise<void> {
  const next = await guard('Checking folder…', () => api.browseForGame(gameId));
  if (next) {
    apply(next);
    toast('Game folder set.', 'ok');
  }
}

/** Take every mod back out of one game folder, leaving the library intact. */
async function removeAllMods(gameId: GameId, name: string): Promise<void> {
  const ok = await confirmModal(
    `Put ${name} back to unmodded?`,
    'Every file GTArage installed comes out, and anything it displaced goes back. Your library keeps all the mods, so you can put a setup back whenever you like.',
    'Remove them',
  );
  if (!ok) return;
  const result = await guard('Removing…', () => api.undeployAll(gameId));
  if (!result) return;
  apply(result.state);
  for (const problem of result.problems) toast(problem, 'warn');
  if (result.problems.length === 0) toast(`${name} is back to unmodded.`, 'ok');
}

async function browseForGame(): Promise<void> {
  if (!state?.currentGameId) return;
  const next = await guard('Checking folder…', () => api.browseForGame(state!.currentGameId!));
  if (next) {
    apply(next);
    toast('Game folder set.', 'ok');
  }
}

/**
 * Guard an action that needs a set-up game, explaining the refusal.
 *
 * These handlers used to `return` silently when no game was configured, so on
 * first run several enabled-looking buttons simply did nothing when clicked --
 * the single most confusing thing a new user could meet.
 */
function requireGame(action: string): boolean {
  const current = state?.games.find((g) => g.id === state?.currentGameId);
  if (!state?.currentGameId) {
    toast('Pick a game at the top of the window first.', 'warn');
    return false;
  }
  if (!current?.installed) {
    toast(
      `GTArage needs to know where ${current?.shortName ?? 'the game'} is installed before it can ${action}. Use "Find my game" to set it up.`,
      'warn',
    );
    return false;
  }
  return true;
}

/**
 * Windows cannot show one dialog that takes files *and* folders, so the two
 * are separate actions rather than a single misleading button.
 */
/**
 * One install entry point.
 *
 * Windows genuinely cannot show a picker that accepts files *and* folders, so
 * rather than two buttons that make the user guess which applies, this opens
 * the file picker — which covers essentially every mod, since they arrive as
 * archives — and offers the folder picker from inside the same flow for the
 * already-extracted case.
 */
async function installMod(mode: 'files' | 'folder' = 'files'): Promise<void> {
  if (!requireGame('install mods')) return;
  const result = await guard('Installing…', () => api.importMods(state!.currentGameId!, mode));
  if (!result) return;
  apply(result.state);

  // Nothing chosen and nothing failed means the picker was cancelled. Offer
  // the folder picker rather than leaving the user wondering where folders go.
  if (result.report.imported.length === 0 && result.report.failed.length === 0) {
    if (mode === 'files') offerFolderPicker();
    return;
  }
  reportImport(result.report);
}

function offerFolderPicker(): void {
  openModal({
    title: 'Installing an already-extracted mod?',
    subtitle:
      'Windows cannot offer files and folders in one picker, so folders get their own step.',
    build: (body) => {
      body.appendChild(
        el(
          'div',
          'alert-body',
          'Most mods arrive as a .zip, .rar, .7z or .oiv, and those go through the file picker. Choose a folder here only if you have already unpacked the mod yourself.',
        ),
      );
    },
    actions: [
      { label: 'Cancel', onClick: () => true },
      {
        label: 'Choose a folder',
        kind: 'primary',
        onClick: () => {
          void installMod('folder');
          return true;
        },
      },
    ],
  });
}

async function importPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  if (!requireGame('add mods')) return;
  const result = await guard('Importing…', () =>
    api.importPaths(state!.currentGameId!, paths),
  );
  if (!result) return;
  apply(result.state);
  reportImport(result.report);
}

function reportImport(report: { imported: Array<{ name: string; kind: string; notes: string[] }>; failed: Array<{ source: string; error: string }> }): void {
  for (const fail of report.failed) toast(`${fail.source}: ${fail.error}`, 'error');
  if (report.imported.length > 0) {
    toast(
      `Added ${report.imported.length} mod${report.imported.length === 1 ? '' : 's'}: ` +
        report.imported.map((m) => `${m.name} (${m.kind})`).join(', '),
      'ok',
    );
  }
}

async function backupSaves(): Promise<void> {
  if (!requireGame('back up your saves')) return;
  const list = await guard('Backing up saves…', () =>
    api.backupSaves(state!.currentGameId!, 'manual backup'),
  );
  if (list) {
    saves = list;
    toast(list.length ? 'Saves snapshotted.' : 'No save files found for this game yet.', list.length ? 'ok' : 'warn');
    render();
  }
}

async function verify(): Promise<void> {
  if (!requireGame('check your game folder')) return;
  const report = await guard('Verifying game folder…', () => api.verify(state!.currentGameId!));
  if (!report) return;

  openModal({
    title: report.clean ? 'Your game folder looks right' : 'Your game folder has surprises in it',
    subtitle: report.clean
      ? 'Everything GTArage put in the game folder is still there, and nothing else has appeared.'
      : 'This compares what GTArage put in the game folder against what is actually there now.',
    build: (body) => {
      if (report.missing.length > 0) {
        body.appendChild(
          el('div', 'field-label', 'Gone missing (GTArage installed these, but they are no longer there)'),
        );
        body.appendChild(el('div', 'mono-list', report.missing.join('\n')));
        body.appendChild(
          el(
            'div',
            'alert-body',
            'Something outside GTArage removed these — often a game update or an anti-cheat sweep. Applying your profile again will put them back.',
          ),
        );
      }
      if (report.orphans.length > 0) {
        body.appendChild(
          el('div', 'field-label', 'Mod files GTArage did not put there'),
        );
        body.appendChild(el('div', 'mono-list', report.orphans.join('\n')));
        body.appendChild(
          el(
            'div',
            'alert-body',
            'These are usually left over from installing a mod by hand, before you started using GTArage. GTArage will not touch them, so remove them yourself before playing online.',
          ),
        );
      }
      if (report.clean) {
        body.appendChild(
          el(
            'div',
            'alert-body',
            'No stray mod files (.asi, .dll, .pak, scripts) were found in the folders mods install into. This is the state you want before playing online.',
          ),
        );
      }
    },
    actions: [{ label: 'Close', kind: 'primary', onClick: () => true }],
  });
}

async function goVanilla(s: AppState): Promise<void> {
  const vanilla = s.profiles.find((p) => p.vanillaLock);
  if (!vanilla || !s.currentGameId) return;
  const next = await api.setActiveProfile(s.currentGameId, vanilla.id);
  apply(next);
  await applyProfile();
}

/**
 * Start the game without touching the deployment.
 *
 * Warns first when the profile on disk is not the one selected, since that is
 * the one case where launching does something the user probably did not mean.
 */
/**
 * Start the game, asking first if a copy is already running.
 *
 * Play and Switch-and-play are both one click, and clicking twice used to
 * start a second copy silently — two GTA processes fighting over the same
 * save files and the same mod folder. The prompt defaults to not launching,
 * because the overwhelmingly common case is an impatient second click rather
 * than a deliberate second instance.
 */
async function startGame(gameId: GameId): Promise<void> {
  const launched = await api.launchGame(gameId);
  if (launched.ok) toast('Starting the game…', 'ok');
  else toast(launched.error ?? 'Could not start the game.', 'error');
  // Re-check shortly afterwards so the button can settle on 'Running'.
  window.setTimeout(() => void refreshRunning(), 2500);
}

async function launchOnly(): Promise<void> {
  const s = state;
  if (!s?.currentGameId) return;
  await startGame(s.currentGameId);
}

/** The swap preview, then the deploy. */
async function applyProfile(launch = false): Promise<void> {
  if (!state?.activeProfileId) return;
  const profileId = state.activeProfileId;

  const result = await guard('Applying profile…', () => api.applyProfile(profileId));
  if (!result) return;
  apply(result.state);

  for (const problem of result.report.problems) toast(problem, 'warn');
  const gfx = result.report.graphicsRestored
    ? ' Your saved graphics settings for this profile were restored.'
    : result.report.graphicsCaptured
      ? ' Current graphics settings were saved onto the previous profile.'
      : '';
  toast(
    `Done \u2014 ${result.report.added} file(s) added, ${result.report.removed} removed, ${result.report.kept} left alone.${gfx}`,
    'ok',
  );

  if (launch && state?.currentGameId) {
    await startGame(state.currentGameId);
  }
}


function newProfile(): void {
  if (!state?.currentGameId) return;
  const gameId = state.currentGameId as GameId;
  const profiles = state.profiles;

  openModal({
    title: 'New profile',
    subtitle: 'A profile is a named set of mods that are switched on together \u2014 a \u201cRoleplay\u201d set and a \u201cClean\u201d set, say. Switching between them moves files in and out of your game folder, and never deletes anything.',
    build: (body) => {
      body.appendChild(el('div', 'field-label', 'Name'));
      const input = el('input', 'text-input');
      input.type = 'text';
      input.id = 'new-profile-name';
      input.placeholder = 'Roleplay, Cinematic, Story…';
      body.appendChild(input);

      body.appendChild(el('div', 'field-label', 'Start from'));
      const select = el('select', 'select-input');
      select.id = 'new-profile-from';
      const blank = el('option');
      blank.value = '';
      blank.textContent = 'Empty (all mods off)';
      select.appendChild(blank);
      for (const p of profiles) {
        if (p.vanillaLock) continue;
        const option = el('option');
        option.value = p.id;
        option.textContent = `Copy of ${p.name}`;
        select.appendChild(option);
      }
      body.appendChild(select);
    },
    actions: [
      { label: 'Cancel', onClick: () => true },
      {
        label: 'Create',
        kind: 'primary',
        onClick: async () => {
          const name = (document.getElementById('new-profile-name') as HTMLInputElement).value;
          const from = (document.getElementById('new-profile-from') as HTMLSelectElement).value;
          const next = await guard('Creating…', () =>
            api.createProfile(gameId, name, from || undefined),
          );
          if (next) apply(next);
          return true;
        },
      },
    ],
  });
}

// --- drag and drop ----------------------------------------------------------

/**
 * Real filesystem paths for a drop.
 *
 * Electron 32 removed `File.path`, which is what every drag-and-drop handler
 * used to read; it now comes back as `undefined` and the drop silently does
 * nothing. `webUtils.getPathForFile`, bridged through the preload, is the
 * supported replacement.
 */
function pathsFromDrop(event: DragEvent): string[] {
  const files = [...(event.dataTransfer?.files ?? [])];
  return files
    .map((file) => window.gtarageFiles.getPathForFile(file))
    .filter((p) => Boolean(p));
}

function wireDropzone(node: HTMLElement): void {
  node.addEventListener('dragover', (event) => {
    event.preventDefault();
    node.classList.add('is-hot');
  });
  node.addEventListener('dragleave', () => node.classList.remove('is-hot'));
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    node.classList.remove('is-hot');
    const paths = pathsFromDrop(event);
    void importPaths(paths);
  });
}

// Dropping anywhere in the window imports, not just on the dropzone.
// This must use the same `getPathForFile` bridge as `pathsFromDrop`: it read
// `File.path` until now, which Electron 32 removed, so every drop outside the
// load-order dropzone silently did nothing at all.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
  event.preventDefault();
  const paths = pathsFromDrop(event);
  if (paths.length > 0) void importPaths(paths);
});

// --- master render ----------------------------------------------------------

function render(): void {
  const s = state;
  if (!s) return;

  // The 2a/2b palette is the default; dark is the alternate. The stylesheet
  // redefines only the colour tokens, so everything follows.
  document.documentElement.dataset.theme = s.settings.theme ?? 'light';

  renderCrumbs(s);
  renderTopnav(s);
  renderGamePicker(s);

  const view = byId('view');
  clear(view);

  const current = s.games.find((g) => g.id === s.currentGameId);
  if (!current?.installed) {
    renderSetup(s, view);
    return;
  }

  // Speedrun is opt-in; leaving it selected after it is switched off would
  // strand the user on a screen with no way back that they can see.
  if (!s.settings.speedrunMode && tab === 'speedrun') tab = 'home';

  switch (tab) {
    case 'home':
      renderHome(s, view);
      break;
    case 'profile':
      renderProfile(s, view);
      break;
    case 'speedrun':
      renderSpeedrun(s, view);
      break;
    case 'library':
      renderLibrary(s, view);
      break;
    case 'tools':
      renderTools(s, view);
      break;
    case 'settings':
      renderSettings(s, view);
      break;
    case 'saves':
      renderSaves(s, view);
      break;
  }
}

// --- wiring -----------------------------------------------------------------
//
// Only the chrome is wired here now. In the 2a/2b shell the controls live
// inside the screen that owns them, so there is no permanent action bar,
// toolbar or profile rail to bind - each screen attaches its own handlers as
// it renders.

byId('win-min').addEventListener('click', () => api.windowMinimize());
byId('win-max').addEventListener('click', () => api.windowMaximize());
byId('win-close').addEventListener('click', () => api.windowClose());

byId('game-select').addEventListener('change', async (event) => {
  const gameId = (event.target as HTMLSelectElement).value as GameId;
  const next = await api.selectGame(gameId);
  apply(next);
  saves = await api.listSaves(gameId);
  // Switching game invalidates which setup you were looking at.
  tab = 'home';
  render();
});

byId('modal-scrim').addEventListener('click', (event) => {
  if (event.target === byId('modal-scrim')) closeModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Escape backs out one level, which is the whole navigation model.
    if (!byId('modal-scrim').hidden) {
      closeModal();
      return;
    }
    if (tab !== 'home') {
      tab = 'home';
      render();
    }
    return;
  }

  // Deliberately *not* bound to bare Enter. Applying moves files in and out
  // of the game folder and launches the game; having that on the key people
  // press to dismiss things was far too easy to trigger by accident.
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && byId('modal-scrim').hidden) {
    void applyProfile(true);
  }
});

void boot();


