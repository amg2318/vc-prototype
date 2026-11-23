import type { ProjectSession } from '../persistence/projectSession';
import type { Metrics } from './metrics';

/**
 * Phase 4 stress test (part of the `?stress` panel): N canvases × M
 * versions, in a new project.
 *
 *  1. Build N canvases with strokes (the panel's "Build workspace").
 *  2. M times: a few strokes on one canvas, then a manual version. Each
 *     step records the save time, the time to make the version, and the
 *     project's size after it (so storage per version).
 *  3. Reopen the project: time until it is loaded with its previews
 *     showing, and until it is at full resolution (fitted to the first
 *     canvas, with nothing left to load or composite).
 *  4. Delete the older half of the versions and collect garbage: its time
 *     and what it freed.
 *
 * The summary goes to `metrics.stressRuns` (kind "persistence"), so the
 * JSON export holds it.
 */
export interface PersistenceStressDeps {
  project: ProjectSession;
  metrics: Metrics;
  /** Build `count` canvases with strokes in the open project. */
  buildCanvases(count: number): Promise<unknown>;
  /** Draw `count` strokes on a canvas chosen by `index`. */
  drawStrokes(index: number, count: number): Promise<void>;
  /** Show the first canvas, filling the screen. */
  showFirstCanvas(): void;
  /** Resolves once the renderer has nothing left to load or composite. */
  waitUntilIdle(): Promise<void>;
  report(message: string): void;
}

export async function persistenceRun(deps: PersistenceStressDeps, canvases: number, versions: number): Promise<string> {
  const { project } = deps;
  const info = await project.create(`Stress: ${canvases} canvases × ${versions} versions`);
  await deps.buildCanvases(canvases);
  await project.saveNow();
  const sizeOf = async (): Promise<number> => (await project.listProjects()).find((p) => p.id === info.id)?.sizeBytes ?? 0;

  const steps: { saveMs: number; versionMs: number; bytesAfter: number }[] = [];
  let size = await sizeOf();
  const startSize = size;
  for (let v = 0; v < versions; v++) {
    await deps.drawStrokes(v, 3);
    const t0 = performance.now();
    await project.saveNow();
    const t1 = performance.now();
    await project.saveVersion('manual');
    const t2 = performance.now();
    size = await sizeOf();
    steps.push({ saveMs: t1 - t0, versionMs: t2 - t1, bytesAfter: size });
    deps.report(`Persistence: version ${v + 1} / ${versions}…`);
  }

  // Reopen: loaded with previews, then full resolution.
  const t0 = performance.now();
  await project.open(info.id);
  await new Promise(requestAnimationFrame);
  const toPreviewsMs = performance.now() - t0;
  deps.showFirstCanvas();
  await deps.waitUntilIdle();
  const toFullMs = performance.now() - t0;

  // Delete the older half of the versions, then collect.
  const older = [...project.versions].sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.floor(versions / 2));
  for (const v of older) await project.deleteVersion(v.id);
  const gc = await project.collectGarbage();

  const perVersion = steps.map((s, i) => s.bytesAfter - (i === 0 ? startSize : steps[i - 1]!.bytesAfter));
  const average = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const summary = {
    kind: 'persistence',
    canvases,
    versions,
    bytesBeforeVersions: startSize,
    bytesAfterVersions: size,
    bytesPerVersion: perVersion,
    steps,
    open: { toPreviewsMs, toFullResolutionMs: toFullMs },
    gc: gc && { ms: gc.ms, removedFiles: gc.removedFiles, removedBytes: gc.removedBytes, sizeBytes: gc.sizeBytes },
  };
  deps.metrics.stressRuns.push(summary);
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  return (
    `save ${average(steps.map((s) => s.saveMs)).toFixed(0)} ms, version ${average(steps.map((s) => s.versionMs)).toFixed(0)} ms, ` +
    `${kb(average(perVersion))} per version · open ${toPreviewsMs.toFixed(0)} ms to previews, ${toFullMs.toFixed(0)} ms to full res · ` +
    `gc ${gc ? `${gc.ms.toFixed(0)} ms, freed ${kb(gc.removedBytes)}` : 'did not run'}`
  );
}
