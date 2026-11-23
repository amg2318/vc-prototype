/**
 * Hand a finished file to the user:
 *  - Chromium desktop: the File System Access save dialog (choose where);
 *  - iPad / iPhone (and other browsers that share files): the share sheet,
 *    which offers "Save to Files", AirDrop, other apps…;
 *  - otherwise: an ordinary download.
 *
 * Browsers allow the dialog and the share sheet only shortly after a tap.
 * A long export can outlast that; then this throws `GestureExpiredError`
 * and the caller offers a button that calls it again from a fresh tap.
 */
export type Delivery = 'saved' | 'shared' | 'downloaded' | 'cancelled';

export class GestureExpiredError extends Error {
  constructor() {
    super('The file is ready: tap to save it');
    this.name = 'GestureExpiredError';
  }
}

interface SavePickerWindow {
  showSaveFilePicker?(options: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }): Promise<{
    createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
}

export async function deliverFile(bytes: Uint8Array, name: string, type: string): Promise<Delivery> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  try {
    const picker = (window as unknown as SavePickerWindow).showSaveFilePicker;
    if (picker && !isTouchDevice()) {
      const extension = name.slice(name.lastIndexOf('.'));
      const handle = await picker.call(window, { suggestedName: name, types: [{ description: name, accept: { [type]: [extension] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    }
    const file = new File([blob], name, { type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return 'shared';
    }
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'AbortError') return 'cancelled';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new GestureExpiredError();
    throw error;
  }
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}

/** A file name without characters file systems refuse. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 100) || 'Untitled';
}

function isTouchDevice(): boolean {
  return navigator.maxTouchPoints > 1;
}
