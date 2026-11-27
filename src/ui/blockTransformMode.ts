import { blockFrame, dragCrop, dragPlacement, framePoint, frameCorners, rotateHandle, type BlockFrame, type CropHandle, type Point, type TransformDrag } from '../document/blockTransform';
import { applyAffine, sourceToInheritor, type InheritedBlock, type Size } from '../document/inheritedBlock';
import type { CanvasId } from '../document/paintDocument';
import type { OverlayQuad, Rgba } from '../render/renderer';
import type { Workspace } from '../workspace/workspace';
import { docToScreen, screenToDoc, type ViewTransform } from '../viewport/viewport';

export interface BlockTransformHost {
  workspace: Workspace;
  getView(): ViewTransform;
  requestFrame(): void;
  /** The mode turned on or off (e.g. to relabel the panel's Transform button). */
  modeChanged(): void;
}

/** Handle targets: 44 pt. The rotate handle sits this far (CSS px) above the top edge. */
const TARGET_PX = 44;
const ROTATE_OFFSET_PX = 36;
const OUTLINE_DEVICE_PX = 2;
const OUTLINE: Rgba = [0.04, 0.52, 1, 1];
/** While cropping: the whole source, to show how far the crop can grow. */
const SOURCE_OUTLINE: Rgba = [0.04, 0.52, 1, 0.35];

export type BlockTool = 'transform' | 'crop';

/** Crop handles: the corners (in frameCorners order), then the middle of each edge. */
const CROP_HANDLES: CropHandle[] = [
  { u: -1, v: -1 }, { u: 1, v: -1 }, { u: 1, v: 1 }, { u: -1, v: 1 },
  { u: 0, v: -1 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: -1, v: 0 },
];

type Drag =
  | (TransformDrag & { pointerId: number })
  | { kind: 'crop'; handle: CropHandle; start: Point; block: InheritedBlock; sourceSize: Size; pointerId: number };

/**
 * Block-transform mode: change a canvas's inherited block directly on the
 * canvas. While it is on, strokes are off (the app asks `active` before
 * drawing), so pen, finger and mouse can all grab the handles; presses
 * elsewhere pan as on empty space. Its bar switches between two tools:
 *
 * Transform
 *  - drag inside the block to move it;
 *  - drag a corner to scale it about its centre (aspect is kept);
 *  - drag the round handle above it to rotate (snaps to 15° steps when close).
 * Crop
 *  - drag an edge or corner to crop: those sides follow the pointer, up to
 *    the source's edges (shown faintly); the content stays where it is.
 *
 * Each drag is one undo step. Done (or Escape / Enter) leaves the mode.
 */
export class BlockTransformMode {
  /** The handles, drawn over the canvases (below the panels). */
  readonly element = document.createElement('div');
  /**
   * The Flip / Done bar. A separate element so the app can put it above
   * every panel and the HUD: leaving the mode must always be reachable.
   */
  readonly bar = document.createElement('div');
  /** The canvas whose block is being transformed (null: mode off). */
  private target: CanvasId | null = null;
  private currentTool: BlockTool = 'transform';
  private readonly body = document.createElement('div');
  private readonly corners = [0, 1, 2, 3].map(() => handle('corner', 'Drag to scale'));
  private readonly rotator = handle('rotate', 'Drag to rotate');
  private readonly cropHandles = CROP_HANDLES.map((h) => handle(`crop ${h.u === 0 ? 'edge-v' : h.v === 0 ? 'edge-u' : 'corner'}`, 'Drag to crop'));
  private readonly title = span('Transform block');
  private readonly transformButton = button('Transform', () => this.setTool('transform'));
  private readonly cropButton = button('Crop', () => this.setTool('crop'));
  private readonly resetCropButton = button('Reset crop', () => this.resetCrop());
  private drag: Drag | null = null;
  /** Distinguishes successive drags, so each one merges into its own undo step. */
  private dragCount = 0;

  constructor(private readonly host: BlockTransformHost) {
    this.element.className = 'block-transform';
    this.element.hidden = true;
    this.body.className = 'block-transform-body';
    this.body.title = 'Drag to move';
    this.bar.className = 'block-transform-bar panel';
    this.bar.append(
      this.title,
      this.transformButton,
      this.cropButton,
      button('Flip H', () => this.flip('flipX')),
      button('Flip V', () => this.flip('flipY')),
      this.resetCropButton,
      button('Done', () => this.stop()),
    );
    this.bar.hidden = true;
    this.element.append(this.body, ...this.corners, this.rotator, ...this.cropHandles);
    this.listen(this.body, 'move');
    for (const c of this.corners) this.listen(c, 'scale');
    this.listen(this.rotator, 'rotate');
    this.cropHandles.forEach((el, i) => this.listen(el, 'crop', CROP_HANDLES[i]));
    window.addEventListener('keydown', (e) => {
      if (this.target !== null && (e.key === 'Escape' || e.key === 'Enter')) this.stop();
    });
  }

  get active(): boolean {
    return this.target !== null;
  }

  get canvasId(): CanvasId | null {
    return this.target;
  }

  /** The tool in use (meaningful while `active`). */
  get tool(): BlockTool {
    return this.currentTool;
  }

  /** Turn the mode on for `canvasId` with `tool`, or off if it is already on with that tool. */
  toggle(canvasId: CanvasId, tool: BlockTool = 'transform'): void {
    if (this.target === canvasId && this.currentTool === tool) this.stop();
    else this.start(canvasId, tool);
  }

  start(canvasId: CanvasId, tool: BlockTool = 'transform'): void {
    if (!this.host.workspace.canvas(canvasId).inherited) return;
    this.target = canvasId;
    this.setTool(tool);
  }

  setTool(tool: BlockTool): void {
    this.currentTool = tool;
    this.drag = null;
    this.title.textContent = tool === 'crop' ? 'Crop block' : 'Transform block';
    this.transformButton.classList.toggle('active', tool === 'transform');
    this.cropButton.classList.toggle('active', tool === 'crop');
    this.resetCropButton.hidden = tool !== 'crop';
    this.element.classList.toggle('cropping', tool === 'crop');
    this.host.requestFrame();
    this.host.modeChanged();
  }

  stop(): void {
    if (this.target === null) return;
    this.target = null;
    this.drag = null;
    this.host.requestFrame();
    this.host.modeChanged();
  }

  /** The block's outline and the line to the rotate handle, drawn in the overlay pass. */
  overlay(canvasPxPerDevicePx: number): OverlayQuad[] {
    const state = this.state();
    if (!state) return [];
    const { frame, origin } = state;
    const width = OUTLINE_DEVICE_PX * canvasPxPerDevicePx;
    const toWorkspace = (p: Point): Point => ({ x: p.x + origin.x, y: p.y + origin.y });
    const corners = frameCorners(frame).map(toWorkspace);
    const quads = corners.map((a, i) => line(a, corners[(i + 1) % 4]!, width));
    if (this.currentTool === 'crop') {
      const whole = sourceCorners(state.block, state.sourceSize).map(toWorkspace);
      quads.push(...whole.map((a, i) => line(a, whole[(i + 1) % 4]!, width, SOURCE_OUTLINE)));
      return quads;
    }
    const topMiddle = toWorkspace(rotateHandle(frame, 0));
    const knob = toWorkspace(rotateHandle(frame, ROTATE_OFFSET_PX / this.host.getView().scale));
    quads.push(line(topMiddle, knob, width));
    return quads;
  }

  /** Reposition the handles; call once per frame. Leaves the mode if the block went away. */
  update(view: ViewTransform): void {
    const state = this.state();
    if (this.target !== null && !state) this.stop();
    this.element.hidden = !state;
    this.bar.hidden = !state;
    if (!state) return;
    const { frame, origin } = state;
    const screen = (p: Point): Point => docToScreen(view, { x: p.x + origin.x, y: p.y + origin.y });

    const c = screen(frame.centre);
    const w = 2 * frame.halfWidth * view.scale;
    const h = 2 * frame.halfHeight * view.scale;
    const degrees = ((frame.rotation + view.rotation) * 180) / Math.PI;
    Object.assign(this.body.style, {
      width: `${w}px`,
      height: `${h}px`,
      transform: `translate(${c.x}px, ${c.y}px) rotate(${degrees}deg) translate(${-w / 2}px, ${-h / 2}px)`,
    });
    const cropping = this.currentTool === 'crop';
    for (const el of [...this.corners, this.rotator]) el.hidden = cropping;
    for (const el of this.cropHandles) el.hidden = !cropping;
    if (cropping) {
      // Turned with the block, so edge handles lie along their edges.
      CROP_HANDLES.forEach((h, i) => place(this.cropHandles[i]!, screen(framePoint(frame, h.u * frame.halfWidth, h.v * frame.halfHeight)), degrees));
      this.resetCropButton.disabled = state.block.crop === undefined;
      return;
    }
    frameCorners(frame).forEach((p, i) => place(this.corners[i]!, screen(p)));
    place(this.rotator, screen(rotateHandle(frame, ROTATE_OFFSET_PX / view.scale)));
  }

  /** The block's frame (target canvas px) and the canvas's workspace origin; null if there's nothing to transform. */
  private state(): { block: InheritedBlock; frame: BlockFrame; origin: Point; sourceSize: Size } | null {
    const ws = this.host.workspace;
    if (this.target === null || !ws.hasCanvas(this.target)) return null;
    const doc = ws.canvas(this.target);
    const block = doc.inherited;
    if (!block) return null;
    const size = sourceSize(ws, block);
    return { block, frame: blockFrame(block, size), origin: { x: doc.x, y: doc.y }, sourceSize: size };
  }

  private listen(el: HTMLElement, kind: Drag['kind'], cropHandle?: CropHandle): void {
    el.addEventListener('pointerdown', (e) => {
      const state = this.state();
      if (!state || this.drag || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      this.dragCount++;
      const start = this.canvasPoint(e);
      this.drag =
        kind === 'crop'
          ? { kind, handle: cropHandle!, start, block: state.block, sourceSize: state.sourceSize, pointerId: e.pointerId }
          : { kind, start, placement: state.block.placement, pointerId: e.pointerId };
    });
    el.addEventListener('pointermove', (e) => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== e.pointerId || this.target === null) return;
      const mergeKey = `block-${drag.kind === 'crop' ? 'crop' : 'transform'}-${this.target}-${this.dragCount}`;
      if (drag.kind === 'crop') {
        const { crop, centre } = dragCrop(drag, this.canvasPoint(e));
        this.host.workspace.cropBlock(this.target, crop, centre, mergeKey);
      } else {
        this.host.workspace.placeBlock(this.target, dragPlacement(drag, this.canvasPoint(e)), mergeKey);
      }
    });
    const end = (e: PointerEvent): void => {
      if (this.drag?.pointerId === e.pointerId) this.drag = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Show the whole source again, keeping what was visible where it was. */
  private resetCrop(): void {
    const state = this.state();
    if (!state || this.target === null || !state.block.crop) return;
    const { block, sourceSize: size } = state;
    const centre = applyAffine(sourceToInheritor(block, size), size.width / 2, size.height / 2);
    this.host.workspace.cropBlock(this.target, undefined, centre);
  }

  private flip(axis: 'flipX' | 'flipY'): void {
    const block = this.state()?.block;
    if (block && this.target !== null) this.host.workspace.placeBlock(this.target, { [axis]: !block.placement[axis] });
  }

  /** A pointer position in the target canvas's pixels. */
  private canvasPoint(e: PointerEvent): Point {
    const doc = this.host.workspace.canvas(this.target!);
    const p = screenToDoc(this.host.getView(), { x: e.clientX, y: e.clientY });
    return { x: p.x - doc.x, y: p.y - doc.y };
  }
}

/** The source's size, or the last one known for an empty or missing block. */
function sourceSize(ws: Workspace, block: InheritedBlock): Size {
  if (block.source.kind === 'linked' && ws.hasCanvas(block.source.canvasId)) {
    const source = ws.canvas(block.source.canvasId);
    return { width: source.width, height: source.height };
  }
  return block.lastSourceSize;
}

/** The uncropped source's corners on the inheritor (canvas pixels). */
function sourceCorners(block: InheritedBlock, size: Size): Point[] {
  const m = sourceToInheritor(block, size);
  return [applyAffine(m, 0, 0), applyAffine(m, size.width, 0), applyAffine(m, size.width, size.height), applyAffine(m, 0, size.height)];
}

/** A straight stroke from `a` to `b`, `width` wide. */
function line(a: Point, b: Point, width: number, color: Rgba = OUTLINE): OverlayQuad {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / length) * width;
  const ny = ((b.x - a.x) / length) * width;
  return {
    origin: { x: a.x - nx / 2, y: a.y - ny / 2 },
    xAxis: { x: b.x - a.x, y: b.y - a.y },
    yAxis: { x: nx, y: ny },
    color,
  };
}

function place(el: HTMLElement, p: Point, degrees = 0): void {
  el.style.transform = `translate(${(p.x - TARGET_PX / 2).toFixed(1)}px, ${(p.y - TARGET_PX / 2).toFixed(1)}px) rotate(${degrees.toFixed(2)}deg)`;
}

function handle(kind: string, title: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `block-transform-handle ${kind}`;
  el.title = title;
  el.setAttribute('aria-label', title);
  return el;
}

function span(text: string): HTMLSpanElement {
  return Object.assign(document.createElement('span'), { textContent: text });
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
