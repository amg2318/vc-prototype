import addIcon from '../assets/icons/add.svg';
import dividerLine from '../assets/icons/divider.svg';
import logoPencil from '../assets/icons/logo-pencil.svg';
import moreOptionsIcon from '../assets/icons/more-options.svg';
import settingsIcon from '../assets/icons/settings.svg';
import { PROJECT_FILE_EXTENSION } from '../storage/archive';
import type { ProjectInfo } from '../storage/format';
import { relativeDay } from './relativeDay';
import { formatBytes, StorageSection, type StorageActions } from './storageSection';

/**
 * The Projects page (Figma "projects page" frames): the screen the app opens
 * on, covering the workspace. Every project on this device is a card showing its
 * workspace as last saved, the day it was last opened and its size; tapping one opens it. "New project" creates one and opens it. The settings button
 * shows storage settings; each card's ⋮ button has rename, duplicate, export
 * and delete (delete asks again). The page has no close button: it goes away
 * when a project opens.
 */
export interface ProjectsPageActions {
  list(): Promise<ProjectInfo[]>;
  /** The browser's estimate of storage used and available (bytes), if known. */
  estimate(): Promise<{ usage: number; quota: number } | null>;
  /** A picture of the project's workspace as last saved (PNG), or null if it has none. */
  snapshot(project: ProjectInfo): Promise<Uint8Array | null>;
  create(): void;
  open(project: ProjectInfo): void;
  rename(project: ProjectInfo, name: string): void;
  duplicate(project: ProjectInfo): void;
  remove(project: ProjectInfo): void;
  exportFile(project: ProjectInfo, includeHistory: boolean): void;
  storage: StorageActions;
}

export class ProjectsPage {
  readonly element = document.createElement('main');
  private readonly grid = document.createElement('ol');
  private readonly empty = document.createElement('p');
  private readonly settings: HTMLElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly storage: StorageSection;
  private projects: ProjectInfo[] = [];
  /** The card whose ⋮ menu is open, and whether its Delete is waiting for a second tap. */
  private menuFor: string | null = null;
  private confirmingDelete = false;
  /** The card whose name is being edited. */
  private renaming: string | null = null;
  /**
   * Each project's snapshot as an object URL, with the size the project had
   * when it was made: every save changes the size, so a different size means
   * a newer save and a new snapshot.
   */
  private readonly snapshots = new Map<string, { sizeBytes: number; url: Promise<string | null> }>();

  constructor(private readonly actions: ProjectsPageActions) {
    this.element.className = 'projects-page';
    this.element.hidden = true;

    const logo = document.createElement('div');
    logo.className = 'projects-logo';
    logo.append(icon(logoPencil, 24, 24), 'Heirloom');

    const newProject = document.createElement('button');
    newProject.type = 'button';
    newProject.className = 'projects-button new-project';
    newProject.append(icon(addIcon, 24, 24), 'New project');
    newProject.addEventListener('click', () => actions.create());

    this.settingsButton = document.createElement('button');
    this.settingsButton.type = 'button';
    this.settingsButton.className = 'projects-button settings-button';
    this.settingsButton.setAttribute('aria-label', 'Settings');
    this.settingsButton.setAttribute('aria-expanded', 'false');
    this.settingsButton.title = 'Settings';
    this.settingsButton.append(icon(settingsIcon, 20, 20));
    this.settingsButton.addEventListener('click', () => this.setSettingsOpen(this.settingsButton.getAttribute('aria-expanded') !== 'true'));

    const buttons = document.createElement('div');
    buttons.className = 'projects-actions';
    buttons.append(newProject, this.settingsButton);

    const titleRow = document.createElement('div');
    titleRow.className = 'projects-title-row';
    titleRow.append(Object.assign(document.createElement('h1'), { textContent: 'Projects' }), buttons);

    const divider = icon(dividerLine, 727.836, 2.374);
    divider.className = 'projects-divider';

    this.storage = new StorageSection(actions.storage);
    this.settings = document.createElement('div');
    this.settings.className = 'projects-settings panel';
    this.settings.hidden = true;
    this.settings.append(this.storage.element);

    const header = document.createElement('header');
    header.className = 'projects-header';
    header.append(logo, titleRow, divider, this.settings);

    this.grid.className = 'projects-grid';
    this.empty.className = 'projects-empty';
    this.empty.textContent = 'No projects yet';
    this.empty.hidden = true;
    this.element.append(header, this.grid, this.empty);

    // A tap anywhere else closes the settings popover and any ⋮ menu.
    this.element.addEventListener('pointerdown', (e) => {
      const target = e.target as Element;
      if (!this.settings.hidden && !this.settings.contains(target) && !this.settingsButton.contains(target)) this.setSettingsOpen(false);
      if (this.menuFor !== null && !target.closest('.project-menu, .project-more')) this.closeMenu();
    });
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    if (!visible) {
      this.setSettingsOpen(false);
      this.menuFor = null;
      this.renaming = null;
    }
    if (visible) void this.refresh();
  }

  /** Reload the cards (after any change to projects). */
  async refresh(): Promise<void> {
    if (!this.visible) return;
    const [projects, estimate] = await Promise.all([this.actions.list(), this.actions.estimate().catch(() => null)]);
    this.projects = projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    this.render();
    await this.storage.refresh(projects, estimate);
  }

  private setSettingsOpen(open: boolean): void {
    this.settings.hidden = !open;
    this.settingsButton.setAttribute('aria-expanded', String(open));
    if (open) void this.refresh();
  }

  private closeMenu(): void {
    this.menuFor = null;
    this.confirmingDelete = false;
    this.render();
  }

  private render(): void {
    this.empty.hidden = this.projects.length > 0;
    this.grid.replaceChildren(...this.projects.map((p) => this.card(p)));
  }

  private card(p: ProjectInfo): HTMLLIElement {
    const card = document.createElement('li');
    card.className = 'project-card';

    // The preview and the info bar both open the project.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'project-open';
    open.setAttribute('aria-label', `Open ${p.name}`);
    open.append(this.snapshotImage(p));
    open.addEventListener('click', () => this.actions.open(p));

    const info = document.createElement('div');
    info.className = 'project-info';
    info.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('.project-more, input')) this.actions.open(p);
    });
    const text = document.createElement('div');
    text.className = 'project-text';
    text.append(this.renaming === p.id ? this.nameInput(p) : Object.assign(document.createElement('div'), { className: 'project-name', textContent: p.name }));
    text.append(Object.assign(document.createElement('div'), { className: 'project-meta', textContent: `${relativeDay(p.lastOpenedAt)} · ${formatBytes(p.sizeBytes)}` }));

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'project-more';
    more.title = 'More options';
    more.setAttribute('aria-label', `More options for ${p.name}`);
    more.setAttribute('aria-expanded', String(this.menuFor === p.id));
    more.append(icon(moreOptionsIcon, 4, 18));
    more.addEventListener('click', () => {
      this.menuFor = this.menuFor === p.id ? null : p.id;
      this.confirmingDelete = false;
      this.render();
    });
    info.append(text, more);

    card.append(open, info);
    if (this.menuFor === p.id) card.append(this.menu(p));
    return card;
  }

  /** The card's picture: filled in when the snapshot is ready (blank if the project has none). */
  private snapshotImage(p: ProjectInfo): HTMLImageElement {
    const img = Object.assign(document.createElement('img'), { className: 'project-snapshot', alt: '', draggable: false });
    img.hidden = true;
    let cached = this.snapshots.get(p.id);
    if (!cached || cached.sizeBytes !== p.sizeBytes) {
      if (cached) void cached.url.then((old) => old && URL.revokeObjectURL(old));
      const url = this.actions
        .snapshot(p)
        .catch(() => null) // e.g. another tab is cleaning the project up: leave the card blank this time
        .then((png) => (png ? URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' })) : null));
      cached = { sizeBytes: p.sizeBytes, url };
      this.snapshots.set(p.id, cached);
    }
    void cached.url.then((url) => {
      if (!url) return;
      img.src = url;
      img.hidden = false;
    });
    return img;
  }

  private menu(p: ProjectInfo): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'project-menu panel';
    menu.setAttribute('role', 'menu');
    const item = (label: string, run: () => void, title: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', run);
      return b;
    };
    const done = (run: () => void) => (): void => {
      this.closeMenu();
      run();
    };
    menu.append(
      item('Rename', () => {
        this.menuFor = null;
        this.renaming = p.id;
        this.render();
      }, 'Rename this project'),
      item('Duplicate', done(() => this.actions.duplicate(p)), 'Copy this project, with its versions'),
      item('Export…', done(() => this.actions.exportFile(p, true)), `Save this project, with its versions, as a ${PROJECT_FILE_EXTENSION} file`),
      item('Export without history…', done(() => this.actions.exportFile(p, false)), `Save only the current state of this project as a ${PROJECT_FILE_EXTENSION} file`),
    );
    const remove = this.confirmingDelete
      ? item('Delete for good', done(() => this.actions.remove(p)), 'Delete this project and all its versions: this cannot be undone')
      : item('Delete…', () => {
          this.confirmingDelete = true;
          this.render();
        }, 'Delete this project');
    remove.classList.add(this.confirmingDelete ? 'danger' : 'destructive');
    menu.append(remove);
    return menu;
  }

  /** The name as a text field: Return or leaving it renames, Escape cancels. */
  private nameInput(p: ProjectInfo): HTMLInputElement {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: p.name, className: 'project-name-input' });
    input.setAttribute('aria-label', 'Project name');
    let finished = false;
    const finish = (save: boolean): void => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      this.renaming = null;
      if (save && name && name !== p.name) this.actions.rename(p, name);
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  }
}

/** An image from the design, at the size it has there. */
function icon(src: string, width: number, height: number): HTMLImageElement {
  const img = Object.assign(document.createElement('img'), { src, alt: '', width, height, draggable: false });
  img.setAttribute('aria-hidden', 'true');
  return img;
}
