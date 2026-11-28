import backIcon from '../assets/icons/drawing/back.png';
import canvasesIcon from '../assets/icons/drawing/canvases.png';
import exportIcon from '../assets/icons/drawing/export.png';
import historyIcon from '../assets/icons/drawing/history.png';
import layersIcon from '../assets/icons/drawing/layers.png';
import settingsIcon from '../assets/icons/drawing/settings.png';
import { icon, iconButton } from './iconButton';

export interface TopBarActions {
  /** Leave the workspace for the Projects page. */
  showProjects(): void;
  toggleExport(): void;
  toggleSettings(): void;
  toggleHistory(): void;
  toggleCanvases(): void;
  toggleLayers(): void;
}

/** The top-bar buttons that open a panel; the open one gets a blue outline. */
export type TopBarPanel = 'export' | 'settings' | 'history' | 'canvases' | 'layers';

/**
 * The drawing page's top bar (Figma "drawing page"): a Projects back button
 * and the project's name on the left; export, settings, history, canvases
 * and layers on the right.
 */
export class TopBar {
  readonly element: HTMLElement;
  private readonly projectName: HTMLElement;
  private readonly panelButtons: Record<TopBarPanel, HTMLButtonElement>;

  constructor(actions: TopBarActions) {
    this.element = document.createElement('header');
    this.element.className = 'top-bar';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'top-bar-back';
    back.title = 'All projects on this device';
    const backArrow = icon(backIcon, 24);
    backArrow.classList.add('dim');
    back.append(backArrow, 'Projects');
    back.addEventListener('click', actions.showProjects);

    this.projectName = document.createElement('span');
    this.projectName.className = 'top-bar-name';

    const right = document.createElement('div');
    right.className = 'top-bar-buttons';
    this.panelButtons = {
      export: iconButton(exportIcon, 'Export', actions.toggleExport),
      settings: iconButton(settingsIcon, 'Settings', actions.toggleSettings),
      history: iconButton(historyIcon, 'Versions of this project', actions.toggleHistory),
      canvases: iconButton(canvasesIcon, 'Canvases', actions.toggleCanvases),
      layers: iconButton(layersIcon, 'Layers', actions.toggleLayers),
    };
    this.panelButtons.history.querySelector('img')!.classList.add('dim');
    right.append(...Object.values(this.panelButtons));

    this.element.append(back, this.projectName, right);
  }

  update(state: { projectName: string; openPanel: TopBarPanel | null }): void {
    this.projectName.textContent = state.projectName;
    for (const [panel, b] of Object.entries(this.panelButtons)) {
      b.classList.toggle('open', panel === state.openPanel);
      b.setAttribute('aria-expanded', String(panel === state.openPanel));
    }
  }
}
