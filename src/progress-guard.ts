/** Judges whether a long implement run is still making progress; pure so the clock is the caller's. */
export type ProgressLimits = { firstEditMs: number; idleMs: number };
export type ProgressState = { startedAt: number; now: number; firstChangeAt?: number; /** Last file change or command/turn activity. */ lastProgressAt: number };

/** no_first_edit: no file change yet and firstEditMs have passed since the start. idle: after the first change, idleMs without a file change or command. */
export function progressVerdict(state: ProgressState, limits: ProgressLimits): "ok" | "no_first_edit" | "idle" {
  if (state.firstChangeAt === undefined) return state.now - state.startedAt >= limits.firstEditMs ? "no_first_edit" : "ok";
  return state.now - state.lastProgressAt >= limits.idleMs ? "idle" : "ok";
}
