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
  | 'browse'
  | 'speedrun'
  | 'saves'
  | 'settings';

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
  home: 'Home',
  profile: 'Setup',
  order: 'Load order',
  browse: 'Browse',
  saves: 'Backups',
  settings: 'Settings',
  speedrun: 'Speedrun',
};

/** The screens that are not part of the drill-down: tools, not places. */
function renderTopnav(s: AppState): void {
  const host = byId('topnav');
  clear(host);

  const items: TabId[] = ['browse', 'saves'];
  if (s.settings.speedrunMode) items.push('speedrun');
  items.push('settings');

  // Load order only makes sense once you are inside a setup that has one.
  if (tab === 'profile' || tab === 'order') items.unshift('order');

  for (const id of items) {
    const btn = el('button', tab === id ? 'is-active' : undefined, TAB_LABELS[id]);
    btn.addEventListener('click', () => {
      tab = id;
      render();
      if (id === 'browse' && !browseResult && !browseLoading) void loadBrowse();
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
  if (!current?.installed) {
    renderSetup(s, view);
    return;
  }

  const home = el('div', 'home');

  const head = el('div', 'home-head');
  // Which game these setups belong to. Without it the question is ambiguous
  // the moment someone has both Legacy and Enhanced installed.
  head.appendChild(el('div', 'home-game', current.name));
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
  card.tabIndex = 0;
  card.title = `Open ${profile.name}`;
  const enter = (event: Event) => {
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    void openProfile(profile);
  };
  card.addEventListener('click', enter);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void openProfile(profile);
    }
  });

  const open = el('button', 'btn btn-wide', 'Open this setup');
  open.addEventListener('click', () => void openProfile(profile));
  card.appendChild(open);

  const play = el(
    'button',
    `btn btn-wide ${live ? 'is-blue' : ''}`,
    live ? 'Play now' : 'Switch and play',
  );
  play.addEventListener('click', () => void switchAndPlay(profile));
  card.appendChild(play);

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

  const play = el('button', 'play', 'Play with this setup');
  play.addEventListener('click', () => void applyProfile(true));
  panel.appendChild(play);

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
  // --- updates --------------------------------------------------------------
  const updRow = el('div', 'setting');
  const updMain = el('div', 'setting-main');
  updMain.appendChild(el('div', 'setting-name', 'Updates'));
  updMain.appendChild(
    el(
      'div',
      'setting-desc',
      'Every download is checked against the checksum published with the release, and refused if it does not match. Swapmeet will not restart itself while a game is running.',
    ),
  );
  updRow.appendChild(updMain);

  const updSel = el('select', 'mini-select');
  for (const [value, label] of [
    ['notify', 'Tell me'],
    ['auto', 'Install automatically'],
    ['off', 'Never check'],
  ] as Array<['notify' | 'auto' | 'off', string]>) {
    const option = el('option');
    option.value = value;
    option.textContent = label;
    option.selected = (s.settings.autoUpdate ?? 'notify') === value;
    updSel.appendChild(option);
  }
  updSel.addEventListener('change', async () => {
    const next = await guard('Saving…', () =>
      api.updateSettings({ autoUpdate: updSel.value as 'notify' | 'auto' | 'off' }),
    );
    if (next) apply(next);
  });
  updRow.appendChild(updSel);

  const updateCheckBtn = el('button', 'small-btn', 'Check now');
  updateCheckBtn.addEventListener('click', () => void checkForUpdate(true));
  updRow.appendChild(updateCheckBtn);
  toggles.appendChild(updRow);

  // --- appearance -----------------------------------------------------------
  const themeRow = el('div', 'setting');
  const themeMain = el('div', 'setting-main');
  themeMain.appendChild(el('div', 'setting-name', 'Theme'));
  themeMain.appendChild(el('div', 'setting-desc', 'The interface is designed light. Dark is available if you prefer it.'));
  themeRow.appendChild(themeMain);
  const themeSel = el('select', 'mini-select');
  for (const [value, label] of [
    ['dark', 'Dark'],
    ['light', 'Light'],
  ] as Array<['dark' | 'light', string]>) {
    const option = el('option');
    option.value = value;
    option.textContent = label;
    option.selected = (s.settings.theme ?? 'light') === value;
    themeSel.appendChild(option);
  }
  themeSel.addEventListener('change', async () => {
    const next = await guard('Saving…', () =>
      // themeChosen marks this as a real decision, so the one-time reset in
      // hydrate() never overrides it again.
      api.updateSettings({
        theme: themeSel.value as 'dark' | 'light',
        themeChosen: true,
      }),
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
    // Last, and quiet unless there is something to say.
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
  let running = false;
  try {
    running = await api.gameRunning(gameId);
  } catch {
    // If we cannot tell, do not block the launch — the check is a courtesy,
    // not a lock.
  }

  if (running) {
    const ok = await confirmModal(
      'The game is already running',
      'A copy of the game is open right now. Starting another one means two copies sharing the same save files and the same mod folder, which can lose progress. Only do this if you meant to.',
      'Launch another anyway',
    );
    if (!ok) return;
  }

  const launched = await api.launchGame(gameId);
  if (launched.ok) toast('Starting the game…', 'ok');
  else toast(launched.error ?? 'Could not start the game.', 'error');
}

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

  await startGame(s.currentGameId);
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
    await startGame(state.currentGameId);
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

  // The 2a/2b palette is the default; dark is the alternate. The stylesheet
  // redefines only the colour tokens, so everything follows.
  document.documentElement.dataset.theme = s.settings.theme ?? 'light';

  renderCrumbs(s);
  renderTopnav(s);
  renderGamePicker(s);

  const view = byId('view');
  clear(view);

  const current = s.games.find((g) => g.id === s.currentGameId);
  if (!current?.installed && tab !== 'settings') {
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
  sites = await api.listSites(gameId);
  browseResult = null;
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
