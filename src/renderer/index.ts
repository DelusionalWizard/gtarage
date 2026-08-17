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

const api = window.swapmeet;

// --- local view state -------------------------------------------------------

/**
 * Settings is not in this list: it lives in the header and opens as its own
 * view, because it is app configuration rather than one of the things you
 * switch between while managing mods.
 */
type TabId =
  | 'home'
  | 'profile'
  | 'order'
  | 'library'
  | 'browse'
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
/** Essentials for the current game, fetched when Browse is opened. */
let essentials: CatalogMod[] = [];
let browseLoading = false;
let sites: ModSite[] = [];
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

window.swapmeetEvents.onProgress(({ done, total, label }) => {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  byId('overlay-fill').style.width = `${pct}%`;
  byId('overlay-detail').textContent = `${done}/${total} · ${label}`;
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
          summary.textContent = 'Swapmeet does not track settings files for this game yet.';
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
        'Drag a mod in anywhere \u2014 a .zip, .rar or .oiv archive, a folder, or a loose file. Or open the Browse tab, where Swapmeet can fetch the essential tools straight from their official release pages. Mods are kept in Swapmeet\u2019s own folder, so your game is not touched until you apply a profile.',
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

function modMenu(mod: Mod): void {
  openModal({
    title: mod.name,
    subtitle: `${mod.kind} · ${mod.files.length} files · ${formatBytes(mod.size)} · added ${formatDate(mod.addedAt)}`,
    build: (body) => {
      body.appendChild(el('div', 'field-label', 'Files'));
      body.appendChild(
        el('div', 'mono-list', mod.files.slice(0, 200).join('\n') +
          (mod.files.length > 200 ? `\n… and ${mod.files.length - 200} more` : '')),
      );
    },
    actions: [
      { label: 'Close', onClick: () => true },
      {
        label: 'Remove from library',
        kind: 'danger',
        onClick: async () => {
          const ok = await confirmModal(
            `Remove "${mod.name}"?`,
            'The mod is undeployed if it is live, then deleted from the library. The original archive you imported from is not touched.',
            'Remove mod',
          );
          if (!ok) return true;
          const next = await guard('Removing…', () => api.removeMod(mod.id));
          if (next) apply(next);
          return true;
        },
      },
    ],
  });
}

// --- rendering: load-order stack -------------------------------------------

function renderOrder(s: AppState, view: HTMLElement): void {
  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  if (!profile) {
    view.appendChild(emptyState('No profile selected', 'Pick a profile from the list on the left.'));
    return;
  }
  if (profile.vanillaLock) {
    view.appendChild(
      emptyState(
        'Vanilla profile',
        'This profile installs no mods at all, which is what makes it safe to play online from. It has no load order because there is nothing to order.',
      ),
    );
    return;
  }

  const stack = el('div', 'stack');
  stack.appendChild(
    el('div', 'stack-hint', 'Drag to reorder. When two mods change the same file, the one lower in this list wins.'),
  );

  const byId2 = new Map(s.mods.map((m) => [m.id, m]));
  const conflicts = conflictMap(s.conflicts);
  let dragging: string | null = null;

  profile.order.forEach((modId, index) => {
    const mod = byId2.get(modId);
    if (!mod) return;
    const enabled = profile.enabled.includes(modId);

    const item = el('div', `stack-item${mod.core ? ' is-core' : ''}`);
    item.draggable = true;
    item.dataset.modId = modId;

    const grip = el('div', 'grip');
    grip.appendChild(el('span'));
    grip.appendChild(el('span'));
    grip.appendChild(el('span'));
    item.appendChild(grip);

    item.appendChild(el('div', 'stack-index', String(index + 1).padStart(2, '0')));

    const main = el('div', 'stack-main');
    main.appendChild(el('div', 'stack-name', mod.name));
    const bits: string[] = [mod.kind];
    if (mod.core) bits.push('core · pinned to top');
    if (!enabled) bits.push('disabled');
    const conflictCount = conflicts.get(modId) ?? 0;
    if (conflictCount > 0) bits.push(`${conflictCount} conflict(s)`);
    main.appendChild(el('div', 'stack-meta', bits.join(' · ')));
    item.appendChild(main);

    const dot = el('div', 'dot');
    dot.classList.add(!enabled ? 'dot-off' : conflicts.has(modId) ? 'dot-warn' : 'dot-ok');
    item.appendChild(dot);

    item.addEventListener('dragstart', () => {
      dragging = modId;
      item.classList.add('is-dragging');
    });
    item.addEventListener('dragend', () => {
      dragging = null;
      item.classList.remove('is-dragging');
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      item.classList.add('is-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('is-over'));
    item.addEventListener('drop', async (event) => {
      event.preventDefault();
      item.classList.remove('is-over');
      if (!dragging || dragging === modId) return;
      const next = await guard('Reordering…', () =>
        api.moveMod(profile.id, dragging!, index),
      );
      if (next) apply(next);
    });

    stack.appendChild(item);
  });

  view.appendChild(stack);
  // No drop target here: installing belongs on the Mods tab, and having two
  // places that accept mods made it unclear which one was "the" way in.
}

// --- shell: breadcrumb + secondary nav --------------------------------------

/**
 * The breadcrumb, which is the whole of this design's navigation state.
 *
 * Design 2a shows a dot and the app name; 2b shows "Swapmeet › <setup>". That
 * is the entire model - one level of drill-down - so there is no tab strip and
 * no profile rail to keep in step with it.
 */
function renderCrumbs(s: AppState): void {
  const host = byId('crumbs');
  clear(host);

  if (tab === 'home') {
    host.appendChild(el('div', 'crumb-dot'));
    host.appendChild(el('div', 'crumb is-current', 'Swapmeet'));
    return;
  }

  const back = el('button', 'crumb', 'Swapmeet');
  back.addEventListener('click', () => {
    tab = 'home';
    render();
  });
  host.appendChild(back);
  host.appendChild(el('div', 'crumb-sep', '›'));

  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  const label =
    tab === 'profile'
      ? (profile?.name ?? 'Setup')
      : tab === 'order'
        ? `${profile?.name ?? 'Setup'} · load order`
        : TAB_LABELS[tab];
  host.appendChild(el('div', 'crumb is-current', label));
}

const TAB_LABELS: Record<string, string> = {
  home: 'Setups',
  library: 'Library',
  browse: 'Browse',
  settings: 'Settings',
  profile: 'Setup',
  order: 'Load order',
  saves: 'Backups',
  speedrun: 'Speedrun',
};

/** The screens that are not part of the drill-down: tools, not places. */
function renderTopnav(s: AppState): void {
  const host = byId('topnav');
  clear(host);

  const items: TabId[] = ['home', 'browse', 'library'];
  if (s.settings.speedrunMode) items.push('speedrun');
  items.push('saves');
  items.push('settings');

  // Load order only makes sense once you are inside a setup that has one.
  if (tab === 'profile' || tab === 'order') items.unshift('order');

  for (const id of items) {
    const btn = el('button', tab === id ? 'is-active' : undefined, TAB_LABELS[id]);
    btn.addEventListener('click', () => {
      tab = id;
      render();
      if (id === 'speedrun') void loadSpeedrun();
      if (id === 'browse') void loadEssentials();
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

  const head = el('div', 'home-head');
  // Which game these setups belong to. Without it the question is ambiguous
  // the moment someone has both Legacy and Enhanced installed.
  head.appendChild(el('div', 'home-game', current?.name ?? ''));
  head.appendChild(el('h1', 'ask', 'Which setup do you want to play?'));
  head.appendChild(
    el(
      'p',
      'lede',
      'Pick a setup and press Play. Swapmeet swaps the mods and your save files for you, and keeps a backup of everything it touches.',
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
    const play = el(
      'button',
      `btn btn-wide ${live ? 'is-blue' : ''}`,
      live ? 'Play now' : 'Switch and play',
    );
    play.addEventListener('click', () => void switchAndPlay(profile));
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
        bits.push(`found ${report.orphans} file(s) Swapmeet did not install`);
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

  main.appendChild(renderPills(s, profile));

  const mods = thingsFor(s, profile);
  if (mods.length === 0) {
    main.appendChild(
      emptyState(
        profile.vanillaLock ? 'Nothing here, on purpose' : 'Nothing in this setup yet',
        profile.vanillaLock
          ? 'The vanilla setup is empty by design.'
          : 'Drag a mod in anywhere, or use Browse to fetch the essentials.',
        profile.vanillaLock ? undefined : 'Add mod files',
        profile.vanillaLock ? undefined : () => installMod('files'),
      ),
    );
  } else {
    const list = el('div', 'things');
    for (const mod of mods) list.appendChild(thingRow(s, profile, mod));
    main.appendChild(list);
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

function thingRow(s: AppState, profile: Profile, mod: Mod): HTMLElement {
  const on = profile.enabled.includes(mod.id);
  const conflicts = conflictMap(s.conflicts).get(mod.id) ?? 0;
  const row = el('div', 'thing');

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
        : `${on} thing${on === 1 ? '' : 's'} on, ${off} off.`,
    ),
  );
  panel.appendChild(head);

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

  const ticks = el('div', 'ticks');
  for (const line of [
    s.settings.backupSavesOnSwap
      ? 'Your save file is copied before every switch'
      : 'Save snapshots are off — turn them on in Settings',
    'Mods are moved, never deleted',
    'You can put the game back to vanilla any time',
  ]) {
    ticks.appendChild(el('div', 'tick', line));
  }
  panel.appendChild(ticks);

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

// --- rendering: browse ------------------------------------------------------







// --- Settings ---------------------------------------------------------------

/**
 * Settings, rebuilt from the mockup.
 *
 * The organising idea is in the design's own title: weight made visible. The
 * three settings that prevent a lost save or a ban are grouped first, marked
 * recommended, and explained in terms of what goes wrong without them. The
 * cosmetic ones come after and look like preferences, because they are.
 */
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
    gameRows.appendChild(row);
  }
  folders.appendChild(gameRows);
  const folderActs = el('div', 'notice-acts');
  const again = el('button', 'btn', 'Search again');
  again.addEventListener('click', () => detect_());
  const choose = el('button', 'btn', 'Choose folder');
  choose.addEventListener('click', () => browseForGame());
  folderActs.append(again, choose);
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

// --- Browse -------------------------------------------------------------------

/**
 * Browse, rebuilt from the mockup.
 *
 * Three ways a mod arrives, and the design's argument is that they should look
 * as different as they behave: a file you already have is a drop target, the
 * Essentials are things Swapmeet installs itself, and a community site is a
 * handoff where all it can do is catch what you download. The old version gave
 * all three the same card and a search box, which implied a catalogue that
 * does not exist.
 */
function renderBrowse(s: AppState, view: HTMLElement): void {
  const page = el('div', 'browse');

  const head = el('div', 'home-head');
  head.appendChild(el('h1', 'ask', 'Add mods to your library'));
  head.appendChild(
    el(
      'p',
      'lede',
      'Nothing here touches your game. Anything added lands in the library, and you put it in a setup afterwards.',
    ),
  );
  page.appendChild(head);

  // 1. A file you already have.
  const drop = el('button', 'drop');
  drop.appendChild(el('div', 'drop-plus', '+'));
  const dropMain = el('div', 'note-main');
  dropMain.appendChild(el('div', 'note-title', 'Drop a file you already downloaded'));
  dropMain.appendChild(
    el(
      'div',
      'note-body',
      '.zip, .rar, .7z, .oiv or a folder. This is how most mods arrive — Swapmeet works out what kind it is and where its files belong.',
    ),
  );
  drop.appendChild(dropMain);
  drop.appendChild(el('div', 'site-go', 'Choose a file'));
  drop.addEventListener('click', () => installMod('files'));
  wireDropzone(drop);
  page.appendChild(drop);

  // 2. Essentials.
  const essHead = el('div', 'group-head');
  essHead.appendChild(el('div', 'group-title', 'Essentials'));
  essHead.appendChild(el('div', 'group-badge', 'INSTALLED BY SWAPMEET'));
  page.appendChild(essHead);
  page.appendChild(
    el(
      'div',
      'group-blurb',
      'The pieces that let other mods run. Swapmeet installs these itself, from the official release pages.',
    ),
  );

  const ess = el('div', 'ess');
  if (browseLoading) {
    ess.appendChild(el('div', 'ess-row', 'Checking the release pages…'));
  } else if (essentials.length === 0) {
    ess.appendChild(el('div', 'ess-row', 'Nothing to show for this game.'));
  } else {
    for (const mod of essentials) ess.appendChild(essentialRow(s, mod));
  }
  page.appendChild(ess);

  // 3. The handoff.
  const handoff = el('div', 'handoff');
  const hHead = el('div', 'group-head');
  hHead.appendChild(el('div', 'group-title', 'Community sites'));
  handoff.appendChild(hHead);
  handoff.appendChild(
    el(
      'div',
      'group-blurb',
      'These have no install button. Swapmeet opens the site, you download the way you normally would, and it catches the file.',
    ),
  );
  const steps = el('div', 'steps');
  const labels = ['1 OPENS IN A WINDOW', '2 YOU LOG IN AND DOWNLOAD', '3 SWAPMEET CATCHES IT'];
  labels.forEach((label, i) => {
    steps.appendChild(el('div', 'step', label));
    if (i < labels.length - 1) steps.appendChild(el('div', 'step-arrow', '→'));
  });
  handoff.appendChild(steps);

  const siteGrid = el('div', 'sites');
  for (const site of sites) {
    const card = el('button', 'site');
    const main = el('div', 'site-main');
    main.appendChild(el('div', 'site-name', site.name));
    main.appendChild(el('div', 'site-note', site.loginNote ?? 'no account needed'));
    card.appendChild(main);
    card.appendChild(el('div', 'site-go', 'Open ↗'));
    card.addEventListener('click', () => {
      void api.openSite(site.id, s.currentGameId!).catch((err: Error) => toast(err.message, 'error'));
    });
    siteGrid.appendChild(card);
  }
  handoff.appendChild(siteGrid);
  page.appendChild(handoff);

  view.appendChild(page);
}

function essentialRow(s: AppState, mod: CatalogMod): HTMLElement {
  const row = el('div', 'ess-row');
  const main = el('div', 'ess-main');

  const name = el('div', 'ess-name');
  name.appendChild(document.createTextNode(mod.name));

  // One badge, saying the most useful thing about this row's state. The
  // provider already resolves what is installed, so no name matching here.
  const installed = Boolean(mod.installedModId);
  const outdated = installed && mod.installedVersion !== undefined && mod.installedVersion !== mod.version;
  const neededBy = s.missingDeps.find((d) =>
    d.deps.some((dep) => mod.name.toLowerCase().includes(dep.capability.toLowerCase().slice(0, 6))),
  );
  if (neededBy) {
    name.appendChild(el('span', 'tag is-warn', `NEEDED BY ${neededBy.modName.toUpperCase()}`));
  } else if (outdated) {
    name.appendChild(el('span', 'tag is-warn', `UPDATE ${mod.version}`));
  } else if (installed) {
    name.appendChild(el('span', 'tag is-ok', 'INSTALLED'));
  }
  main.appendChild(name);

  if (mod.summary) main.appendChild(el('div', 'ess-blurb', mod.summary));
  const meta: string[] = [];
  if (mod.version) meta.push(mod.version);
  if (mod.installedVersion) meta.push(`you have ${mod.installedVersion}`);
  if (mod.manualOnly) meta.push(mod.manualReason ?? 'download it yourself');
  if (meta.length > 0) main.appendChild(el('div', 'ess-meta', meta.join(' · ')));
  row.appendChild(main);

  const act = el(
    'button',
    installed && !outdated ? 'btn' : 'btn is-blue',
    outdated ? 'Update' : installed ? 'Reinstall' : 'Install',
  );
  act.addEventListener('click', () => void installEssential(mod));
  row.appendChild(act);
  return row;
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
  search.placeholder = `Search ${mods.length} mods`;
  search.value = librarySearch;
  search.addEventListener('input', () => {
    librarySearch = search.value;
    renderLibraryRows(s, rowHost);
  });
  bar.appendChild(search);

  const pills = el('div', 'lib-pills');
  const filters: Array<[string, string]> = [
    ['all', 'Everything'],
    ...(unused.length > 0
      ? ([['unused', `In no setup · ${unused.length}`]] as Array<[string, string]>)
      : []),
    ['plays', 'How it plays'],
    ['looks', 'How it looks'],
    ['files', 'Game files'],
    ['core', 'Needed to run mods'],
  ];
  for (const [id, label] of filters) {
    if (id !== 'all' && id !== 'unused' && libraryMods(s, id, '').length === 0) continue;
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
      case 'unused':
        return setupsUsing(s, mod.id).length === 0;
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
    title.appendChild(el('span', 'tag', plainKind(mod.kind)));
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
      `lib-col-used${used.length === 0 ? ' is-unused' : ''}`,
      used.length === 0
        ? 'In no setup'
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
  head.appendChild(el('div', 'lib-detail-name', mod.name));
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
  const free = usable.filter((p) => !p.order.includes(mod.id));
  if (free.length > 0) {
    const add = el('select', 'lib-add') as HTMLSelectElement;
    const placeholder = el('option', undefined, 'Add to another setup');
    placeholder.value = '';
    add.appendChild(placeholder);
    for (const profile of free) {
      const option = el('option', undefined, profile.name);
      option.value = profile.id;
      add.appendChild(option);
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

  // --- the one irreversible action ------------------------------------------
  const danger = el('div', 'lib-danger');
  danger.appendChild(el('div', 'lib-danger-h', 'Delete from the library for good?'));
  const body = el('div', 'lib-danger-body');
  if (needers.length > 0) {
    body.appendChild(
      document.createTextNode(
        needers.length === 1
          ? 'Another mod needs this to run: '
          : `${needers.length} of your mods need this to run, including `,
      ),
    );
    body.appendChild(el('b', undefined, needers[0]!.name));
    body.appendChild(
      document.createTextNode(
        needers.length === 1
          ? '. It would stop working, and the files leave your disk. Swapmeet cannot undo this one.'
          : '. They would stop working, and the files leave your disk. Swapmeet cannot undo this one.',
      ),
    );
  } else {
    body.appendChild(
      document.createTextNode(
        used.length > 0
          ? `It would come out of ${used.length} setup${used.length === 1 ? '' : 's'}, and the files leave your disk. Swapmeet cannot undo this one.`
          : 'No setup uses it. The files leave your disk — Swapmeet cannot undo this one.',
      ),
    );
  }
  danger.appendChild(body);

  const acts = el('div', 'lib-danger-acts');
  const del = el('button', 'lib-delete', 'Delete for good');
  del.addEventListener('click', async () => {
    const next = await guard('Deleting…', () => api.removeMod(mod.id));
    if (next) {
      librarySelection = null;
      apply(next);
      toast(`${mod.name} deleted from the library.`, 'ok');
    }
  });
  acts.appendChild(del);
  const keep = el('button', 'btn', 'Keep it');
  keep.addEventListener('click', () => toast('Nothing was deleted.', 'ok'));
  acts.appendChild(keep);
  danger.appendChild(acts);
  panel.appendChild(danger);

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

  const first = el('div', 'note-card lib-empty-card');
  const firstMain = el('div', 'note-main');
  firstMain.appendChild(el('div', 'note-title', 'Start with the essentials'));
  firstMain.appendChild(
    el('div', 'note-body', 'The few pieces that let other mods run. Swapmeet installs these itself.'),
  );
  first.appendChild(firstMain);
  const openBrowse = el('button', 'btn is-blue btn-wide', 'Open Browse');
  openBrowse.addEventListener('click', () => {
    tab = 'browse';
    render();
    void loadEssentials();
  });
  first.appendChild(openBrowse);
  cards.appendChild(first);

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
 * A launcher and a directory, not a wrapper. Swapmeet does not reimplement
 * LiveSplit or download installers on your behalf — it finds what you already
 * have, starts it, and links what it cannot install.
 */
function renderSpeedrun(s: AppState, view: HTMLElement): void {
  const cards = el('div', 'cards');

  // --- tools ----------------------------------------------------------------
  const toolCard = el('div', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('div', 'card-title', 'Tools'));
  head.appendChild(
    el('div', 'card-count', `${speedrunTools.filter((t) => t.installed).length} installed`),
  );
  toolCard.appendChild(head);

  if (speedrunTools.length === 0) {
    toolCard.appendChild(el('div', 'card-body', 'Looking…'));
  }

  for (const tool of speedrunTools) {
    const row = el('div', 'setting');
    const main = el('div', 'setting-main');

    const title = el('div', 'setting-name', tool.name);
    if (tool.core) {
      const tag = el('span', 'inline-tag', 'essential');
      title.appendChild(tag);
    }
    main.appendChild(title);
    main.appendChild(el('div', 'setting-desc', tool.summary));
    if (tool.path) main.appendChild(el('div', 'gfx-path', tool.path));
    row.appendChild(main);

    if (tool.installed) {
      const start = el('button', 'small-btn is-primary', 'Start');
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
      // Portable tools (LiveSplit especially) live wherever the user put
      // them, so probing will never find them.
      const locate = el('button', 'small-btn', 'Locate…');
      locate.title = 'Point Swapmeet at it if you already have it';
      locate.addEventListener('click', async () => {
        if (!s.currentGameId) return;
        const tools = await guard('Looking…', () =>
          api.locateSpeedrunTool(tool.id, s.currentGameId!),
        );
        if (tools) {
          speedrunTools = tools;
          render();
        }
      });
      row.appendChild(locate);

      const get = el('button', 'small-btn', 'Get it');
      get.addEventListener('click', () => {
        void api.openExternal(tool.url).catch((err: Error) => toast(err.message, 'error'));
      });
      row.appendChild(get);
    }

    toolCard.appendChild(row);
  }
  cards.appendChild(toolCard);

  // --- practice profile -----------------------------------------------------
  const practice = el('div', 'card');
  const phead = el('div', 'card-head');
  phead.appendChild(el('div', 'card-title', 'Practice mods'));
  practice.appendChild(phead);
  practice.appendChild(
    el(
      'div',
      'card-body',
      'Practice mods must never be in a submitted run. Keep them in their own profile, and switching back to a clean game is one click — which is the whole reason a profile manager is useful here.',
    ),
  );

  const hasPractice = s.profiles.some((p) => p.name === PRACTICE_PROFILE);
  const prow = el('div', 'setting');
  const pmain = el('div', 'setting-main');
  pmain.appendChild(el('div', 'setting-name', `"${PRACTICE_PROFILE}" profile`));
  pmain.appendChild(
    el(
      'div',
      'setting-desc',
      hasPractice
        ? 'Ready. Install practice mods into it, and apply the vanilla profile before a real attempt.'
        : 'Not created yet. Swapmeet can make an empty one to keep practice mods separate.',
    ),
  );
  prow.appendChild(pmain);
  if (!hasPractice) {
    const make = el('button', 'small-btn is-primary', 'Create it');
    make.addEventListener('click', async () => {
      if (!s.currentGameId) return;
      const next = await guard('Creating…', () =>
        api.createProfile(s.currentGameId!, PRACTICE_PROFILE),
      );
      if (next) {
        apply(next);
        toast(`"${PRACTICE_PROFILE}" profile created.`, 'ok');
      }
    });
    prow.appendChild(make);
  }
  practice.appendChild(prow);
  cards.appendChild(practice);

  // --- resources ------------------------------------------------------------
  for (const group of speedrunGroups) {
    const card = el('div', 'card');
    const gh = el('div', 'card-head');
    gh.appendChild(el('div', 'card-title', group.title));
    card.appendChild(gh);
    card.appendChild(el('div', 'card-body', group.blurb));

    for (const item of group.items) {
      const row = el('div', 'setting');
      const main = el('div', 'setting-main');
      const name = el('div', 'setting-name', item.name);
      if (item.discord) name.appendChild(el('span', 'inline-tag', 'discord'));
      main.appendChild(name);
      if (item.note) main.appendChild(el('div', 'setting-desc', item.note));
      row.appendChild(main);

      const open = el('button', 'small-btn', 'Open');
      open.addEventListener('click', () => {
        void api.openExternal(item.url).catch((err: Error) => toast(err.message, 'error'));
      });
      row.appendChild(open);
      card.appendChild(row);
    }
    cards.appendChild(card);
  }

  view.appendChild(cards);
}

// --- rendering: saves -------------------------------------------------------

function renderSaves(s: AppState, view: HTMLElement): void {
  const cards = el('div', 'cards');

  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('div', 'card-title', 'Save snapshots'));
  head.appendChild(el('div', 'card-count', `${saves.length} kept`));
  head.appendChild(el('div', 'card-spacer'));

  const openSaves = el('button', 'small-btn', 'Open saves folder');
  openSaves.title = "Open the game's own save folder in Explorer";
  openSaves.addEventListener('click', () => {
    if (s.currentGameId) {
      void api.openPath('saves', s.currentGameId).catch((err: Error) => toast(err.message, 'error'));
    }
  });
  head.appendChild(openSaves);

  // Backing up lives here, next to the snapshots it produces, rather than in
  // the action bar where it sat between the two buttons people actually use.
  const backupBtn = el('button', 'small-btn is-primary', 'Snapshot now');
  backupBtn.addEventListener('click', () => backupSaves());
  head.appendChild(backupBtn);
  card.appendChild(head);

  if (saves.length === 0) {
    card.appendChild(
      el(
        'div',
        'card-body',
        'No snapshots yet. Swapmeet takes one automatically before every profile swap, so this fills itself in as you use the app.',
      ),
    );
  } else {
    for (const snap of saves) {
      const row = el('div', 'card-row');
      const main = el('div', 'setting-main');
      main.appendChild(el('div', 'setting-name', snap.label));
      // Two different times, and the difference matters: the snapshot time is
      // when you swapped profiles, the save time is how far along the save
      // itself actually is.
      main.appendChild(
        el('div', 'setting-desc', `Snapshot taken ${formatExact(snap.createdAt)}`),
      );
      main.appendChild(
        el(
          'div',
          'setting-desc',
          snap.savedAt
            ? `Game last saved ${formatExact(snap.savedAt)}`
            : 'Game save time unknown',
        ),
      );
      main.appendChild(
        el(
          'div',
          'setting-desc',
          `${snap.fileCount} file${snap.fileCount === 1 ? '' : 's'} · ${formatBytes(snap.size)}`,
        ),
      );
      row.appendChild(main);

      const restore = el('button', 'small-btn', 'Restore');
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
      card.appendChild(row);
    }
  }

  cards.appendChild(card);
  view.appendChild(cards);
}

// --- rendering: settings ----------------------------------------------------


// --- rendering: inspector ---------------------------------------------------


// --- updates ----------------------------------------------------------------

/** Set once an update has been offered this session, so it asks only once. */
let updateOffered = false;

/**
 * Check for a newer Swapmeet.
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
    if (manual) toast(`Swapmeet ${info.current} is the latest version.`, 'ok');
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
    title: `Swapmeet ${info.version} is available`,
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
  const result = await guard(`Downloading Swapmeet ${info.version}…`, () =>
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
 * Showing *why* Swapmeet thinks a dependency exists matters: the detection is
 * good but not infallible, and a user who can see "imports ScriptHookV.dll"
 * can tell that apart from "the readme mentions it".
 */
function showDependencies(s: AppState): void {
  openModal({
    title: 'Mods that need something else first',
    subtitle:
      'Some mods only work if another tool is installed first \u2014 without it they simply do nothing. Swapmeet works these out by reading the mod files themselves, and shows you the evidence for each so you can judge it.',
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
 * The steps double as the explanation of how Swapmeet works, which is where the
 * words "library" and "profile" get introduced -- in context, before they turn
 * up as bare labels elsewhere in the UI.
 */
function renderSetup(s: AppState, view: HTMLElement): void {
  const current = s.games.find((g) => g.id === s.currentGameId);
  const name = current?.name ?? 'your game';
  const anyInstalled = s.games.some((g) => g.installed);

  const card = el('div', 'card setup-card');

  card.appendChild(
    el('div', 'card-title', anyInstalled ? `Set up ${name}` : 'Welcome to Swapmeet'),
  );
  card.appendChild(
    el(
      'div',
      'setup-lead',
      anyInstalled
        ? `Swapmeet has not found ${name} yet. Point it at the folder and it will take care of the rest.`
        : "Swapmeet keeps your mods in its own folder and only copies them into the game when you ask. Your game folder is not touched until you press Apply, and nothing is ever deleted — so it is safe to experiment.",
    ),
  );

  const steps: Array<[string, string]> = [
    [
      'Find your game',
      'Swapmeet checks Steam, Epic, the Rockstar launcher and your drives. If it comes up empty, you can point it at the folder yourself.',
    ],
    [
      'Add some mods',
      'Drag in a .zip or a folder, or use the Browse tab to get the essential tools straight from their official release pages. Mods go into Swapmeet\u2019s own library, not into the game.',
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
    // ScriptHookV needs re-raising somewhere calmer once Browse is remade.
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
        'Swapmeet could not start up',
        `Something went wrong while loading your settings: ${(err as Error).message}`,
        'Try again',
        () => void boot(),
      ),
    );
  }
}

/**
 * Downloads captured by the embedded mod-site browser arrive here, not
 * through a call the UI made, so they get their own listener.
 */
window.swapmeetEvents.onSiteEvent((event) => {
  if (event.kind === 'progress') {
    // Progress used to go to the action bar, which this shell does not have.
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

async function detect_(): Promise<void> {
  const next = await guard('Looking for games…', () => api.detectGames());
  if (next) {
    apply(next);
    const found = next.games.filter((g) => g.installed).length;
    toast(found ? `Found ${found} game${found === 1 ? '' : 's'}.` : 'No installs found.', found ? 'ok' : 'warn');
  }
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
      `Swapmeet needs to know where ${current?.shortName ?? 'the game'} is installed before it can ${action}. Use "Find my game" to set it up.`,
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
      ? 'Everything Swapmeet put in the game folder is still there, and nothing else has appeared.'
      : 'This compares what Swapmeet put in the game folder against what is actually there now.',
    build: (body) => {
      if (report.missing.length > 0) {
        body.appendChild(
          el('div', 'field-label', 'Gone missing (Swapmeet installed these, but they are no longer there)'),
        );
        body.appendChild(el('div', 'mono-list', report.missing.join('\n')));
        body.appendChild(
          el(
            'div',
            'alert-body',
            'Something outside Swapmeet removed these — often a game update or an anti-cheat sweep. Applying your profile again will put them back.',
          ),
        );
      }
      if (report.orphans.length > 0) {
        body.appendChild(
          el('div', 'field-label', 'Mod files Swapmeet did not put there'),
        );
        body.appendChild(el('div', 'mono-list', report.orphans.join('\n')));
        body.appendChild(
          el(
            'div',
            'alert-body',
            'These are usually left over from installing a mod by hand, before you started using Swapmeet. Swapmeet will not touch them, so remove them yourself before playing online.',
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
    .map((file) => window.swapmeetFiles.getPathForFile(file))
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
    case 'order':
      renderOrder(s, view);
      break;
    case 'speedrun':
      renderSpeedrun(s, view);
      break;
    case 'library':
      renderLibrary(s, view);
      break;
    case 'browse':
      renderBrowse(s, view);
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

/**
 * Fetch the Essentials for the current game.
 *
 * Only when Browse is on screen: this is a network round trip to the release
 * pages, and doing it on every launch would be a cost nobody asked for.
 */
async function loadEssentials(): Promise<void> {
  const s = state;
  if (!s?.currentGameId) return;
  browseLoading = true;
  render();
  try {
    const result = await api.browse({
      gameId: s.currentGameId,
      providerId: 'essentials',
      sort: 'trending',
      search: '',
    });
    essentials = result.mods;
    sites = await api.listSites(s.currentGameId);
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    browseLoading = false;
    render();
  }
}

/** Install one Essential, picking its file for the current game. */
async function installEssential(mod: CatalogMod): Promise<void> {
  const s = state;
  if (!s?.currentGameId) return;
  const files = await guard('Finding the download…', () =>
    api.catalogFiles(mod, s.currentGameId!),
  );
  const chosen = files?.[0];
  if (!chosen) {
    toast('No download is published for this game.', 'warn');
    return;
  }
  const result = await guard(`Installing ${mod.name}…`, () =>
    api.installCatalogFile(mod, chosen, s.currentGameId!),
  );
  if (!result) return;
  apply(result.state);
  toast(result.message, result.imported ? 'ok' : 'warn');
}
