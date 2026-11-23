import type { SaveStatus } from '../persistence/projectSession';

/**
 * The small save status in the toolbar: a dot and a word (saved, saving,
 * unsaved, error, read-only, not saved). Tapping it shows the details.
 */
const LABELS: Record<SaveStatus['state'], string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved',
  error: 'Not saved',
  'read-only': 'Read-only',
  'not-persistent': 'Not saved',
};

export class SaveIndicator {
  readonly element: HTMLButtonElement;

  constructor(onTap: (status: SaveStatus) => void) {
    this.element = document.createElement('button');
    this.element.className = 'save-indicator';
    let current: SaveStatus | null = null;
    this.element.addEventListener('click', () => current && onTap(current));
    this.update = (status) => {
      current = status;
      this.element.dataset.state = status.state;
      this.element.textContent = LABELS[status.state];
      const when = status.savedAt ? `Last saved ${new Date(status.savedAt).toLocaleTimeString()}` : 'Not saved yet';
      this.element.title = status.message ?? when;
    };
  }

  update: (status: SaveStatus) => void;
}
