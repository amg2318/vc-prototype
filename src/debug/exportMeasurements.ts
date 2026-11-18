import type { BrushSettings } from '../brush/brushSettings';
import type { Metrics } from './metrics';

export interface SessionInfo {
  renderer: string;
  fallbackReason: string | null;
  devicePixelRatio: number;
  cssSize: { width: number; height: number };
  backingSize: { width: number; height: number };
  inputCapabilities: { coalescedEvents: boolean; predictedEvents: boolean };
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

export function buildExport(
  metrics: Metrics,
  session: SessionInfo,
  brush: BrushSettings,
  label: string,
  document: object = {},
): object {
  return {
    format: 'vc-prototype-measurements',
    version: 2,
    note:
      'Latencies are software estimates (input event timestamp → GPU work submitted / GPU work done). ' +
      'They exclude display scan-out and digitizer latency; true on-glass latency is higher.',
    label,
    exportedAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      standalone: isStandalone(),
      ...session,
    },
    brush,
    document,
    counters: metrics.counters,
    summary: metrics.summary(),
    frames: metrics.frames,
  };
}

function fileName(label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
  return `measurements-${safeLabel ? safeLabel + '-' : ''}${stamp}.json`;
}

/**
 * Download the measurements. Uses the share sheet when available (which works
 * better in an installed iOS home-screen app, where downloads are awkward),
 * otherwise a regular file download.
 */
export async function saveMeasurements(data: object, label: string): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const name = fileName(label);
  const file = new File([json], name, { type: 'application/json' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // user closed the sheet
      // Otherwise fall through to a plain download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
