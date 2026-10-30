// Pure rules for a durable provider pause (workflow-safe: no clock, no I/O). A usage limit or a lost connection is not a task failure: the stage waits on a Temporal timer and runs again,
// without using up its retry attempts. The activity decides whether a failure is a pause (src/provider-gate.ts); the workflow decides how long to wait (this file).
export type PauseKind = "quota" | "network";
export type PauseDetails = { kind: PauseKind; /** Wait the provider asked for (a reset time or Retry-After), when it said. */ waitMs?: number; reason: string };
/** ApplicationFailure type the activity throws for a pause; the workflow recognises it by this name. */
export const PROVIDER_PAUSE = "ProviderPause";
/** A stage never waits longer than this in total (the workflow itself is bounded at 48 hours); after it the failure surfaces and the classifier decides. */
export const MAX_PAUSE_TOTAL_MS = 24 * 3_600_000;
const MARGIN_MS = 60_000;
const NETWORK_STEPS_MS = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];
const QUOTA_STEPS_MS = [900_000, 1_800_000, 3_600_000];

/** How long to sleep before the `index`-th retry (0-based): the provider's own wait plus a margin when it gave one (the caller compares it with MAX_PAUSE_TOTAL_MS), otherwise a growing schedule that ends in a steady cadence. */
export function pauseWaitMs(kind: PauseKind, hintMs: number | undefined, index: number): number {
  if (hintMs !== undefined && Number.isFinite(hintMs) && hintMs > 0) return hintMs + MARGIN_MS;
  const steps = kind === "quota" ? QUOTA_STEPS_MS : NETWORK_STEPS_MS;
  return steps[Math.min(Math.max(0, index), steps.length - 1)]!;
}

/** The pause carried by a failed activity, if it is one. Works on the ActivityFailure the workflow catches and on the bare ApplicationFailure. */
export function pauseFrom(error: unknown): PauseDetails | undefined {
  let current = error as { type?: unknown; details?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current.type === PROVIDER_PAUSE && Array.isArray(current.details)) {
      const detail = current.details[0] as Partial<PauseDetails> | undefined;
      if (detail && (detail.kind === "quota" || detail.kind === "network")) return { kind: detail.kind, ...(typeof detail.waitMs === "number" ? { waitMs: detail.waitMs } : {}), reason: String(detail.reason ?? "") };
    }
    current = current.cause as typeof current;
  }
  return undefined;
}
