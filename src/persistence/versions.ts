import type { HeadRecord, ManifestId, VersionEntry } from '../storage/format';
import { newId } from '../storage/format';
import type { HeadEdit } from '../storage/service';
import { applyRetention, type RetentionRules } from './retention';

/**
 * Versions: named snapshots of a project. A version is a manifest the head
 * points to, so making one copies nothing (every tile and record is shared
 * with the working copy). Pure helpers here; the project session decides
 * when to make them.
 *
 *  - manual: the Save button or ⌘S;
 *  - auto, "session-ended": on opening a project whose working copy has
 *    changes no version holds (the previous session's end state);
 *  - auto, "active-time": after a stretch of active editing;
 *  - auto, "before-restore": the working copy, just before a restore.
 */

export type NewVersion = Omit<VersionEntry, 'manifestId'> & { manifestId: ManifestId | null };

export function versionName(kind: VersionEntry['kind'], reason: VersionEntry['reason'], at: number): string {
  const when = new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (kind === 'manual') return `Saved ${when}`;
  if (reason === 'session-ended') return `Session ended ${when}`;
  if (reason === 'before-restore') return `Before restore ${when}`;
  return `Autosave ${when}`;
}

/**
 * The head edit that adds `version` (manifestId null = the manifest of the
 * commit it goes with) and applies retention to automatic versions.
 */
export function addVersionEdit(head: HeadRecord | null, version: NewVersion, now: number, rules: RetentionRules): HeadEdit {
  const versions: NewVersion[] = [version, ...(head?.versions ?? [])];
  return { versions: applyRetention(versions, now, rules), activeMsSinceVersion: 0 };
}

export function newVersion(kind: VersionEntry['kind'], reason: VersionEntry['reason'] | undefined, at: number, manifestId: ManifestId | null, thumbnail: string | null): NewVersion {
  return {
    id: newId('v'),
    manifestId,
    name: versionName(kind, reason, at),
    createdAt: at,
    kind,
    ...(reason ? { reason } : {}),
    pinned: false,
    thumbnail,
  };
}

/** True if the working copy holds changes no version has (so ending the session is worth a version). */
export function workingCopyUnversioned(head: HeadRecord | null): boolean {
  if (!head) return false;
  return !head.versions.some((v) => v.manifestId === head.working);
}

/**
 * Active editing time. Time between two inputs counts if they are less than
 * `windowMs` apart; a longer pause counts as `windowMs` at most (the user
 * was probably still looking). Pure: the caller passes the clock.
 */
export class ActiveTime {
  private lastInput: number | null = null;

  constructor(
    public ms: number,
    private readonly windowMs: number,
  ) {}

  input(now: number): void {
    if (this.lastInput !== null) this.ms += Math.min(now - this.lastInput, this.windowMs);
    this.lastInput = now;
  }

  reset(): void {
    this.ms = 0;
  }
}
