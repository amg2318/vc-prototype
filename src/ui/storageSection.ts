import { PROJECT_FILE_EXTENSION } from '../storage/archive';
import type { ProjectInfo } from '../storage/format';

/**
 * The settings popover on the Projects page: storage use and persistence,
 * retention of automatic versions, import, and Dev mode (the HUD, plus
 * "Delete all data" for testing).
 */
export interface StorageActions {
  /** Whether the browser promised not to clear this site's storage (null: unknown). */
  persisted(): Promise<boolean | null>;
  /** Ask for that promise; true if granted. */
  requestPersistence(): Promise<boolean>;
  retention(): { keepLatest: number; dailyForDays: number };
  setRetention(rules: { keepLatest: number; dailyForDays: number }): void;
  deleteAutomaticVersions(): void;
  collectGarbage(): void;
  /** A note to show (e.g. "use the home-screen app"), or null. */
  notice(): string | null;
  /** Add a project from a project file (as a new project). */
  importFile(file: File): void;
  /** Dev mode shows the HUD and the "Delete all data" button. */
  devMode(): boolean;
  setDevMode(on: boolean): void;
  /** Delete every project, version and setting on this device (the app reloads). */
  deleteAllData(): void;
}

export class StorageSection {
  readonly element = document.createElement('section');
  private readonly total = document.createElement('p');
  private readonly persistLine = document.createElement('div');
  private readonly devToggle = Object.assign(document.createElement('input'), { type: 'checkbox' });
  private readonly deleteAll: HTMLButtonElement;

  constructor(private readonly actions: StorageActions) {
    const s = actions;
    this.element.className = 'storage-settings';
    this.element.append(Object.assign(document.createElement('h3'), { textContent: 'Storage on this device' }));
    this.total.className = 'history-empty';
    this.element.append(this.total);
    const notice = s.notice();
    if (notice) this.element.append(Object.assign(document.createElement('p'), { className: 'storage-notice', textContent: notice }));
    this.persistLine.className = 'button-row';
    this.element.append(this.persistLine);

    const rules = s.retention();
    const keep = numberInput(rules.keepLatest, 'Newest automatic versions to keep');
    const days = numberInput(rules.dailyForDays, 'Then one a day for this many days');
    const apply = (): void => {
      const keepLatest = Math.max(0, Math.round(Number(keep.value)));
      const dailyForDays = Math.max(0, Math.round(Number(days.value)));
      if (Number.isFinite(keepLatest) && Number.isFinite(dailyForDays)) s.setRetention({ keepLatest, dailyForDays });
    };
    keep.addEventListener('change', apply);
    days.addEventListener('change', apply);
    this.element.append(
      field('Keep the newest', keep, 'automatic versions'),
      field('then one a day for', days, 'days, then one a week'),
      Object.assign(document.createElement('p'), { className: 'history-empty', textContent: 'Saved and pinned versions are always kept.' }),
    );
    const row = document.createElement('div');
    row.className = 'button-row';
    const deleteAuto = confirmButton('Delete automatic versions…', 'Delete them for good', s.deleteAutomaticVersions, 'Delete every automatic version of the open project that is not pinned, to free space');
    row.append(deleteAuto, button('Clean up', s.collectGarbage, 'Remove data no version uses any more (this happens on its own too)'));
    this.element.append(row, this.importRow());

    this.element.append(Object.assign(document.createElement('h3'), { textContent: 'Testing' }));
    const devLabel = document.createElement('label');
    devLabel.className = 'retention-field';
    devLabel.append(this.devToggle, 'Dev mode (shows the HUD)');
    this.devToggle.addEventListener('change', () => {
      s.setDevMode(this.devToggle.checked);
      this.refreshDevMode();
    });
    this.deleteAll = confirmButton('Delete all data…', 'Delete everything for good', s.deleteAllData, 'For testing: delete every project, version and setting on this device and start fresh (the app reloads)');
    this.element.append(devLabel, this.deleteAll);
  }

  private importRow(): HTMLElement {
    const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: `${PROJECT_FILE_EXTENSION},application/zip,application/octet-stream`, hidden: true });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this.actions.importFile(file);
      fileInput.value = '';
    });
    const row = document.createElement('div');
    row.className = 'button-row';
    row.append(button('Import project…', () => fileInput.click(), `Add a project from a ${PROJECT_FILE_EXTENSION} file (as a new project)`), fileInput);
    return row;
  }

  /** Bring the totals, persistence status and Dev mode up to date. */
  async refresh(projects: readonly ProjectInfo[], estimate: { usage: number; quota: number } | null): Promise<void> {
    const sum = projects.reduce((n, p) => n + p.sizeBytes, 0);
    this.total.textContent =
      `${projects.length} project${projects.length === 1 ? '' : 's'}, ${formatBytes(sum)} in all` +
      (estimate ? ` · this site uses ${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} available` : '');
    this.refreshDevMode();
    await this.refreshPersistence();
  }

  private refreshDevMode(): void {
    this.devToggle.checked = this.actions.devMode();
    this.deleteAll.hidden = !this.devToggle.checked;
  }

  private async refreshPersistence(): Promise<void> {
    const s = this.actions;
    const persisted = await s.persisted().catch(() => null);
    const label = Object.assign(document.createElement('span'), {
      className: 'version-meta',
      textContent:
        persisted === null ? 'This browser can’t say whether it may clear stored projects.' : persisted ? 'The browser will not clear stored projects on its own.' : 'The browser may clear stored projects when space runs low.',
    });
    this.persistLine.replaceChildren(label);
    if (persisted === false) {
      this.persistLine.append(
        button('Ask to keep them', () => void s.requestPersistence().then(() => this.refreshPersistence()), 'Ask the browser not to clear this site’s storage'),
      );
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function numberInput(value: number, label: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '1';
  input.value = String(value);
  input.setAttribute('aria-label', label);
  return input;
}

function field(before: string, input: HTMLInputElement, after: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'retention-field';
  label.append(before, input, after);
  return label;
}

export function button(text: string, onClick: () => void, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

/** A button that asks again: the first tap turns it into `confirmLabel`, the second runs `run`. */
export function confirmButton(label: string, confirmLabel: string, run: () => void, title: string): HTMLButtonElement {
  let confirming = false;
  const b = button(label, () => {
    confirming = !confirming;
    b.textContent = confirming ? confirmLabel : label;
    b.classList.toggle('danger', confirming);
    if (!confirming) run();
  }, title);
  return b;
}
