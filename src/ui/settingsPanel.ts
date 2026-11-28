import type { FingerDrawing, FingerDrawingSetting } from '../input/fingerDrawing';
import { buttons, checkboxRow, Popover, row } from './formRows';

export interface SettingsActions {
  renameProject(name: string): void;
  setArrowsShown(shown: boolean): void;
  fitView(): void;
  toggleHud(): void;
  exportMeasurements(): void;
  resetMeasurements(): void;
  setRotationEnabled(enabled: boolean): void;
}

/**
 * Settings popover (the top bar's gear): the project's name, finger drawing,
 * arrows between canvases, and a collapsible debug section for measuring the
 * prototype.
 */
export class SettingsPanel extends Popover {
  /** Extra debug content (e.g. stress mode) can be appended here. */
  readonly debugBody: HTMLElement;
  private readonly fingerSelect = document.createElement('select');
  private readonly arrows: HTMLInputElement;
  private readonly projectName = document.createElement('input');
  private savedName = '';

  constructor(
    private readonly fingers: FingerDrawing,
    actions: SettingsActions,
  ) {
    super('settings-panel');
    const title = document.createElement('div');
    title.className = 'popover-title';
    title.textContent = 'Settings';

    const arrows = checkboxRow('Show arrows', false, actions.setArrowsShown);
    this.arrows = arrows.input;
    const main = document.createElement('div');
    main.className = 'popover-body';
    main.append(title, this.nameSetting(actions.renameProject), this.fingerSetting(), arrows.element);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Debug';
    this.debugBody = document.createElement('div');
    this.debugBody.className = 'popover-body';
    this.debugBody.append(
      checkboxRow('Two-finger rotate', false, actions.setRotationEnabled).element,
      buttons([
        ['Fit view', actions.fitView],
        ['Toggle HUD', actions.toggleHud],
      ]),
      buttons([
        ['Export JSON', actions.exportMeasurements],
        ['Reset stats', actions.resetMeasurements],
      ]),
    );
    details.append(summary, this.debugBody);
    this.element.append(main, details);
  }

  update(state: { projectName: string; arrowsShown: boolean }): void {
    this.savedName = state.projectName;
    if (document.activeElement !== this.projectName) this.projectName.value = state.projectName; // never while typing
    this.arrows.checked = state.arrowsShown;
    this.fingerSelect.value = this.fingers.setting;
    // Auto: one finger draws until a pen is used, then pans.
    this.fingerSelect.title = `${this.fingers.setting === 'auto' ? 'Auto: ' : ''}one finger ${this.fingers.enabled ? 'draws' : 'pans'}`;
  }

  /** The project's name: saved on Return or when the field loses focus; an empty name puts the old one back. */
  private nameSetting(rename: (name: string) => void): HTMLElement {
    const input = this.projectName;
    input.type = 'text';
    input.enterKeyHint = 'done';
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    input.addEventListener('change', () => {
      const name = input.value.trim();
      if (name && name !== this.savedName) rename(name);
      else input.value = this.savedName;
    });
    return row('Project name', input);
  }

  /** Finger drawing: Auto (on until a pen is used) / On / Off. */
  private fingerSetting(): HTMLElement {
    const el = this.fingerSelect;
    el.append(new Option('Auto', 'auto'), new Option('On', 'on'), new Option('Off', 'off'));
    el.addEventListener('change', () => (this.fingers.setting = el.value as FingerDrawingSetting));
    return row('Finger draws', el);
  }
}
