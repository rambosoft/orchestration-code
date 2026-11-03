import { describe, expect, it } from "vitest";
import { batchTrend, flagHeavyTasks, formatBatchTrend, formatTiming, parseEvents, summarizeTiming, timedActivity, type TaskTiming, type TimingEvent } from "../src/timing.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 9, minute)).toISOString();
const done = (stage: string, minute: number, ms: number, extra: TimingEvent = {}): TimingEvent => ({ event: "activity.complete", at: at(minute), workflowId: "wf-1", runId: "run-1", projectId: "project-a", stage, provider: "claude", ok: true, activityDurationMs: ms, ...extra });

describe("timedActivity", () => {
  it("logs one timed event with the ids of the input, for a success and for a failure, and never changes the result", async () => {
    const events: TimingEvent[] = [];
    const emit = async (event: Record<string, unknown>) => { events.push(event); };
    const ok = timedActivity("prepareWorktree", async (input: { runId: string; taskId: string }) => `${input.runId}!`, emit);
    expect(await ok({ runId: "r1", taskId: "t1" })).toBe("r1!");
    const bad = timedActivity("publishWorktree", async (_input: { runId: string }) => { throw new Error("push rejected"); }, emit);
    await expect(bad({ runId: "r2" })).rejects.toThrow("push rejected");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "activity.timed", activityType: "prepareWorktree", runId: "r1", taskId: "t1", ok: true, attempt: 1 });
    expect(events[1]).toMatchObject({ activityType: "publishWorktree", runId: "r2", ok: false });
    expect(typeof events[0]!.activityDurationMs).toBe("number");
  });
  it("still returns the result when the event cannot be written", async () => {
    const wrapped = timedActivity("buildContextPack", async () => 7, async () => { throw new Error("disk full"); });
    expect(await wrapped()).toBe(7);
  });
});

describe("summarizeTiming", () => {
  it("counts each stage with median, 90th percentile, total, failures and cost, and leaves out the fake provider", () => {
    const events = [
      done("implement", 10, 60_000, { costUsd: 1.5 }), done("implement", 20, 180_000, { costUsd: 2 }), done("implement", 30, 600_000),
      { event: "activity.fail", at: at(31), workflowId: "wf-1", stage: "implement", provider: "claude", activityDurationMs: 1000 },
      done("plan", 5, 5_000, { provider: "fake" }),
      { event: "activity.timed", at: at(2), workflowId: "wf-1", activityType: "prepareProjectDependencies", ok: true, activityDurationMs: 120_000 },
    ];
    const summary = summarizeTiming(events);
    const implement = summary.stages.find(stage => stage.name === "implement/claude")!;
    expect(implement).toMatchObject({ count: 4, failures: 1, totalMs: 841_000, costUsd: 3.5 });
    expect(implement.medianMs).toBe(180_000);
    expect(summary.stages.map(stage => stage.name)).not.toContain("plan/fake");
    expect(summary.stages.map(stage => stage.name)).toContain("prepareProjectDependencies");
    expect(summarizeTiming(events, { includeFake: true }).stages.map(stage => stage.name)).toContain("plan/fake");
  });
  it("separates the wall clock of a task into busy time and idle time, counting parallel activities once", () => {
    const events = [
      { event: "activity.timed", at: at(10), workflowId: "wf-1", runId: "run-1", activityType: "prepareWorktree", ok: true, activityDurationMs: 10 * 60_000 },
      done("implement", 25, 10 * 60_000),
      // review and verify run side by side and both end at minute 30
      done("review", 30, 4 * 60_000, { provider: "codex" }), { event: "activity.complete", at: at(30), workflowId: "wf-1", stage: "verify", provider: "quality-gate", ok: true, activityDurationMs: 4 * 60_000 },
    ];
    const [task] = summarizeTiming(events).tasks;
    expect(task).toMatchObject({ key: "wf-1", project: "project-a", wallMs: 30 * 60_000, busyMs: 24 * 60_000 });
    expect(task!.idleMs).toBe(6 * 60_000);
    expect(task!.byName["implement/claude"]).toBe(10 * 60_000);
  });
  it("keeps events from before timestamps existed out of the task view and says so", () => {
    const summary = summarizeTiming([{ event: "activity.complete", workflowId: "old", stage: "plan", provider: "codex", activityDurationMs: 1000 }]);
    expect(summary.stages[0]!.name).toBe("plan/codex");
    expect(summary.tasks).toEqual([]);
    expect(summary.withoutTimestamps).toBe(1);
    expect(formatTiming(summary)).toContain("no timestamp");
  });
  it("filters by start time and skips a torn last line", () => {
    const text = [JSON.stringify(done("plan", 1, 1000, { provider: "codex" })), JSON.stringify(done("plan", 50, 2000, { provider: "codex" })), "{\"event\":\"activity.compl"].join("\n");
    const events = parseEvents(text);
    expect(events).toHaveLength(2);
    expect(summarizeTiming(events, { since: at(30) }).stages[0]).toMatchObject({ count: 1, totalMs: 2000 });
  });
  it("prints a table with the slowest stage first", () => {
    const text = formatTiming(summarizeTiming([done("plan", 1, 1000, { provider: "codex" }), done("implement", 12, 600_000)]));
    expect(text.indexOf("implement/claude")).toBeLessThan(text.indexOf("plan/codex"));
    expect(text).toContain("Slowest tasks");
  });
});

describe("flagHeavyTasks (B-146)", () => {
  const task = (key: string, project: string, busyMin: number, byName: Record<string, number> = { "implement/claude": busyMin * 60_000 }): TaskTiming => ({ key, project, wallMs: busyMin * 60_000, busyMs: busyMin * 60_000, idleMs: 0, byName, endedAt: 0, repairs: 0, costUsd: 0 });
  const group = (project: string, minutes: number[]) => minutes.map((busy, index) => task(`${project}-${index}`, project, busy));
  it("flags a task at three times the median of its project and names its heaviest activity", () => {
    const tasks = [...group("app", [10, 12, 11, 9]), task("app-heavy", "app", 60, { "implement/claude": 50 * 60_000, verify: 5 * 60_000 })];
    const [heavy, ...rest] = flagHeavyTasks(tasks);
    expect(rest).toEqual([]);
    expect(heavy).toMatchObject({ key: "app-heavy", project: "app", busyMs: 60 * 60_000, medianMs: 11 * 60_000, heaviest: { name: "implement/claude", ms: 50 * 60_000 } });
    expect(heavy!.ratio).toBeCloseTo(60 / 11, 1);
  });
  it("flags nothing for an ordinary spread, a short task, or a project with fewer than four tasks", () => {
    expect(flagHeavyTasks(group("app", [10, 12, 11, 20, 25]))).toEqual([]);
    expect(flagHeavyTasks([...group("app", [1, 1, 1, 1]), task("quick", "app", 6)])).toEqual([]);
    expect(flagHeavyTasks([...group("app", [10, 10]), task("alone", "app", 90)])).toEqual([]);
  });
  it("compares inside a project, not across projects, and lists the heaviest first", () => {
    const tasks = [...group("small", [5, 6, 5, 6]), ...group("big", [60, 62, 61, 63]), task("big-ok", "big", 70), task("small-heavy", "small", 40), task("big-heavy", "big", 600)];
    expect(flagHeavyTasks(tasks).map(item => item.key)).toEqual(["big-heavy", "small-heavy"]);
  });
  it("compares like with like: a long implementation is not measured against quick checks of the same project", () => {
    const quick = group("app", [1, 1, 2, 1, 2]).map(item => ({ ...item, byName: { verify: item.busyMs } }));
    expect(flagHeavyTasks([...quick, task("impl", "app", 45)])).toEqual([]);
  });
  it("is printed by formatTiming only when something is flagged", () => {
    const events: TimingEvent[] = [{ event: "activity.complete", workflowId: "w", stage: "plan", provider: "codex", activityDurationMs: 1000, at: "2026-11-01T10:00:00Z" }];
    expect(formatTiming(summarizeTiming(events))).not.toContain("Heavy tasks");
    const summary = { ...summarizeTiming(events), tasks: [...group("app", [10, 12, 11, 9]), task("app-heavy", "app", 60, { "implement/claude": 50 * 60_000 })] };
    const text = formatTiming(summary);
    for (const expected of ["Heavy tasks", "app-heavy", "implement/claude 50.0"]) expect(text).toContain(expected);
  });
});

describe("batchTrend (B-137): is later work cheaper than the first?", () => {
  /** A task that finishes at `end` minutes: an implement run per entry of `runs` (more than one is a repair), costing `cost` in total. */
  const taskEvents = (id: string, start: number, runs: number[], cost: number): TimingEvent[] => {
    let minute = start;
    return runs.map((duration, index) => { const event = done("implement", minute + duration, duration * 60_000, { workflowId: id, runId: id, costUsd: index === 0 ? cost : 0 }); minute += duration; return event; });
  };
  const summary = () => summarizeTiming([
    ...taskEvents("t1", 0, [10, 8], 3), ...taskEvents("t2", 20, [12, 9], 4), ...taskEvents("t3", 40, [6], 1), ...taskEvents("t4", 50, [5], 1), ...taskEvents("t5", 60, [4], 0.5),
  ], { includeFake: true });
  it("counts the repair rounds and the cost of each task, and orders tasks by when they finished", () => {
    const tasks = summary().tasks.sort((a, b) => a.endedAt - b.endedAt);
    expect(tasks.map(task => task.key)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(tasks.map(task => task.repairs)).toEqual([1, 1, 0, 0, 0]);
    expect(tasks.map(task => task.costUsd)).toEqual([3, 4, 1, 1, 0.5]);
  });
  it("shows a falling line: the second batch is faster, needs fewer repairs and costs less", () => {
    const batches = batchTrend(summary().tasks, { size: 2 });
    expect(batches.map(batch => [batch.batch, batch.tasks])).toEqual([[1, 2], [2, 2], [3, 1]]);
    expect(batches[0]!.repairsPerTask).toBe(1);
    expect(batches[1]!.repairsPerTask).toBe(0);
    expect(batches[1]!.medianBusyMs).toBeLessThan(batches[0]!.medianBusyMs);
    expect(batches[1]!.costUsd).toBeLessThan(batches[0]!.costUsd);
    const text = formatBatchTrend(batches, 2);
    expect(text).toContain("batch 1");
    expect(text).toContain("repairs 1.0");
    expect(text).toContain("cost $7.00");
  });
  it("limits the view to one project and handles no tasks", () => {
    const other = summarizeTiming([done("implement", 5, 300_000, { workflowId: "x", runId: "x", projectId: "project-b" })], { includeFake: true });
    expect(batchTrend([...summary().tasks, ...other.tasks], { size: 5, project: "project-b" }).map(batch => batch.tasks)).toEqual([1]);
    expect(batchTrend([], { size: 3 })).toEqual([]);
    expect(formatBatchTrend([], 3)).toBe("No finished tasks to group into batches.");
  });
});
