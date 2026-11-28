import { PROJECT_FILE_EXTENSION } from '../storage/archive';
import { Popover } from './formRows';

export interface ExportActions {
  /** The active canvas, flattened to a PNG. */
  exportCanvasPng(): void;
  /** The whole project, with its versions. */
  exportProject(): void;
}

/** Export popover (the top bar's export button): the active canvas as a PNG, or the project file. */
export class ExportMenu extends Popover {
  constructor(actions: ExportActions) {
    super('export-menu');
    const item = (text: string, title: string, run: () => void): HTMLButtonElement => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, title });
      b.addEventListener('click', () => {
        this.setVisible(false);
        run();
      });
      return b;
    };
    const title = Object.assign(document.createElement('div'), { className: 'popover-title', textContent: 'Export' });
    this.element.append(
      title,
      item('Canvas as PNG', 'Save the active canvas as a PNG image', actions.exportCanvasPng),
      item('Project file', `Save this project, with its versions, as a ${PROJECT_FILE_EXTENSION} file`, actions.exportProject),
    );
  }
}
