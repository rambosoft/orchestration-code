export type DrainDeps = {
  /** Workflow ids that are still RUNNING. */
  activeRuns: () => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};
export type DrainResult = { drained: boolean; active: string[]; waitedMs: number };

/** Wait until no run is in flight, up to `waitMs` (0 = check once and refuse). Restarting the worker or bridge while a run is active interrupts it, so a deploy calls this first. */
export async function waitForDrain(deps: DrainDeps, options: { waitMs: number; pollMs?: number }): Promise<DrainResult> {
  const started = deps.now();
  const pollMs = options.pollMs ?? 15_000;
  for (;;) {
    const active = await deps.activeRuns();
    const waitedMs = deps.now() - started;
    if (active.length === 0) return { drained: true, active, waitedMs };
    if (waitedMs + pollMs > options.waitMs) return { drained: false, active, waitedMs };
    await deps.sleep(pollMs);
  }
}

export function formatDrain(result: DrainResult): string {
  return result.drained
    ? `drained: no runs in flight (waited ${Math.round(result.waitedMs / 1000)}s)`
    : `refusing: ${result.active.length} run(s) still active after ${Math.round(result.waitedMs / 1000)}s (${result.active.map(id => id.slice(0, 40)).join(", ")}); wait for them or cancel with "dev cancel <workflowId>"`;
}
