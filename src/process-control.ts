import { spawn, type ChildProcess } from "node:child_process";
import { Context } from "@temporalio/activity";

/** Cancellation signal of the running Temporal activity, or undefined when called outside one (unit tests, CLI). */
export function activitySignal(): AbortSignal | undefined {
  try { return Context.current().cancellationSignal; } catch { return undefined; }
}

export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  else child.kill("SIGKILL");
}

/** Kill the child when the signal aborts. Returns a cleanup function. */
export function killOnAbort(child: ChildProcess, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => killProcessTree(child);
  if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Wrap an activity so it heartbeats on a timer: a lost worker is then detected by heartbeatTimeout (about a minute) instead of the full start-to-close timeout. Outside an activity (unit tests) it is a no-op. */
export function heartbeating<Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>, intervalMs = 10_000): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    let timer: NodeJS.Timeout | undefined;
    try { const context = Context.current(); timer = setInterval(() => context.heartbeat(), intervalMs); } catch { /* not inside an activity */ }
    try { return await fn(...args); } finally { if (timer) clearInterval(timer); }
  };
}
