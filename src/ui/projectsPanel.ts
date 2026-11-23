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
    header.append(Object.assign(document.createElement('h2'), { textContent: 'Projects' }), button('New project', actions.create, 'Create a new project and open it'));
    this.total.className = 'history-empty';
    this.element.append(header, this.total, this.list);
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
    box.append(nameInput, row);
    return box;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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
