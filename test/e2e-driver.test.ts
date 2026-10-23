import { describe, expect, it } from "vitest";
import { runChain, summarizeStages, totals, type TaskOutcome } from "../src/e2e.js";

const stage = (name: string, provider: string, usage?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ stage: name, ok: true, summary: "", findings: [], artifactRefs: [], provider, durationMs: 4200, metadata: usage ? extra.codex ? { codexActivity: { usage } } : { usage } : undefined });

describe("e2e driver", () => {
  it("summarizes timing and token usage across the codex and claude shapes", () => {
    const stages = summarizeStages({ stages: [stage("plan", "codex", { input_tokens: 10, output_tokens: 3 }, { codex: true }), stage("implement", "claude", { input_tokens: 100, output_tokens: 40 }), stage("review", "openrouter", { prompt_tokens: 7, completion_tokens: 2 }), stage("verify", "quality-gate")] as never });
    expect(stages.map(s => [s.stage, s.inputTokens, s.outputTokens, s.seconds])).toEqual([["plan", 10, 3, 4], ["implement", 100, 40, 4], ["review", 7, 2, 4], ["verify", undefined, undefined, 4]]);
    const sum = totals([{ stages } as TaskOutcome]);
    expect(sum.inputTokens).toBe(117); expect(sum.byProvider.claude!.outputTokens).toBe(40);
  });

  function fakeBridge(script: Array<"completed" | "failed">) {
    const started: Array<Record<string, unknown>> = []; let i = 0;
    const http = async (method: string, path: string, body?: unknown) => {
      if (method === "POST") { started.push(body as Record<string, unknown>); return { status: 202, json: { workflowId: `wf-${started.length}` } }; }
      const outcome = script[started.length - 1]!; i++;
      const publish = { branch: `codex/b${started.length}`, baseSha: "a".repeat(40), headSha: String(started.length).repeat(40).slice(0, 40), prUrl: `https://github.com/x/y/pull/${started.length}`, prBaseBranch: "main" };
      return { status: 200, json: { status: "COMPLETED", result: { runId: "r", status: outcome, stages: [stage("plan", "codex")], artifactRefs: [], message: outcome === "failed" ? "boom" : "ok", metadata: { review: { stopReason: outcome === "failed" ? "openspec_stage_failed" : undefined } }, ...(outcome === "completed" ? { publish } : {}) } } };
    };
    return { http: http as never, started, polls: () => i };
  }
  const spec = { projectId: "p", tasks: [{ taskId: "T-1", prompt: "one" }, { taskId: "T-2", prompt: "two" }] };
  const opts = { pollMs: 0, sleep: async () => undefined };

  it("stacks each task on the previous task's published branch", async () => {
    const bridge = fakeBridge(["completed", "completed"]);
    const outcomes = await runChain(spec, bridge.http, opts);
    expect(outcomes.map(o => o.status)).toEqual(["completed", "completed"]);
    expect(bridge.started[0]!.parentPublications).toEqual([]);
    expect(bridge.started[1]!.parentPublications).toEqual([{ issueId: "T-1", branch: "codex/b1", headSha: "1".repeat(40), prUrl: "https://github.com/x/y/pull/1" }]);
  });
  it("can start the chain on an already published parent branch", async () => {
    const bridge = fakeBridge(["completed"]);
    const parent = { issueId: "OLD", branch: "codex/old", headSha: "f".repeat(40), prUrl: "https://github.com/x/y/pull/9" };
    await runChain({ projectId: "p", parent, tasks: [{ taskId: "T-1", prompt: "one" }] }, bridge.http, opts);
    expect(bridge.started[0]!.parentPublications).toEqual([parent]);
  });
  it("stops the chain at the first failure and reports the stop reason", async () => {
    const outcomes = await runChain(spec, fakeBridge(["failed"]).http, opts);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "failed", stopReason: "openspec_stage_failed", message: "boom" });
  });
  it("retries a failed task under the next attempt number when allowed", async () => {
    const bridge = fakeBridge(["failed", "completed", "completed"]);
    const outcomes = await runChain(spec, bridge.http, { ...opts, maxAttempts: 2 });
    expect(outcomes.map(o => [o.taskId, o.attempt, o.status])).toEqual([["T-1", 2, "completed"], ["T-2", 1, "completed"]]);
    expect(bridge.started.map(s => s.attempt)).toEqual([1, 2, 1]);
  });
  it("reports a bridge rejection as an error outcome", async () => {
    const outcomes = await runChain(spec, (async () => ({ status: 400, json: { error: "nope" } })) as never, opts);
    expect(outcomes[0]).toMatchObject({ status: "error" });
    expect(outcomes[0]!.message).toContain("nope");
  });
});
