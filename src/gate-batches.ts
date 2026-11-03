/**
 * Groups quality commands for the verify gate (B-131). Commands run one after another unless the manifest marks them `parallel`: a run of consecutive marked commands forms one batch that
 * runs at the same time. Order and count never change, so reports and the "first failing command decides" rule stay as configured. A Unity command is never batched: the Editor owns the
 * project and its import, licence and .meta healing must not race. Mark a command only when it writes nothing another command reads (lint, type checks, separate test projects).
 */
export function gateBatches<T extends { executable: string; parallel?: boolean | undefined }>(checks: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (const check of checks) {
    const mayBatch = check.parallel === true && check.executable !== "unity";
    const last = batches[batches.length - 1];
    if (mayBatch && last && last.length > 0 && last.every(item => item.parallel === true && item.executable !== "unity")) last.push(check);
    else batches.push([check]);
  }
  return batches;
}
