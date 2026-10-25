import { Context } from "@temporalio/activity";

// Where the time of a task goes (B-056). Model stages already log activity.start/complete/fail; the other activities (worktree, dependency install, OpenSpec, publish) did not,
// so a task's 30 to 60 minutes could not be split into "model", "gates" and "everything else". This module times every other activity and turns the event log into a report.
// It lives outside the workflow bundle: it changes no workflow command and no replay fixture.

type Emit = (event: Record<string, unknown>, level?: "info" | "error") => Promise<void>;
export type TimingEvent = Record<string, unknown>;

/** Ids carried by the activity input, when it has them, so an event can be tied to a run. */
function idsOf(args: unknown[]): Record<string, string> {
  const first = args[0];
  if (!first || typeof first !== "object") return {};
  const input = first as Record<string, unknown>;
  const ids: Record<string, string> = {};
  for (const key of ["runId", "taskId", "projectId"]) if (typeof input[key] === "string") ids[key] = input[key] as string;
  return ids;
}

/** One `activity.timed` event per call, success or failure. The event write never changes the activity's result. */
export function timedActivity<Args extends unknown[], Result>(name: string, fn: (...args: Args) => Promise<Result>, emit: Emit): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    const startedAt = Date.now();
    let ok = false;
    try { const result = await fn(...args); ok = true; return result; }
    finally {
      const info = (() => { try { return Context.current().info; } catch { return undefined; } })();
      await emit({ event: "activity.timed", activityType: name, workflowId: info?.workflowExecution?.workflowId, attempt: info?.attempt ?? 1, ...idsOf(args), ok, activityDurationMs: Date.now() - startedAt }, ok ? "info" : "error").catch(() => undefined);
    }
  };
}

export type StageTiming = { name: string; count: number; medianMs: number; p90Ms: number; totalMs: number; failures: number; costUsd: number };
export type TaskTiming = { key: string; project: string; wallMs: number; busyMs: number; idleMs: number; byName: Record<string, number> };
export type TimingSummary = { stages: StageTiming[]; tasks: TaskTiming[]; events: number; withoutTimestamps: number };
export type SummaryOptions = { includeFake?: boolean; since?: string };

export function parseEvents(text: string): TimingEvent[] {
  const events: TimingEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const parsed = JSON.parse(line) as unknown; if (parsed && typeof parsed === "object") events.push(parsed as TimingEvent); } catch { /* a torn last line */ }
  }
  return events;
}

const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const percentile = (sorted: number[], p: number): number => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0;

/** The label a finished event is counted under: the model stage for executeStage, the activity name for everything else. */
function labelOf(event: TimingEvent): string | undefined {
  if (event.event === "activity.timed") return str(event.activityType);
  const stage = str(event.stage);
  return stage ? `${stage}${str(event.provider) && event.provider !== "quality-gate" ? `/${event.provider}` : ""}` : undefined;
}

export function summarizeTiming(all: TimingEvent[], options: SummaryOptions = {}): TimingSummary {
  const since = options.since ? Date.parse(options.since) : undefined;
  const events = all.filter(event => (options.includeFake || event.provider !== "fake") && (since === undefined || !str(event.at) || Date.parse(event.at as string) >= since));
  const finished = events.filter(event => (event.event === "activity.complete" || event.event === "activity.fail" || event.event === "activity.timed") && num(event.activityDurationMs) !== undefined);
  const byLabel = new Map<string, { durations: number[]; failures: number; cost: number }>();
  for (const event of finished) {
    const label = labelOf(event); if (!label) continue;
    const entry = byLabel.get(label) ?? { durations: [], failures: 0, cost: 0 };
    entry.durations.push(num(event.activityDurationMs)!);
    if (event.event === "activity.fail" || event.ok === false) entry.failures++;
    entry.cost += num(event.costUsd) ?? 0;
    byLabel.set(label, entry);
  }
  const stages = [...byLabel].map(([name, entry]) => {
    const sorted = entry.durations.slice().sort((a, b) => a - b);
    return { name, count: sorted.length, medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9), totalMs: sorted.reduce((sum, value) => sum + value, 0), failures: entry.failures, costUsd: entry.cost };
  }).sort((a, b) => b.totalMs - a.totalMs);

  // Wall clock of a task: first activity start to last activity end. Activities run side by side (review with verify), so busy time is the union of the intervals.
  const intervals = new Map<string, { project: string; list: Array<[number, number]>; byName: Record<string, number> }>();
  let withoutTimestamps = 0;
  for (const event of finished) {
    const end = str(event.at) ? Date.parse(event.at as string) : NaN;
    if (!Number.isFinite(end)) { withoutTimestamps++; continue; }
    const key = str(event.workflowId) ?? str(event.runId); if (!key) continue;
    const duration = num(event.activityDurationMs)!;
    const entry = intervals.get(key) ?? { project: str(event.projectId) ?? "", list: [], byName: {} };
    entry.list.push([end - duration, end]);
    const label = labelOf(event) ?? "other";
    entry.byName[label] = (entry.byName[label] ?? 0) + duration;
    if (!entry.project && str(event.projectId)) entry.project = str(event.projectId)!;
    intervals.set(key, entry);
  }
  const tasks = [...intervals].map(([key, entry]) => {
    const list = entry.list.slice().sort((a, b) => a[0] - b[0]);
    let busy = 0; let from = list[0]![0]; let to = list[0]![1];
    for (const [start, end] of list.slice(1)) { if (start <= to) to = Math.max(to, end); else { busy += to - from; from = start; to = end; } }
    busy += to - from;
    const wall = Math.max(...list.map(item => item[1])) - list[0]![0];
    return { key, project: entry.project, wallMs: wall, busyMs: busy, idleMs: Math.max(0, wall - busy), byName: entry.byName };
  }).sort((a, b) => b.wallMs - a.wallMs);
  return { stages, tasks, events: events.length, withoutTimestamps };
}

const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

export function formatTiming(summary: TimingSummary, topTasks = 15): string {
  const lines = [`Activity time by stage (${summary.events} events${summary.withoutTimestamps ? `; ${summary.withoutTimestamps} older events have no timestamp and are left out of the task view` : ""})`, "stage / activity".padEnd(34) + "count  median  p90    total   fail  cost$"];
  for (const stage of summary.stages) lines.push(stage.name.padEnd(34) + `${String(stage.count).padEnd(7)}${minutes(stage.medianMs).padEnd(8)}${minutes(stage.p90Ms).padEnd(7)}${minutes(stage.totalMs).padEnd(8)}${String(stage.failures).padEnd(6)}${stage.costUsd ? stage.costUsd.toFixed(2) : "-"}`);
  lines.push("", "Slowest tasks (minutes): wall clock, busy (activities running), idle (between activities)");
  if (!summary.tasks.length) lines.push("  none: events written before timestamps were added cannot be placed on a timeline");
  for (const task of summary.tasks.slice(0, topTasks)) {
    const top = Object.entries(task.byName).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, ms]) => `${name} ${minutes(ms)}`).join(", ");
    lines.push(`  ${(task.project.slice(0, 8) || "-").padEnd(9)}${task.key.slice(-26).padEnd(28)}wall ${minutes(task.wallMs).padEnd(6)}busy ${minutes(task.busyMs).padEnd(6)}idle ${minutes(task.idleMs).padEnd(6)}${top}`);
  }
  return lines.join("\n");
}
