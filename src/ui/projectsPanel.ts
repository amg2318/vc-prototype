import { PROJECT_FILE_EXTENSION } from '../storage/archive';
import type { ProjectInfo } from '../storage/format';

/**
 * The Projects panel: every project on this device with its size and when
 * it was last opened, the total against the browser's storage quota, and
 * new / open / rename / duplicate / delete (delete asks again).
 */
export interface ProjectsActions {
  list(): Promise<ProjectInfo[]>;
  /** The browser's estimate of storage used and available (bytes), if known. */
  estimate(): Promise<{ usage: number; quota: number } | null>;
  currentId(): string | null;
  /** True if the current project is read-only in this tab. */
  currentReadOnly(): boolean;
  create(): void;
  open(project: ProjectInfo): void;
  rename(project: ProjectInfo, name: string): void;
  duplicate(project: ProjectInfo): void;
  remove(project: ProjectInfo): void;
  exportFile(project: ProjectInfo, includeHistory: boolean): void;
  importFile(file: File): void;
  storage: StorageActions;
}

/** The Storage section (settings kept per device). */
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
}

export class ProjectsPanel {
  readonly element = document.createElement('aside');
  private readonly list = document.createElement('ol');
  private readonly total = document.createElement('p');
  private projects: ProjectInfo[] = [];
  private selectedId: string | null = null;
  private confirmingDelete = false;

  constructor(private readonly actions: ProjectsActions) {
    this.element.className = 'history projects panel';
    this.element.hidden = true;
    const header = document.createElement('header');
    const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: `${PROJECT_FILE_EXTENSION},application/zip,application/octet-stream`, hidden: true });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) actions.importFile(file);
      fileInput.value = '';
    });
    const buttons = document.createElement('div');
    buttons.className = 'button-row';
    buttons.append(
      button('Import…', () => fileInput.click(), `Add a project from a ${PROJECT_FILE_EXTENSION} file (as a new project)`),
      button('New project', actions.create, 'Create a new project and open it'),
      fileInput,
    );
    header.append(Object.assign(document.createElement('h2'), { textContent: 'Projects' }), buttons);
    this.total.className = 'history-empty';
    this.element.append(header, this.total, this.list, this.storageSection());
  }

  private readonly persistLine = document.createElement('div');

  private storageSection(): HTMLElement {
    const s = this.actions.storage;
    const section = document.createElement('section');
    section.className = 'storage-settings';
    section.append(Object.assign(document.createElement('h3'), { textContent: 'Storage on this device' }));
    const notice = s.notice();
    if (notice) section.append(Object.assign(document.createElement('p'), { className: 'storage-notice', textContent: notice }));
    this.persistLine.className = 'button-row';
    section.append(this.persistLine);

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
    section.append(
      field('Keep the newest', keep, 'automatic versions'),
      field('then one a day for', days, 'days, then one a week'),
      Object.assign(document.createElement('p'), { className: 'history-empty', textContent: 'Saved and pinned versions are always kept.' }),
    );
    const row = document.createElement('div');
    row.className = 'button-row';
    let confirming = false;
    const deleteAuto = button('Delete automatic versions…', () => {
      if (!confirming) {
        confirming = true;
        deleteAuto.textContent = 'Delete them for good';
        deleteAuto.classList.add('danger');
        return;
      }
      confirming = false;
      deleteAuto.textContent = 'Delete automatic versions…';
      deleteAuto.classList.remove('danger');
      s.deleteAutomaticVersions();
    }, 'Delete every automatic version of the open project that is not pinned, to free space');
    row.append(deleteAuto, button('Clean up', s.collectGarbage, 'Remove data no version uses any more (this happens on its own too)'));
    section.append(row);
    return section;
  }

  private async refreshPersistence(): Promise<void> {
    const s = this.actions.storage;
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

  get visible(): boolean {
    return !this.element.hidden;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    if (visible) void this.refresh();
  }

  /** Reload the list (after any change to projects). */
  async refresh(): Promise<void> {
    if (!this.visible) return;
    const [projects, estimate] = await Promise.all([this.actions.list(), this.actions.estimate().catch(() => null)]);
    this.projects = projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    const sum = projects.reduce((n, p) => n + p.sizeBytes, 0);
    this.total.textContent =
      `${projects.length} project${projects.length === 1 ? '' : 's'}, ${formatBytes(sum)} in all` +
      (estimate ? ` · this site uses ${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} available` : '');
    this.render();
    await this.refreshPersistence();
  }

  private render(): void {
    this.list.replaceChildren(...this.projects.map((p) => this.row(p)));
  }

  private row(p: ProjectInfo): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'version-row';
    const current = p.id === this.actions.currentId();
    li.classList.toggle('active', p.id === this.selectedId);
    const summary = document.createElement('div');
    summary.className = 'version-summary';
    const text = document.createElement('div');
    const status = current ? (this.actions.currentReadOnly() ? 'Open here, read-only' : 'Open') : `Opened ${new Date(p.lastOpenedAt).toLocaleDateString()}`;
    text.append(
      Object.assign(document.createElement('div'), { className: 'version-name', textContent: p.name }),
      Object.assign(document.createElement('div'), { className: 'version-meta', textContent: `${formatBytes(p.sizeBytes)} · ${status}` }),
    );
    summary.append(text);
    summary.addEventListener('click', () => {
      this.selectedId = this.selectedId === p.id ? null : p.id;
      this.confirmingDelete = false;
      this.render();
    });
    li.append(summary);
    if (p.id === this.selectedId) li.append(this.details(p, current));
    return li;
  }

  private details(p: ProjectInfo, current: boolean): HTMLElement {
    const box = document.createElement('div');
    box.className = 'version-details';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = p.name;
    nameInput.setAttribute('aria-label', 'Project name');
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim();
      if (name && name !== p.name) this.actions.rename(p, name);
    });
    const row = document.createElement('div');
    row.className = 'button-row';
    if (!current) row.append(button('Open', () => this.actions.open(p), 'Open this project (the current one is saved first)'));
    row.append(button('Duplicate', () => this.actions.duplicate(p), 'Copy this project, with its versions'));
    const remove = this.confirmingDelete
      ? button('Delete for good', () => this.actions.remove(p), 'Delete this project and all its versions: this cannot be undone')
      : button('Delete…', () => {
          this.confirmingDelete = true;
          this.render();
        }, 'Delete this project');
    if (this.confirmingDelete) remove.classList.add('danger');
    row.append(remove);
    const history = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    const historyLabel = document.createElement('label');
    historyLabel.className = 'retention-field';
    historyLabel.append(history, 'with version history');
    const exportRow = document.createElement('div');
    exportRow.className = 'button-row';
    exportRow.append(button('Export…', () => this.actions.exportFile(p, history.checked), `Save this project as a ${PROJECT_FILE_EXTENSION} file`), historyLabel);
    box.append(nameInput, row, exportRow);
    return box;
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

function button(text: string, onClick: () => void, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}
