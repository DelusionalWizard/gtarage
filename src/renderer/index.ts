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
type TabId = 'mods' | 'order' | 'browse' | 'speedrun' | 'saves' | 'settings';

let state: AppState | null = null;
let tab: TabId = 'mods';
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
/** Timer used while waiting for a ScriptHookV download to appear. */
let hookWatchTimer: number | null = null;

// Browser tab state
let provider: ProviderId = 'essentials';
let browseSort: BrowseSort = 'trending';
let browseSearch = '';
let browseResult: BrowseResult | null = null;
let browseLoading = false;
let sites: ModSite[] = [];

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

function renderTitlebar(s: AppState): void {
  const select = byId<HTMLSelectElement>('game-select');
  clear(select);

  const byEra = new Map<GameView['era'], GameView[]>();
  for (const game of s.games) {
    const list = byEra.get(game.era);
    if (list) list.push(game);
    else byEra.set(game.era, [game]);
  }

  for (const [era, games] of byEra) {
    const group = el('optgroup');
    group.label = ERA_LABEL[era];
    for (const game of games) {
      const option = el('option');
      option.value = game.id;
      option.textContent = game.installed
        ? `${game.shortName} · ${game.modCount} mods`
        : `${game.shortName} — not found`;
      option.selected = game.id === s.currentGameId;
      group.appendChild(option);
    }
    select.appendChild(group);
  }

  const current = s.games.find((g) => g.id === s.currentGameId);
  const note = current
    ? current.installed
      ? `${current.name}${current.version ? ` · ${current.version}` : ''}`
      : `${current.name} — not detected`
    : 'No game selected';
  byId('app-version').textContent = `v${s.appVersion}`;

  const noteEl = byId('game-note');
  noteEl.textContent = note;
  // Capped at 40vw and ellipsised, so keep the full text on hover.
  noteEl.title = current?.path ? `${note}\n${current.path}` : note;
}

// --- rendering: sidebar -----------------------------------------------------

function renderSidebar(s: AppState): void {
  const list = byId('profile-list');
  clear(list);

  if (s.profiles.length === 0) {
    list.appendChild(
      el('div', 'profile-meta', 'No profiles yet \u2014 set up a game to get started.'),
    );
  }

  for (const profile of s.profiles) {
    const enabledCount = profile.enabled.length;
    const bytes = s.mods
      .filter((m) => profile.enabled.includes(m.id))
      .reduce((sum, m) => sum + m.size, 0);

    const row = el('button', `profile${profile.id === s.activeProfileId ? ' is-active' : ''}`);
    const main = el('div', 'profile-main');
    const nameEl = el('div', 'profile-name', profile.name);
    nameEl.title = profile.name; // ellipsised when long
    main.appendChild(nameEl);
    main.appendChild(
      el(
        'div',
        'profile-meta',
        profile.vanillaLock
          ? 'no mods · safe for online'
          : `${enabledCount} mod${enabledCount === 1 ? '' : 's'} · ${formatBytes(bytes)}`,
      ),
    );
    row.appendChild(main);

    if (s.deployed?.profileId === profile.id) {
      row.appendChild(el('div', 'badge badge-live', 'LIVE'));
    } else if (profile.vanillaLock) {
      row.appendChild(el('div', 'badge badge-lock', 'SAFE'));
    }

    row.addEventListener('click', async () => {
      if (!s.currentGameId) return;
      const next = await api.setActiveProfile(s.currentGameId, profile.id);
      apply(next);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      profileMenu(profile);
    });

    list.appendChild(row);
  }

  const current = s.games.find((g) => g.id === s.currentGameId);
  byId('game-path').textContent = current?.path ?? 'Not set up';

  const status = byId('game-status');
  clear(status);
  const dot = el('div', 'dot');
  let label: string;
  if (!current?.installed) {
    dot.classList.add('dot-off');
    label = 'game not set up yet';
  } else if (s.deployed) {
    dot.classList.add('dot-warn');
    label = `${s.deployed.fileCount} mod files installed`;
  } else {
    dot.classList.add('dot-ok');
    label = 'clean — no mods installed';
  }
  status.appendChild(dot);
  status.appendChild(el('span', '', label));
}

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

function renderChips(s: AppState): void {
  const chips = byId('chips');
  clear(chips);

  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  const conflicts = conflictMap(s.conflicts);
  const categories = [...new Set(s.mods.map((m) => m.category))].sort();

  const defs: Array<{ id: string; label: string; alert?: boolean }> = [
    { id: 'all', label: `all ${s.mods.length}` },
    { id: 'enabled', label: `on ${profile?.enabled.length ?? 0}` },
    ...categories.map((c) => ({
      id: c,
      label: `${c} ${s.mods.filter((m) => m.category === c).length}`,
    })),
  ];
  if (conflicts.size > 0) {
    defs.push({ id: 'conflicts', label: `conflicts ${s.conflicts.length}`, alert: true });
  }

  for (const def of defs) {
    const chip = el(
      'button',
      `chip${filter === def.id ? ' is-active' : ''}${def.alert ? ' is-alert' : ''}`,
      def.label,
    );
    chip.addEventListener('click', () => {
      filter = def.id;
      render();
    });
    chips.appendChild(chip);
  }
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

// --- rendering: browse ------------------------------------------------------

/**
 * The mod browser.
 *
 * Two halves, because mods come from two kinds of place. The top is an
 * in-app listing of the sources with real APIs (the curated Essentials
 * catalog, and Nexus). The bottom opens the big community sites in a proper
 * browser window, where the user logs in themselves and Swapmeet only catches
 * the resulting download.
 */
function renderBrowse(s: AppState, view: HTMLElement): void {
  const cards = el('div', 'cards');

  // --- provider switch ------------------------------------------------------
  const bar = el('div', 'browse-bar');

  const providers: Array<{ id: ProviderId; label: string }> = [
    { id: 'essentials', label: 'Essentials' },
    { id: 'nexus', label: 'Nexus Mods' },
  ];
  const switcher = el('div', 'seg');
  for (const p of providers) {
    const btn = el('button', `seg-btn${provider === p.id ? ' is-active' : ''}`, p.label);
    btn.addEventListener('click', () => {
      provider = p.id;
      browseResult = null;
      render();
      void loadBrowse();
    });
    switcher.appendChild(btn);
  }
  bar.appendChild(switcher);

  const searchBox = el('div', 'search');
  searchBox.appendChild(el('span', 'search-slash', '/'));
  const input = el('input');
  input.type = 'search';
  input.placeholder = provider === 'nexus' ? 'filter this feed…' : 'filter essentials…';
  input.value = browseSearch;
  input.addEventListener('input', () => {
    browseSearch = input.value;
    void loadBrowse();
  });
  searchBox.appendChild(input);
  bar.appendChild(searchBox);

  if (provider === 'nexus') {
    const sortSel = el('select', 'mini-select');
    for (const [value, label] of [
      ['trending', 'Trending'],
      ['latest', 'Latest added'],
      ['updated', 'Recently updated'],
    ] as Array<[BrowseSort, string]>) {
      const option = el('option');
      option.value = value;
      option.textContent = label;
      option.selected = browseSort === value;
      sortSel.appendChild(option);
    }
    sortSel.addEventListener('change', () => {
      browseSort = sortSel.value as BrowseSort;
      void loadBrowse();
    });
    bar.appendChild(sortSel);
  }

  const refresh = el('button', 'small-btn', 'Refresh');
  refresh.addEventListener('click', async () => {
    await api.refreshCatalog();
    void loadBrowse();
  });
  bar.appendChild(refresh);
  cards.appendChild(bar);

  // --- listing --------------------------------------------------------------
  if (browseLoading) {
    cards.appendChild(el('div', 'card-body', 'Loading…'));
  } else if (browseResult?.needsSetup) {
    const box = el('div', 'alert alert-warn');
    box.appendChild(el('div', 'alert-title', 'Nexus needs an API key'));
    box.appendChild(el('div', 'alert-body', browseResult.error ?? ''));
    const actions = el('div', 'alert-actions');
    const setKey = el('button', 'small-btn is-primary', 'Add API key');
    setKey.addEventListener('click', () => nexusKeyModal());
    actions.appendChild(setKey);
    const openNexus = el('button', 'small-btn', 'Or just browse Nexus');
    openNexus.addEventListener('click', () => {
      if (s.currentGameId) void api.openSite('nexus', s.currentGameId);
    });
    actions.appendChild(openNexus);
    box.appendChild(actions);
    cards.appendChild(box);
  } else if (browseResult?.error) {
    const box = el('div', 'alert alert-warn');
    box.appendChild(el('div', 'alert-title', 'That provider is unavailable'));
    box.appendChild(el('div', 'alert-body', browseResult.error));
    cards.appendChild(box);
  } else if (browseResult) {
    if (provider === 'nexus' && s.nexus) {
      cards.appendChild(
        el(
          'div',
          'browse-note',
          `Signed in as ${s.nexus.name}${s.nexus.premium ? ' (Premium — direct downloads work)' : ' — direct API downloads need Premium, so Swapmeet will open the mod page and catch the download'}. The Nexus API has no full-text search, so this box filters the feed rather than searching the site.`,
        ),
      );
    }
    if (browseResult.mods.length === 0) {
      cards.appendChild(el('div', 'card-body', 'Nothing matched.'));
    }
    for (const mod of browseResult.mods) {
      cards.appendChild(catalogCard(mod, s));
    }
  }

  // --- the site browser -----------------------------------------------------
  const siteCard = el('div', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('div', 'card-title', 'Browse the mod sites'));
  head.appendChild(el('div', 'card-spacer'));
  siteCard.appendChild(head);
  siteCard.appendChild(
    el(
      'div',
      'card-body',
      'These sites have no public API, so Swapmeet opens them in a real browser window instead of pretending to index them. You log in and browse normally; when you start a download, Swapmeet catches the file and imports it into the library automatically. Your password is never seen by Swapmeet.',
    ),
  );

  for (const site of sites) {
    const row = el('div', 'card-row');
    const main = el('div', 'setting-main');
    const title = el('div', 'setting-name', site.name);
    if (site.docsOnly) {
      const tag = el('span', 'inline-tag', 'docs only');
      title.appendChild(tag);
    }
    main.appendChild(title);
    main.appendChild(
      el('div', 'setting-desc', site.loginNote ? `${site.blurb} ${site.loginNote}` : site.blurb),
    );
    row.appendChild(main);

    const openIn = el('button', 'small-btn is-primary', site.docsOnly ? 'Read' : 'Open');
    openIn.addEventListener('click', () => {
      if (s.currentGameId) void api.openSite(site.id, s.currentGameId);
    });
    row.appendChild(openIn);

    const external = el('button', 'small-btn', '↗');
    external.title = 'Open in my normal browser instead';
    external.addEventListener('click', () => {
      void api.openExternal(site.home).catch((err: Error) => toast(err.message, 'error'));
    });
    row.appendChild(external);

    siteCard.appendChild(row);
  }
  cards.appendChild(siteCard);

  view.appendChild(cards);
}

/** One mod in the browser listing. */
function catalogCard(mod: CatalogMod, s: AppState): HTMLElement {
  const card = el('div', 'card');

  const head = el('div', 'card-head');
  const title = el('div', 'card-title', mod.name);
  head.appendChild(title);
  head.appendChild(el('div', 'card-count', mod.version));
  if (mod.installedModId) {
    const badge = el(
      'div',
      'badge badge-live',
      mod.installedVersion && mod.installedVersion !== mod.version ? 'UPDATE' : 'INSTALLED',
    );
    head.appendChild(badge);
  }
  head.appendChild(el('div', 'card-spacer'));
  head.appendChild(el('div', 'card-count', mod.author));
  card.appendChild(head);

  card.appendChild(el('div', 'card-body', mod.summary || 'No description.'));

  const row = el('div', 'card-row');
  const meta = el('div', 'setting-main');
  const bits: string[] = [];
  if (mod.updatedAt) bits.push(`updated ${formatDate(mod.updatedAt)}`);
  if (mod.endorsements) bits.push(`${mod.endorsements} endorsements`);
  if (mod.files.length > 0) bits.push(`${mod.files.length} file(s)`);
  meta.appendChild(el('div', 'setting-desc', bits.join(' · ')));
  row.appendChild(meta);

  const page = el('button', 'small-btn', 'Open page');
  page.addEventListener('click', () => {
    void api.openExternal(mod.url).catch((err: Error) => toast(err.message, 'error'));
  });
  row.appendChild(page);

  if (mod.manualOnly) {
    const why = el('button', 'small-btn', 'Why?');
    why.addEventListener('click', () => {
      openModal({
        title: `${mod.name} has to be downloaded by hand`,
        build: (body) => {
          body.appendChild(el('div', 'alert-body', mod.manualReason ?? ''));
        },
        actions: [
          { label: 'Close', onClick: () => true },
          {
            label: 'Open the site',
            kind: 'primary',
            onClick: () => {
              void api.openExternal(mod.url);
              return true;
            },
          },
        ],
      });
    });
    row.appendChild(why);
  } else {
    const install = el('button', 'small-btn is-primary', mod.installedModId ? 'Reinstall' : 'Install');
    install.addEventListener('click', () => void installFromCatalog(mod, s));
    row.appendChild(install);
  }

  card.appendChild(row);
  return card;
}

async function installFromCatalog(mod: CatalogMod, s: AppState): Promise<void> {
  if (!s.currentGameId) return;
  const gameId = s.currentGameId;

  let files = mod.files;
  if (files.length === 0) {
    const fetched = await guard('Getting file list…', () => api.catalogFiles(mod, gameId));
    if (!fetched) return;
    files = fetched;
  }

  if (files.length === 0) {
    toast(`${mod.name} has no downloadable files. Open its page instead.`, 'warn');
    return;
  }

  const chosen = files.length === 1 ? files[0]! : await pickFile(mod, files);
  if (!chosen) return;

  if (chosen.executable) {
    const ok = await confirmModal(
      `${chosen.name} is an installer`,
      'Swapmeet will download it but will not run it or import it — installers have to be run by you, deliberately. Continue?',
      'Download it',
    );
    if (!ok) return;
  }

  const result = await guard(`Downloading ${chosen.name}…`, () =>
    api.installCatalogFile(mod, chosen, gameId),
  );
  if (!result) return;

  apply(result.state);
  toast(result.message, result.imported ? 'ok' : 'warn');
  void loadBrowse();
}

function pickFile(mod: CatalogMod, files: CatalogFile[]): Promise<CatalogFile | null> {
  return new Promise((resolve) => {
    let selected = files.find((f) => f.primary) ?? files[0]!;
    openModal({
      title: `Choose a file for ${mod.name}`,
      subtitle: 'Release pages often carry debug builds and extras alongside the main download.',
      build: (body) => {
        for (const file of files) {
          const row = el('div', 'diff-row');
          const radio = el('input');
          radio.type = 'radio';
          radio.name = 'catalog-file';
          radio.checked = file.id === selected.id;
          radio.addEventListener('change', () => {
            selected = file;
          });
          row.appendChild(radio);
          const name = el('div', 'diff-name', file.name);
          row.appendChild(name);
          const tags: string[] = [];
          if (file.size) tags.push(formatBytes(file.size));
          if (file.executable) tags.push('installer');
          if (file.primary) tags.push('main');
          row.appendChild(el('div', 'diff-path', tags.join(' · ')));
          body.appendChild(row);
        }
      },
      actions: [
        { label: 'Cancel', onClick: () => (resolve(null), true) },
        { label: 'Download', kind: 'primary', onClick: () => (resolve(selected), true) },
      ],
    });
  });
}

async function loadBrowse(): Promise<void> {
  const s = state;
  if (!s?.currentGameId) return;
  browseLoading = true;
  render();
  try {
    browseResult = await api.browse({
      gameId: s.currentGameId,
      providerId: provider,
      sort: browseSort,
      search: browseSearch,
    });
  } catch (err) {
    browseResult = { mods: [], error: (err as Error).message };
  } finally {
    browseLoading = false;
    render();
  }
}

function nexusKeyModal(): void {
  openModal({
    title: 'Connect Nexus Mods',
    subtitle:
      'Generate a personal API key on nexusmods.com under Account settings → API keys, then paste it here. It is stored encrypted with your Windows credential store, never in plain text.',
    build: (body) => {
      body.appendChild(el('div', 'field-label', 'Personal API key'));
      const input = el('input', 'text-input');
      input.type = 'password';
      input.id = 'nexus-key';
      input.placeholder = 'paste your key';
      body.appendChild(input);

      const link = el('button', 'small-btn', 'Open the Nexus API key page');
      link.addEventListener('click', () => {
        void api.openExternal('https://www.nexusmods.com/users/myaccount?tab=api');
      });
      body.appendChild(link);
    },
    actions: [
      { label: 'Cancel', onClick: () => true },
      {
        label: 'Connect',
        kind: 'primary',
        onClick: async () => {
          const input = document.getElementById('nexus-key') as HTMLInputElement;
          const result = await guard('Checking the key…', () => api.setNexusKey(input.value));
          if (!result) return true;
          if (result.error) {
            toast(result.error, 'error');
            return true;
          }
          apply(result.state);
          toast(
            `Connected to Nexus as ${result.account?.name}${result.account?.premium ? ' (Premium)' : ''}.`,
            'ok',
          );
          void loadBrowse();
          return true;
        },
      },
    ],
  });
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

function renderSettings(s: AppState, view: HTMLElement): void {
  const cards = el('div', 'cards');

  const toggles = el('div', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('div', 'card-title', 'Behaviour'));
  toggles.appendChild(head);

  const addToggle = (
    name: string,
    desc: string,
    value: boolean,
    key:
      | 'backupSavesOnSwap'
      | 'useHardlinks'
      | 'blockWhileGameRunning'
      | 'warnAboutOnline'
      | 'graphicsPerProfile'
      | 'speedrunMode',
  ) => {
    const row = el('div', 'setting');
    const main = el('div', 'setting-main');
    main.appendChild(el('div', 'setting-name', name));
    main.appendChild(el('div', 'setting-desc', desc));
    row.appendChild(main);
    const sw = el('button', `switch${value ? ' is-on' : ''}`);
    sw.appendChild(el('div', 'switch-knob'));
    sw.addEventListener('click', async () => {
      const next = await guard('Saving…', () => api.updateSettings({ [key]: !value }));
      if (next) apply(next);
    });
    row.appendChild(sw);
    toggles.appendChild(row);
  };

  addToggle(
    'Snapshot saves before every swap',
    'Copies the game save folder into the shelf before applying a profile.',
    s.settings.backupSavesOnSwap,
    'backupSavesOnSwap',
  );
  addToggle(
    'Use hard links',
    'Deploys files as hard links instead of copies, so profiles cost almost no extra disk space. Only works when the library and the game are on the same drive.',
    s.settings.useHardlinks,
    'useHardlinks',
  );
  addToggle(
    'Refuse to deploy while the game is running',
    'Writing into a running game corrupts the install. Only the game executable counts — having Steam or the Rockstar launcher open is fine.',
    s.settings.blockWhileGameRunning,
    'blockWhileGameRunning',
  );
  // --- appearance -----------------------------------------------------------
  const themeRow = el('div', 'setting');
  const themeMain = el('div', 'setting-main');
  themeMain.appendChild(el('div', 'setting-name', 'Theme'));
  themeMain.appendChild(el('div', 'setting-desc', 'Dark suits a games library; light suits a bright room.'));
  themeRow.appendChild(themeMain);
  const themeSel = el('select', 'mini-select');
  for (const [value, label] of [
    ['dark', 'Dark'],
    ['light', 'Light'],
  ] as Array<['dark' | 'light', string]>) {
    const option = el('option');
    option.value = value;
    option.textContent = label;
    option.selected = (s.settings.theme ?? 'dark') === value;
    themeSel.appendChild(option);
  }
  themeSel.addEventListener('change', async () => {
    const next = await guard('Saving…', () =>
      api.updateSettings({ theme: themeSel.value as 'dark' | 'light' }),
    );
    if (next) apply(next);
  });
  themeRow.appendChild(themeSel);
  toggles.appendChild(themeRow);

  addToggle(
    'Speedrunning mode',
    'Adds a Speedrun tab with the timer, frame limiter and capture tools, plus the community routing guides and split files. Off by default — most people modding for fun have no use for it.',
    s.settings.speedrunMode,
    'speedrunMode',
  );

  addToggle(
    'Give each profile its own graphics settings',
    'Saves the game settings onto the profile you are leaving and restores the one you switch to, so a modded profile can run different settings from a vanilla one without reconfiguring every launch.',
    s.settings.graphicsPerProfile,
    'graphicsPerProfile',
  );
  addToggle(
    'Warn before applying mods to a game with online play',
    'Off by default, because GTA V asks you to choose story or online on every launch, so this would fire on every swap. Turn it on if you actually play online.',
    s.settings.warnAboutOnline,
    'warnAboutOnline',
  );

  const limitRow = el('div', 'setting');
  const limitMain = el('div', 'setting-main');
  limitMain.appendChild(el('div', 'setting-name', 'Save snapshots to keep'));
  limitMain.appendChild(el('div', 'setting-desc', 'Oldest snapshots beyond this are pruned.'));
  limitRow.appendChild(limitMain);
  const limitInput = el('input', 'number-input');
  limitInput.type = 'number';
  limitInput.min = '1';
  limitInput.value = String(s.settings.saveBackupLimit);
  limitInput.addEventListener('change', async () => {
    const value = Math.max(1, Number(limitInput.value) || 1);
    const next = await guard('Saving…', () => api.updateSettings({ saveBackupLimit: value }));
    if (next) apply(next);
  });
  limitRow.appendChild(limitInput);
  toggles.appendChild(limitRow);
  cards.appendChild(toggles);

  // The folder check lives here now: it is a maintenance tool you reach for
  // occasionally, not something that belongs in the action bar next to the
  // buttons used on every visit.
  const checks = el('div', 'card');
  const chead = el('div', 'card-head');
  chead.appendChild(el('div', 'card-title', 'Game folder'));
  checks.appendChild(chead);

  const checkRow = el('div', 'setting');
  const checkMain = el('div', 'setting-main');
  checkMain.appendChild(el('div', 'setting-name', 'Check the game folder'));
  checkMain.appendChild(
    el(
      'div',
      'setting-desc',
      'Looks for mod files in your game folder that Swapmeet did not install — usually left behind by a manual install — and for anything it expected that has gone missing.',
    ),
  );
  checkRow.appendChild(checkMain);
  const checkBtn = el('button', 'small-btn is-primary', 'Check now');
  checkBtn.disabled = !s.games.find((g) => g.id === s.currentGameId)?.installed;
  checkBtn.addEventListener('click', () => verify());
  checkRow.appendChild(checkBtn);
  checks.appendChild(checkRow);

  const undeployRow = el('div', 'setting');
  const undeployMain = el('div', 'setting-main');
  undeployMain.appendChild(el('div', 'setting-name', 'Remove all mods from the game folder'));
  undeployMain.appendChild(
    el(
      'div',
      'setting-desc',
      'Takes every file Swapmeet installed back out and restores anything it displaced. Your library and profiles are untouched.',
    ),
  );
  undeployRow.appendChild(undeployMain);
  const undeployBtn = el('button', 'danger-btn', 'Remove all');
  undeployBtn.disabled = !s.deployed;
  undeployBtn.addEventListener('click', async () => {
    if (!s.currentGameId) return;
    const ok = await confirmModal(
      'Remove every installed mod?',
      'This puts your game folder back the way Swapmeet found it. Nothing is deleted from your library.',
      'Remove all',
    );
    if (!ok) return;
    const result = await guard('Removing…', () => api.undeployAll(s.currentGameId!));
    if (!result) return;
    apply(result.state);
    for (const problem of result.problems) toast(problem, 'warn');
    toast('Game folder returned to vanilla.', 'ok');
  });
  undeployRow.appendChild(undeployBtn);
  checks.appendChild(undeployRow);
  cards.appendChild(checks);

  const folders = el('div', 'card');
  const fhead = el('div', 'card-head');
  fhead.appendChild(el('div', 'card-title', 'Folders'));
  folders.appendChild(fhead);

  const addFolder = (name: string, value: string, which: 'library' | 'shelf' | 'config' | 'game') => {
    const row = el('div', 'setting');
    const main = el('div', 'setting-main');
    main.appendChild(el('div', 'setting-name', name));
    main.appendChild(el('div', 'setting-desc', value));
    row.appendChild(main);
    const open = el('button', 'small-btn', 'Open');
    open.addEventListener('click', () => api.openPath(which, s.currentGameId ?? undefined));
    row.appendChild(open);
    folders.appendChild(row);
  };

  addFolder('Mod library', s.libraryPath, 'library');
  addFolder('Shelf (displaced files, snapshots)', s.shelfPath, 'shelf');
  addFolder('Config', 'swapmeet.config.json', 'config');
  cards.appendChild(folders);

  const about = el('div', 'card');
  const ahead = el('div', 'card-head');
  ahead.appendChild(el('div', 'card-title', 'About'));
  about.appendChild(ahead);
  about.appendChild(
    el(
      'div',
      'card-body',
      'Swapmeet is an open-source universal mod manager for the Grand Theft Auto games, released under the MIT licence. It manages GTA III, Vice City and San Andreas (original and Definitive Edition), GTA IV, and GTA V Legacy and Enhanced.',
    ),
  );
  cards.appendChild(about);

  view.appendChild(cards);
}

// --- rendering: inspector ---------------------------------------------------

function renderInspector(s: AppState): void {
  const insp = byId('inspector');
  clear(insp);

  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  const current = s.games.find((g) => g.id === s.currentGameId);

  // Needs attention
  const attention = el('div');
  attention.appendChild(el('div', 'insp-label', 'Needs attention'));

  // A damaged settings file outranks everything: the app looks freshly
  // installed to someone who had a library a minute ago, and they need to know
  // their profiles were not thrown away before they start rebuilding them.
  if (s.configError) {
    const box = el('div', 'alert alert-warn');
    box.appendChild(el('div', 'alert-title', 'Your settings could not be read'));
    box.appendChild(el('div', 'alert-body', s.configError.message));
    box.appendChild(
      el(
        'div',
        'alert-body',
        'Your mod files are untouched. The damaged file was kept, so nothing is lost for good.',
      ),
    );
    const actions = el('div', 'alert-actions');
    const show = el('button', 'small-btn', 'Show me the file');
    show.addEventListener('click', () => void api.openPath('config'));
    actions.appendChild(show);
    box.appendChild(actions);
    attention.appendChild(box);
  }

  if (!current?.installed) {
    const box = el('div', 'alert alert-warn');
    box.appendChild(el('div', 'alert-title', 'No game folder yet'));
    box.appendChild(
      el(
        'div',
        'alert-body',
        'Swapmeet could not find this game on its own. Search again, or point it at the folder the game is installed in.',
      ),
    );
    const actions = el('div', 'alert-actions');
    const detect = el('button', 'small-btn is-primary', 'Find my game');
    detect.addEventListener('click', () => detect_());
    actions.appendChild(detect);
    const browse = el('button', 'small-btn', 'Choose folder…');
    browse.addEventListener('click', () => browseForGame());
    actions.appendChild(browse);
    box.appendChild(actions);
    attention.appendChild(box);
  } else if (adoptable.filter((g) => !g.alreadyInLibrary).length > 0) {
    // Ranked above everything else: until these are imported, the library is
    // not a true picture of what the game is actually loading.
    const pending = adoptable.filter((g) => !g.alreadyInLibrary);
    const first = pending[0]!;

    const box = el('div', 'alert alert-warn');
    box.appendChild(
      el(
        'div',
        'alert-title',
        pending.length === 1
          ? `${first.name} is installed but not managed`
          : `${pending.length} mods are installed but not managed`,
      ),
    );
    box.appendChild(
      el(
        'div',
        'alert-body',
        `Swapmeet found ${first.name} already in your game folder — someone installed it by hand. Import it and Swapmeet can switch it on and off with your profiles. Your existing files are left exactly where they are.`,
      ),
    );

    const actions = el('div', 'alert-actions');
    const importBtn = el('button', 'small-btn is-primary', `Import ${first.name}`);
    importBtn.addEventListener('click', () => void adoptGroup(first, s));
    actions.appendChild(importBtn);
    if (pending.length > 1) {
      const all = el('button', 'small-btn', 'Import all');
      all.addEventListener('click', async () => {
        for (const group of pending) await adoptGroup(group, s, true);
        await refresh();
        toast(`Imported ${pending.length} mods from your game folder.`, 'ok');
      });
      actions.appendChild(all);
    }
    const ignore = el('button', 'small-btn', 'Not now');
    ignore.addEventListener('click', () => {
      adoptable = [];
      render();
    });
    actions.appendChild(ignore);
    box.appendChild(actions);
    attention.appendChild(box);
  } else if (s.missingDeps.length > 0) {
    // A missing script hook outranks a file conflict: with one, nothing loads
    // at all, and the conflict is academic.
    const total = s.missingDeps.reduce((n, entry) => n + entry.deps.length, 0);
    const first = s.missingDeps[0]!;

    const box = el('div', 'alert alert-warn');
    box.appendChild(
      el(
        'div',
        'alert-title',
        total === 1 ? 'A mod is missing a prerequisite' : `${total} prerequisites missing`,
      ),
    );

    const body = el('div', 'alert-body');
    body.appendChild(
      document.createTextNode(
        `${first.modName} needs ${first.deps.map((d) => d.label).join(' and ')}. `,
      ),
    );
    body.appendChild(el('em', '', first.deps[0]?.reason ?? ''));
    box.appendChild(body);

    const actions = el('div', 'alert-actions');
    const installable = first.deps.find((d) => d.essentialId);
    if (installable) {
      const btn = el('button', 'small-btn is-primary', `Install ${installable.label}`);
      btn.addEventListener('click', () => void installDependency(installable, s));
      actions.appendChild(btn);
    }
    const seeAll = el('button', 'small-btn', 'See all');
    seeAll.addEventListener('click', () => showDependencies(s));
    actions.appendChild(seeAll);
    box.appendChild(actions);
    attention.appendChild(box);
  } else if (s.conflicts.length > 0) {
    const first = s.conflicts[0]!;
    const winner = s.mods.find((m) => m.id === first.winnerId);
    const losers = first.modIds
      .filter((id) => id !== first.winnerId)
      .map((id) => s.mods.find((m) => m.id === id)?.name ?? id);

    const box = el('div', 'alert alert-warn');
    box.appendChild(
      el(
        'div',
        'alert-title',
        s.conflicts.length === 1
          ? 'Two mods write the same file'
          : `${s.conflicts.length} file conflicts`,
      ),
    );
    const body = el('div', 'alert-body');
    body.appendChild(document.createTextNode(`${losers.join(', ')} and ${winner?.name ?? '?'} both write `));
    body.appendChild(el('code', '', first.target));
    body.appendChild(
      document.createTextNode(
        `. ${winner?.name ?? 'The last one'} wins, because it sits lower in the load order.`,
      ),
    );
    box.appendChild(body);

    const actions = el('div', 'alert-actions');
    const openOrder = el('button', 'small-btn is-primary', 'Open load order');
    openOrder.addEventListener('click', () => {
      tab = 'order';
      render();
    });
    actions.appendChild(openOrder);
    const showAll = el('button', 'small-btn', 'See all');
    showAll.addEventListener('click', () => showConflicts(s));
    actions.appendChild(showAll);
    box.appendChild(actions);
    attention.appendChild(box);
  } else if (s.settings.warnAboutOnline && current.hasOnline && s.deployed && !profile?.vanillaLock) {
    const box = el('div', 'alert alert-warn');
    box.appendChild(el('div', 'alert-title', 'Modded files are live'));
    box.appendChild(
      el(
        'div',
        'alert-body',
        `${current.shortName} has an online mode, and modded files can get you banned from it. Switch to the Vanilla profile and apply it before you play online.`,
      ),
    );
    box.appendChild(el('div', 'alert-actions')).appendChild(
      (() => {
        const btn = el('button', 'small-btn is-primary', 'Go vanilla');
        btn.addEventListener('click', () => goVanilla(s));
        return btn;
      })(),
    );
    attention.appendChild(box);
  } else {
    const box = el('div', 'alert alert-ok');
    box.appendChild(el('div', 'alert-title', 'All good'));
    box.appendChild(
      el(
        'div',
        'alert-body',
        s.deployed
          ? `${s.deployed.profileName} is installed in your game folder, with no mods fighting over the same file.`
          : 'Your game folder is untouched. Switch some mods on, then press Apply & launch to put them in.',
      ),
    );
    attention.appendChild(box);
  }
  insp.appendChild(attention);

  // Profile stats
  const stats = el('div');
  stats.appendChild(el('div', 'insp-label', 'Profile'));

  const addStat = (label: string, value: string, tone?: 'good' | 'warn') => {
    const row = el('div', 'stat-row');
    row.appendChild(el('span', '', label));
    row.appendChild(
      el('span', `stat-value${tone ? ` is-${tone}` : ''}`, value),
    );
    stats.appendChild(row);
  };

  addStat('Mods enabled', `${profile?.enabled.length ?? 0} / ${s.mods.length}`);
  addStat('Size on disk', formatBytes(s.activeBytes));
  addStat(
    'In the game folder',
    s.deployed ? `${s.deployed.fileCount} files` : 'nothing yet',
    s.deployed ? 'warn' : 'good',
  );
  addStat('Last applied', s.deployed ? formatDate(s.deployed.deployedAt) : '—');
  addStat(
    'Save backup',
    s.settings.backupSavesOnSwap ? 'automatic' : 'off',
    s.settings.backupSavesOnSwap ? 'good' : 'warn',
  );
  insp.appendChild(stats);

  insp.appendChild(el('div', 'insp-spacer'));

  if (current) {
    insp.appendChild(el('div', 'note-box', current.notes));
  }
  insp.appendChild(
    el(
      'div',
      'note-box',
      'Applying a profile copies mods into your game folder. If a mod would overwrite one of the game\u2019s own files, Swapmeet moves the original somewhere safe first \u2014 it is put back when you switch profiles. Nothing is ever deleted.',
    ),
  );
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

/**
 * Offer speedrunning mode once, and only to someone who looks like a runner.
 *
 * Asking everybody would be noise. Project 127 being installed is a strong
 * signal: it exists solely to put GTA V on the version the Classic category
 * is run on, so nobody has it by accident.
 */
async function maybePromptForSpeedrun(): Promise<void> {
  const s = state;
  if (!s || s.settings.speedrunMode || s.settings.speedrunAsked) return;

  const tools = await api.speedrunTools(s.currentGameId ?? 'gta5').catch(() => []);
  const p127 = tools.find((t) => t.id === 'project127' && t.installed);
  if (!p127) return;

  openModal({
    title: 'Set up for speedrunning?',
    subtitle:
      'Project 127 is installed, which is the launcher the Classic category runs on — so this looks like a speedrunning setup.',
    build: (body) => {
      body.appendChild(
        el(
          'div',
          'alert-body',
          'Speedrunning mode adds a Speedrun tab: start LiveSplit, RivaTuner, OBS and Project 127 from here, and reach the community routing guides, split files and practice mods without hunting through bookmarks.',
        ),
      );
      body.appendChild(
        el(
          'div',
          'alert-body',
          'It also makes the point that practice mods belong in their own profile, so switching back to a clean game before a real attempt is one click.',
        ),
      );
      const found = tools.filter((t) => t.installed).map((t) => t.name);
      if (found.length > 0) {
        body.appendChild(el('div', 'field-label', 'Already installed'));
        body.appendChild(el('div', 'mono-list', found.join('\n')));
      }
    },
    actions: [
      {
        label: 'No thanks',
        onClick: async () => {
          const next = await api.updateSettings({ speedrunAsked: true });
          apply(next);
          return true;
        },
      },
      {
        label: 'Turn it on',
        kind: 'primary',
        onClick: async () => {
          const next = await guard('Enabling…', () =>
            api.updateSettings({ speedrunMode: true, speedrunAsked: true }),
          );
          if (next) {
            apply(next);
            tab = 'speedrun';
            render();
            void loadSpeedrun();
          }
          return true;
        },
      },
    ],
  });
}

// --- ScriptHookV setup ------------------------------------------------------

const GAME_LABEL: Record<string, string> = {
  gta5: 'GTA V',
  gta5e: 'GTA V Enhanced',
};

/**
 * Offer to set up ScriptHookV when a game that needs it does not have it.
 *
 * Shown once per session. If a copy is already on the machine this is a
 * single click; otherwise it opens the official page and then watches for the
 * download to land, so the user never has to come back and find the file.
 */
async function maybePromptForHook(): Promise<void> {
  if (hookPromptSettled) return;
  const status = await api.hookStatus().catch(() => null);
  if (!status || status.missingFor.length === 0) {
    hookPromptSettled = true;
    return;
  }
  hookPromptSettled = true;
  showHookPrompt(status);
}

function showHookPrompt(status: HookStatus): void {
  const missing = status.missingFor;
  const names = missing.map((g) => GAME_LABEL[g] ?? g).join(' and ');
  const verb = missing.length > 1 ? 'need' : 'needs';

  // One download covers every game, so every candidate is usable everywhere.
  const usable = status.candidates;

  openModal({
    title: `${names} ${verb} ScriptHookV`,
    subtitle:
      'Almost every GTA V script mod depends on it, and the same download works for both Legacy and Enhanced. Its author publishes it from his own site rather than through an API, so Swapmeet cannot fetch it for you — but it can take it from here once you have it.',
    build: (body) => {
      if (usable.length > 0) {
        body.appendChild(el('div', 'field-label', 'Found on this machine'));
        for (const candidate of usable) {
          body.appendChild(hookCandidateRow(candidate, missing));
        }
        body.appendChild(
          el(
            'div',
            'alert-body',
            'Check the version is recent enough for your game build — a ScriptHookV from before your last game update will not load.',
          ),
        );
      } else {
        body.appendChild(
          el(
            'div',
            'alert-body',
            missing.length > 1
              ? 'Download it once, then come back — Swapmeet watches your Downloads folder and will offer to set up both games from the same file.'
              : 'Download it, then come back — Swapmeet watches your Downloads folder and will offer to install it the moment it appears.',
          ),
        );
      }

      if (status.presentFor.length > 0) {
        const have = status.presentFor.map((g) => GAME_LABEL[g] ?? g).join(' and ');
        body.appendChild(
          el('div', 'alert-body', `${have} already has ScriptHookV in your library.`),
        );
      }
    },
    actions: [
      { label: 'Not now', onClick: () => true },
      {
        label: 'Open the download page',
        kind: 'primary',
        onClick: () => {
          void api.openExternal(status.url).catch((err: Error) => toast(err.message, 'error'));
          watchForHookDownload();
          toast('Watching your Downloads folder — I will offer to install it when it arrives.', 'ok');
          return true;
        },
      },
    ],
  });
}

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

/**
 * Poll for a ScriptHookV archive appearing in Downloads.
 *
 * Polling rather than watching: the user is off in a browser, this only runs
 * while they are mid-setup, and it stops itself after a few minutes so it
 * never becomes a background cost.
 */
function watchForHookDownload(): void {
  if (hookWatchTimer !== null) return;
  const startedAt = Date.now();

  hookWatchTimer = window.setInterval(async () => {
    // Give up after five minutes; they can retry from Settings.
    if (Date.now() - startedAt > 5 * 60 * 1000) {
      stopHookWatch();
      return;
    }

    const status = await api.hookStatus().catch(() => null);
    if (!status || status.missingFor.length === 0) {
      stopHookWatch();
      return;
    }

    const fresh = status.candidates.filter(
      (c) =>
        c.source === 'downloads' &&
        (c.gameId === null || status.missingFor.includes(c.gameId)) &&
        Date.parse(c.modifiedAt) >= startedAt - 60_000,
    );
    if (fresh.length === 0) return;

    stopHookWatch();
    showHookPrompt({ ...status, candidates: fresh });
  }, 4000);
}

function stopHookWatch(): void {
  if (hookWatchTimer !== null) {
    window.clearInterval(hookWatchTimer);
    hookWatchTimer = null;
  }
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
    saves = await api.listSaves(next.currentGameId);
    sites = await api.listSites(next.currentGameId);
    // Best-effort: a scan failure must not stop the app from rendering.
    adoptable = await api.scanAdoptable(next.currentGameId).catch(() => []);
    render();
    // Offered after the first render so the app is on screen behind it.
    // The hook prompt goes first: without ScriptHookV nothing loads at all,
    // which matters more than a tab of convenience links.
    await maybePromptForHook();
    void maybePromptForSpeedrun();
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
    const pct = event.total ? Math.round(((event.received ?? 0) / event.total) * 100) : 0;
    byId('action-status').textContent = `Downloading ${event.fileName} — ${pct}%`;
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
async function launchOnly(): Promise<void> {
  const s = state;
  if (!s?.currentGameId) return;

  const selected = s.profiles.find((p) => p.id === s.activeProfileId);
  const deployedId = s.deployed?.profileId ?? null;
  const mismatch = selected && deployedId !== selected.id;

  if (mismatch) {
    const ok = await confirmModal(
      'Launch without applying?',
      s.deployed
        ? `Your game folder currently has "${s.deployed.profileName}" installed, but "${selected.name}" is selected. Launching now runs ${s.deployed.profileName}.`
        : `No mods are installed in your game folder right now, but "${selected.name}" is selected. Launching now runs the game unmodded.`,
      'Launch anyway',
    );
    if (!ok) return;
  }

  const launched = await api.launchGame(s.currentGameId);
  if (launched.ok) toast('Starting the game…', 'ok');
  else toast(launched.error ?? 'Could not start the game.', 'error');
}

/** The swap preview, then the deploy. */
async function applyProfile(launch = false): Promise<void> {
  if (!state?.activeProfileId) return;
  const profileId = state.activeProfileId;

  const plan = await guard('Working out what would change…', () => api.planSwap(profileId));
  if (!plan) return;

  const proceed = await showSwapPlan(plan, launch);
  if (!proceed) return;

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
    const launched = await api.launchGame(state.currentGameId);
    if (!launched.ok) toast(launched.error ?? 'Could not start the game.', 'error');
  }
}

/** Renders 1c's swap diff as the confirmation step. */
function showSwapPlan(plan: SwapPlan, launch: boolean): Promise<boolean> {
  const s = state!;
  const toName = s.profiles.find((p) => p.id === plan.toProfileId)?.name ?? 'profile';
  const moving = plan.filesIn + plan.filesOut;

  return new Promise((resolve) => {
    openModal({
      title:
        moving === 0
          ? 'Nothing to change'
          : `Here is what will change (${moving} file${moving === 1 ? '' : 's'} move, nothing is deleted)`,
      subtitle:
        `Switching to ${toName}. Mods leaving your game folder are put back in Swapmeet's library, ` +
        `and ${plan.filesKept} file(s) are in both profiles so they stay exactly where they are.` +
        (plan.bytesToWrite > 0 ? ` About ${formatBytes(plan.bytesToWrite)} to write.` : ''),
      build: (body) => {
        if (plan.blockers.length > 0) {
          body.appendChild(
            el(
              'div',
              'blocker-lead',
              plan.blockers.length === 1
                ? 'This has to be sorted out before you can apply:'
                : 'These have to be sorted out before you can apply:',
            ),
          );
        }
        for (const blocker of plan.blockers) {
          body.appendChild(el('div', 'blocker', blocker));
        }
        for (const warning of plan.warnings) {
          body.appendChild(el('div', 'warning', warning));
        }
        if (plan.entries.length === 0) {
          body.appendChild(
            el(
              'div',
              'alert-body',
              'Your game folder already matches this profile, so there is nothing to move.',
            ),
          );
        } else {
          body.appendChild(
            el(
              'div',
              'diff-legend',
              'IN = copied into your game folder \u00b7 OUT = taken back out \u00b7 KEEP = in both profiles, left alone',
            ),
          );
        }
        for (const entry of plan.entries) {
          const row = el('div', `diff-row diff-${entry.kind}`);
          row.appendChild(
            el('div', 'diff-sign', entry.kind === 'in' ? 'IN' : entry.kind === 'out' ? 'OUT' : 'KEEP'),
          );
          row.appendChild(el('div', 'diff-name', entry.name));
          row.appendChild(el('div', 'diff-path', `${entry.fileCount} files ${entry.path}`));
          body.appendChild(row);
        }
      },
      actions: [
        { label: 'Cancel', onClick: () => (resolve(false), true) },
        {
          label: launch ? 'Apply and launch' : 'Apply',
          kind: 'primary',
          disabled: plan.blockers.length > 0,
          onClick: () => (resolve(true), true),
        },
      ],
    });
  });
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

  // Theme is a data attribute on the root; the stylesheet redefines only the
  // colour tokens, so everything follows without a second stylesheet.
  document.documentElement.dataset.theme = s.settings.theme ?? 'dark';

  renderTitlebar(s);
  renderSidebar(s);
  renderInspector(s);

  for (const btn of document.querySelectorAll<HTMLElement>('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  }

  // The search/filter toolbar only makes sense on the mods tab.
  byId('toolbar').hidden = tab !== 'mods';
  if (tab === 'mods') renderChips(s);

  const view = byId('view');
  clear(view);

  const current = s.games.find((g) => g.id === s.currentGameId);
  if (!current?.installed && tab !== 'settings') {
    renderSetup(s, view);
  } else {
    switch (tab) {
      case 'mods':
        renderModsTable(s, view);
        break;
      case 'order':
        renderOrder(s, view);
        break;
      case 'browse':
        renderBrowse(s, view);
        break;
      case 'speedrun':
        renderSpeedrun(s, view);
        break;
      case 'saves':
        renderSaves(s, view);
        break;
      case 'settings':
        renderSettings(s, view);
        break;
    }
  }

  const profile = s.profiles.find((p) => p.id === s.activeProfileId);
  const statusEl = byId('action-status');
  statusEl.title = s.deployed
    ? `${s.deployed.profileName} was installed ${formatExact(s.deployed.deployedAt)}`
    : 'No mods are installed in the game folder yet';
  statusEl.textContent = s.deployed
    ? `${s.deployed.profileName} is installed \u00b7 ${s.deployed.fileCount} files \u00b7 ${s.conflicts.length} conflict(s)`
    : `Nothing installed yet \u00b7 ${profile?.enabled.length ?? 0} mod(s) switched on and ready`;

  byId<HTMLButtonElement>('btn-apply').disabled = !profile || !current?.installed;
  byId<HTMLButtonElement>('btn-launch').disabled = !current?.installed;
  byId<HTMLButtonElement>('btn-install').disabled = !current?.installed;

  // Speedrunning is an opt-in surface; the tab only exists when it is on.
  byId('tab-speedrun').hidden = !s.settings.speedrunMode;
  if (!s.settings.speedrunMode && tab === 'speedrun') tab = 'mods';

  // The toolbar only makes sense on the mods list.
  byId('toolbar').hidden = tab !== 'mods';
  byId('btn-settings').classList.toggle('is-active', tab === 'settings');
}

// --- wiring -----------------------------------------------------------------

byId('win-min').addEventListener('click', () => api.windowMinimize());
byId('win-max').addEventListener('click', () => api.windowMaximize());
byId('win-close').addEventListener('click', () => api.windowClose());

byId('game-select').addEventListener('change', async (event) => {
  const gameId = (event.target as HTMLSelectElement).value as GameId;
  const next = await api.selectGame(gameId);
  apply(next);
  saves = await api.listSaves(gameId);
  sites = await api.listSites(gameId);
  browseResult = null;
  render();
  if (tab === 'browse') void loadBrowse();
});

byId('tabs').addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('.tab') as HTMLElement | null;
  if (!target?.dataset.tab) return;
  tab = target.dataset.tab as TabId;
  render();
  // The browser only queries the network when it is actually on screen.
  if (tab === 'browse' && !browseResult && !browseLoading) void loadBrowse();
  if (tab === 'speedrun') void loadSpeedrun();
});

/*
 * Debounced: every keystroke rebuilds the whole mod table, which is fine for
 * a dozen mods and visibly laggy for a few hundred. 90ms is below the
 * threshold where typing feels delayed but coalesces a fast typist's input
 * into one render.
 */
let searchTimer: number | null = null;
byId('search').addEventListener('input', (event) => {
  search = (event.target as HTMLInputElement).value;
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    render();
  }, 90);
});

byId('btn-install').addEventListener('click', () => installMod('files'));
byId('new-profile').addEventListener('click', () => newProfile());
byId('btn-detect').addEventListener('click', () => detect_());
byId('btn-browse').addEventListener('click', () => browseForGame());
byId('btn-open-game').addEventListener('click', () => {
  if (state?.currentGameId) void api.openPath('game', state.currentGameId);
});

// Apply and Launch are independent: switching profile should not force the
// game to start, and starting the game should not force a redeploy.
byId('btn-apply').addEventListener('click', () => applyProfile(false));
byId('btn-launch').addEventListener('click', () => launchOnly());

byId('btn-settings').addEventListener('click', () => {
  tab = tab === 'settings' ? 'mods' : 'settings';
  render();
});

byId('hide-disabled').addEventListener('change', (event) => {
  hideDisabled = (event.target as HTMLInputElement).checked;
  render();
});

byId('modal-scrim').addEventListener('click', (event) => {
  if (event.target === byId('modal-scrim')) closeModal();
});

// Keyboard: "/" focuses the filter, Escape closes the modal, Enter applies.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModal();
    return;
  }
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(
    (document.activeElement?.tagName ?? '').toUpperCase(),
  );
  if (event.key === '/' && !typing) {
    event.preventDefault();
    tab = 'mods';
    render();
    byId('search').focus();
  }
  // Deliberately *not* bound to bare Enter. Applying moves files in and out of
  // the game folder and launches the game; having that on the key people press
  // to dismiss things was far too easy to trigger by accident.
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && byId('modal-scrim').hidden) {
    void applyProfile(true);
  }
  if (event.key.toLowerCase() === 'n' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    newProfile();
  }
});

void boot();
