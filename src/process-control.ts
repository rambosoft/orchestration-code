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
