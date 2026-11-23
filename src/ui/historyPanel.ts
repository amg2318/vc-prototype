import type { VersionEntry } from '../storage/format';

/**
 * The History panel: the open project's versions, newest first, each with a
 * thumbnail of the workspace. "Save version" makes a manual version (also
 * ⌘S). Selecting a version shows what can be done with it: restore, rename,
 * pin (kept by retention) and delete (asks again before deleting).
 */
export interface HistoryActions {
  saveVersion(): void;
  /** Absent: no Restore button. */
  restore?(version: VersionEntry): void;
  rename(version: VersionEntry, name: string): void;
  pin(version: VersionEntry, pinned: boolean): void;
  remove(version: VersionEntry): void;
  thumbnail(version: VersionEntry): Promise<Uint8Array | null>;
}

export class HistoryPanel {
  readonly element = document.createElement('aside');
  private readonly list = document.createElement('ol');
  private versions: readonly VersionEntry[] = [];
  private selectedId: string | null = null;
  private confirmingDelete = false;
  /** Thumbnail object URLs by file name (thumbnails never change, so they are cached). */
  private readonly images = new Map<string, Promise<string | null>>();

  constructor(private readonly actions: HistoryActions) {
    this.element.className = 'history panel';
    this.element.hidden = true;
    const header = document.createElement('header');
    const title = Object.assign(document.createElement('h2'), { textContent: 'History' });
    header.append(title, button('Save version', actions.saveVersion, 'Save a version of the project now (⌘S)'));
    const empty = Object.assign(document.createElement('p'), {
      className: 'history-empty',
      textContent: 'No versions yet. Save one with “Save version” or ⌘S; automatic versions appear as you work.',
    });
    this.element.append(header, this.list, empty);
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    if (visible) this.render();
  }

  setVersions(versions: readonly VersionEntry[]): void {
    this.versions = [...versions].sort((a, b) => b.createdAt - a.createdAt);
    if (!this.versions.some((v) => v.id === this.selectedId)) this.selectedId = null;
    if (this.visible) this.render();
  }

  private render(): void {
    this.list.replaceChildren(...this.versions.map((v) => this.row(v)));
    (this.element.querySelector('.history-empty') as HTMLElement).hidden = this.versions.length > 0;
  }

  private row(v: VersionEntry): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'version-row';
    li.classList.toggle('active', v.id === this.selectedId);

    const summary = document.createElement('div');
    summary.className = 'version-summary';
    const img = document.createElement('img');
    img.alt = '';
    if (v.thumbnail) void this.imageUrl(v).then((url) => url && (img.src = url));
    const text = document.createElement('div');
    const name = Object.assign(document.createElement('div'), { className: 'version-name', textContent: v.name });
    const meta = Object.assign(document.createElement('div'), {
      className: 'version-meta',
      textContent: [v.kind === 'auto' ? 'Automatic' : 'Saved', v.pinned ? 'Pinned' : null].filter(Boolean).join(' · '),
    });
    text.append(name, meta);
    summary.append(img, text);
    summary.addEventListener('click', () => {
      this.selectedId = this.selectedId === v.id ? null : v.id;
      this.confirmingDelete = false;
      this.render();
    });
    li.append(summary);
    if (v.id === this.selectedId) li.append(this.details(v));
    return li;
  }

  private details(v: VersionEntry): HTMLElement {
    const box = document.createElement('div');
    box.className = 'version-details';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = v.name;
    nameInput.setAttribute('aria-label', 'Version name');
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim();
      if (name && name !== v.name) this.actions.rename(v, name);
    });
    const row = document.createElement('div');
    row.className = 'button-row';
    const restore = this.actions.restore;
    if (restore) {
      row.append(button('Restore', () => restore(v), 'Make this version the working copy (the current state is kept as a version first)'));
    }
    row.append(
      button(v.pinned ? 'Unpin' : 'Pin', () => this.actions.pin(v, !v.pinned), v.pinned ? 'Let retention remove it' : 'Always keep this version'),
    );
    const remove = this.confirmingDelete
      ? button('Delete for good', () => this.actions.remove(v), 'Delete this version: this cannot be undone')
      : button('Delete…', () => {
          this.confirmingDelete = true;
          this.render();
        }, 'Delete this version');
    if (this.confirmingDelete) remove.classList.add('danger');
    row.append(remove);
    box.append(nameInput, row);
    return box;
  }

  private imageUrl(v: VersionEntry): Promise<string | null> {
    const name = v.thumbnail!;
    let url = this.images.get(name);
    if (!url) {
      url = this.actions
        .thumbnail(v)
        .then((bytes) => (bytes ? URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' })) : null))
        .catch(() => null);
      this.images.set(name, url);
    }
    return url;
  }
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
