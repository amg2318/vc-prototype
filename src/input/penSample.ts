import { screenToDoc, type ViewTransform } from '../viewport/viewport';

/**
 * One input sample, normalised from a PointerEvent and already converted to
 * document coordinates. Everything downstream of input (brush, stabilizer,
 * measurement) works on PenSamples, never on raw DOM events.
 */
export interface PenSample {
  /** Document-space position (document pixels). */
  x: number;
  y: number;
  /** 0..1. Mice report 0.5 while a button is held; the brush decides how to treat that. */
  pressure: number;
  /** Degrees, -90..90. */
  tiltX: number;
  tiltY: number;
  /** Radians, 0 (flat) .. π/2 (perpendicular). Only on browsers that expose it (Safari does). */
  altitudeAngle: number | null;
  /** Radians, 0..2π. Only on browsers that expose it. */
  azimuthAngle: number | null;
  /** Degrees, 0..359 (barrel rotation, e.g. Wacom Art Pen). */
  twist: number;
  /** -1..1 (e.g. airbrush wheel). */
  tangentialPressure: number;
  /** Event timestamp (ms, same clock as performance.now()). */
  timeStamp: number;
  pointerType: string;
  /** True for the eraser end of a pen (Wacom etc.). Apple Pencil has no eraser end. */
  isEraser: boolean;
  /** True for samples from getPredictedEvents(): only ever drawn temporarily. */
  isPredicted: boolean;
}

/** Fields not yet in every TypeScript DOM lib version. */
interface PointerEventAngles {
  altitudeAngle?: number;
  azimuthAngle?: number;
}

/** PointerEvent.buttons bit for the pen eraser (W3C Pointer Events spec). */
const ERASER_BUTTONS_BIT = 32;
/** PointerEvent.button value for the pen eraser. */
const ERASER_BUTTON = 5;

export function isEraserEvent(e: PointerEvent): boolean {
  return e.pointerType === 'pen' && ((e.buttons & ERASER_BUTTONS_BIT) !== 0 || e.button === ERASER_BUTTON);
}

/**
 * @param canvasOrigin the canvas' top-left in client coordinates (CSS px).
 */
export function penSampleFromEvent(
  e: PointerEvent,
  view: ViewTransform,
  canvasOrigin: { x: number; y: number },
  isPredicted: boolean,
  isEraser: boolean,
): PenSample {
  const doc = screenToDoc(view, { x: e.clientX - canvasOrigin.x, y: e.clientY - canvasOrigin.y });
  const angles = e as PointerEvent & PointerEventAngles;
  return {
    x: doc.x,
    y: doc.y,
    pressure: e.pressure,
    tiltX: e.tiltX ?? 0,
    tiltY: e.tiltY ?? 0,
    altitudeAngle: typeof angles.altitudeAngle === 'number' ? angles.altitudeAngle : null,
    azimuthAngle: typeof angles.azimuthAngle === 'number' ? angles.azimuthAngle : null,
    twist: e.twist ?? 0,
    tangentialPressure: e.tangentialPressure ?? 0,
    timeStamp: e.timeStamp,
    pointerType: e.pointerType,
    isEraser,
    isPredicted,
  };
}
