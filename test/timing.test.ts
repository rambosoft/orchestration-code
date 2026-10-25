import { describe, expect, it } from "vitest";
import { formatTiming, parseEvents, summarizeTiming, timedActivity, type TimingEvent } from "../src/timing.js";

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
