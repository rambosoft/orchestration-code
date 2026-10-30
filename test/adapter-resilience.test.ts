import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The Paperclip adapter is published as JavaScript without a declaration file.
import { createServerAdapter } from "../paperclip-adapter/index.js";

// Regression: a Paperclip server stall of several minutes made Paperclip abort the adapter ("Legacy controller lease lost"), and the adapter then
// cancelled a healthy Temporal workflow, killing a 10-minute implementation. Only a real cancel may cancel.
type Call = { method: string; url: string; body?: Record<string, unknown> };
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function setup(pollResponse: (n: number, controller: AbortController) => Response | Promise<Response>, blockedBy: Array<{ id: string; status: string }> = [], comments: Array<Record<string, unknown>> = [], executionBlocker?: Record<string, unknown>, issueRuns: Array<Record<string, unknown>> = []) {
  const calls: Call[] = []; const logs: string[] = []; let polls = 0;
  const controller = new AbortController();
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input); const method = init?.method ?? "GET"; calls.push({ method, url, ...(init?.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
    if (url.endsWith("/api/issues/ISSUE") && method === "GET") return Response.json({ id: "ISSUE", title: "Task", description: "Do it", projectId: "p1", updatedAt: "2026-10-23T00:00:00Z", blockedBy, ...(executionBlocker ? { executionBlocker } : {}) });
    if (url.endsWith("/api/issues/ISSUE") && method === "PATCH") { calls[calls.length - 1]!.body = JSON.parse(init!.body!) as Record<string, unknown>; return Response.json({}); }
    if (url.endsWith("/api/issues/ISSUE/runs")) return Response.json(issueRuns);
    if (url.includes("/api/issues/ISSUE/comments?")) return Response.json(comments);
    if (url.endsWith("/v1/runs") && method === "POST") return Response.json({ workflowId: "wf-1" }, { status: 202 });
    if (/\/v1\/runs\/[^/]+\/resume$/.test(url) && method === "POST") return Response.json({ workflowId: "wf-1" }, { status: 202 });
    if (/\/v1\/runs\/wf-1$/.test(url) && method === "GET") return pollResponse(++polls, controller);
    return Response.json({});
  }) as typeof fetch;
  const ctx = {
    runId: "run-1", authToken: "t", signal: controller.signal, onLog: async (_stream: string, text: string) => { logs.push(text); },
    context: { taskId: "ISSUE", issueId: "ISSUE", updatedAt: "2026-10-23T00:00:00Z" },
    config: { bridgeUrl: "http://bridge", bridgeToken: "b", paperclipApiUrl: "http://paperclip", paperclipApiToken: "t", profile: "implementation", pollIntervalMs: 5, retryDelayMs: 5 },
  };
  return { ctx, calls, logs, controller };
}
const running = () => Response.json({ workflowId: "wf-1", status: "RUNNING", progress: { currentStage: "implement" } });
const adapter = createServerAdapter();

describe("Paperclip adapter resilience", () => {
  it("leaves the workflow running when Paperclip loses its controller lease", async () => {
    const { ctx, calls, logs } = setup((n, controller) => { if (n === 3) controller.abort(new Error("Legacy controller lease lost")); return running(); });
    const result = await adapter.execute(ctx);
    expect(result.errorMessage).toContain("lease lost");
    expect(result.errorMessage).toContain("left running");
    expect(calls.some(call => call.url.endsWith("/cancel"))).toBe(false);
    expect(logs.join("")).toContain("leaving Temporal workflow wf-1 running");
  });

  it("still cancels the workflow when the abort is a real cancellation", async () => {
    const { ctx, calls } = setup((n, controller) => { if (n === 2) controller.abort(new Error("cancelled by board user")); return running(); });
    await adapter.execute(ctx);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs/wf-1/cancel"))).toBe(true);
  });

  it("defers a premature dependency wake without failing the Paperclip run or dispatching Temporal", async () => {
    const { ctx, calls, logs } = setup(() => running(), [{ id: "BLOCKER", status: "in_progress" }]);
    const result = await adapter.execute(ctx);
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.summary).toContain("Temporal dispatch deferred");
    expect(calls.find(call => call.method === "PATCH" && call.url.endsWith("/api/issues/ISSUE"))?.body).toEqual({ status: "blocked", blockedByIssueIds: ["BLOCKER"] });
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs"))).toBe(false);
    expect(logs.join("")).toContain("remains blocked");
  });

  it("uses the completed Temporal publication when Paperclip has no publication comment", async () => {
    const { ctx, calls } = setup(() => Response.json({
      workflowId: "wf-1", status: "COMPLETED",
      result: { runId: "r", status: "completed", message: "done", publish: { branch: "codex/parent", headSha: "a".repeat(40), prUrl: "https://github.com/me/game/pull/4" }, stages: [], artifactRefs: [] },
    }), [{ id: "PARENT", status: "done" }]);
    const mockedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (url === "http://bridge/v1/runs" && (init?.method ?? "GET") === "GET") return Response.json([{ workflowId: "pc-PARENT-revision-1", status: "COMPLETED" }]);
      if (url.endsWith("/v1/runs/pc-PARENT-revision-1")) return Response.json({ status: "COMPLETED", result: { status: "completed", publish: { branch: "codex/parent", headSha: "a".repeat(40), prUrl: "https://github.com/me/game/pull/4" } } });
      return mockedFetch(input as RequestInfo, init as RequestInit);
    }) as typeof fetch;
    await adapter.execute(ctx);
    const dispatch = calls.find(call => call.method === "POST" && call.url.endsWith("/v1/runs"));
    expect(dispatch?.body?.parentPublications).toEqual([{ issueId: "PARENT", branch: "codex/parent", headSha: "a".repeat(40), prUrl: "https://github.com/me/game/pull/4" }]);
  });

  it("refuses dispatch while Paperclip has an unresolved execution recovery hold", async () => {
    const { ctx, calls } = setup(() => running(), [], [], { recoveryActionId: "action-1", runId: "run-1" });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("execution recovery is held");
    expect(result.errorMessage).toContain("action-1");
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs"))).toBe(false);
  });

  it("survives transient bridge errors and network failures while polling", async () => {
    let seen = 0;
    const { ctx } = setup(n => {
      seen = n;
      if (n === 1) return new Response("bad gateway", { status: 502 });
      if (n === 2) throw new TypeError("fetch failed");
      return Response.json({ workflowId: "wf-1", status: "COMPLETED", result: { runId: "r", status: "failed", message: "stopped for test", stages: [], artifactRefs: [] } });
    });
    const result = await adapter.execute(ctx);
    expect(seen).toBe(3);
    expect(result.errorMessage ?? "").not.toContain("Workflow inspection failed");
  });

  it("records a terminal workflow failure as a blocked task instead of a generic adapter failure", async () => {
    const { ctx, calls } = setup(() => Response.json({
      workflowId: "wf-1", status: "COMPLETED",
      result: { runId: "r", status: "failed", message: "Unity license prerequisite unavailable", stages: [], artifactRefs: [] },
    }));
    const result = await adapter.execute(ctx);
    expect(result).toMatchObject({ exitCode: 0, signal: null, summary: "Unity license prerequisite unavailable" });
    expect(calls.find(call => call.method === "PATCH" && call.url.endsWith("/api/issues/ISSUE"))?.body).toMatchObject({ status: "blocked" });
    expect(calls.find(call => call.method === "PATCH" && call.url.endsWith("/api/issues/ISSUE"))?.body?.comment).toContain("Unity license prerequisite unavailable");
  });

  it("resumes the failed Temporal workflow named by Paperclip recovery context", async () => {
    const { ctx, calls, logs } = setup(() => Response.json({
      workflowId: "wf-1", status: "COMPLETED",
      result: { runId: "r", status: "failed", message: "Unity license prerequisite unavailable", stages: [], artifactRefs: [] },
    }), [], [{
      createdByRunId: "source-paperclip-run",
      body: "Temporal workflow `pc-ISSUE-revision-1` finished with status **failed**.",
    }]);
    Object.assign(ctx, { executionContinuation: { version: 1, trigger: { reason: "retry_failed_run", sourceRunId: "source-paperclip-run" } } });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs/pc-ISSUE-revision-1/resume"))).toBe(true);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs"))).toBe(false);
    expect(logs.join("")).toContain("completed stages and its preserved worktree are reused");
  });

  it("resumes the newest failed Temporal sibling when Paperclip links recovery to an older retry ancestor", async () => {
    const latestWorkflow = "pc-ISSUE-2026-10-27T21-55-37.958Z-a1";
    const { ctx, calls } = setup(() => Response.json({
      workflowId: "wf-1", status: "COMPLETED",
      result: { runId: "r", status: "failed", message: "quality gate failed", stages: [], artifactRefs: [] },
    }), [], [
      { createdByRunId: "old-paperclip-run", body: "Temporal workflow `pc-ISSUE-2026-10-27T21-38-49.920Z-a1` finished with status **failed**." },
      { createdByRunId: "latest-paperclip-run", body: "Temporal workflow `" + latestWorkflow + "` finished with status **failed**." },
    ], undefined, [
      { runId: "old-paperclip-run", status: "failed", startedAt: "2026-10-27T21:38:49Z", finishedAt: "2026-10-27T21:50:04Z" },
      { runId: "latest-paperclip-run", status: "failed", startedAt: "2026-10-27T21:55:37Z", finishedAt: "2026-10-27T22:07:36Z" },
    ]);
    Object.assign(ctx, { executionContinuation: { version: 1, trigger: { reason: "recover_stopped_run", sourceRunId: "old-paperclip-run" } } });
    await adapter.execute(ctx);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith(`/v1/runs/${latestWorkflow}/resume`))).toBe(true);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs/pc-ISSUE-2026-10-27T21-38-49.920Z-a1/resume"))).toBe(false);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs"))).toBe(false);
  });

  it("reuses the published needs_review workflow when a stale retry follows a successful sibling run", async () => {
    const publishedWorkflow = "pc-ISSUE-2026-10-26-a1-resume1";
    const { ctx, calls, logs } = setup(() => Response.json({
      workflowId: "wf-1", status: "COMPLETED",
      result: { runId: "r", status: "needs_review", message: "quality gates passed; PR published", publish: { prUrl: "https://github.com/me/game/pull/3" }, stages: [], artifactRefs: [] },
    }), [], [
      { createdByRunId: "source-paperclip-run", body: "Temporal workflow `pc-ISSUE-old-a1` finished with status **failed**." },
      { createdByRunId: "successful-paperclip-run", body: `Temporal workflow \`${publishedWorkflow}\` finished with status **needs_review**.\n<!-- orchestration-publish {\"prUrl\":\"https://github.com/me/game/pull/3\"} -->` },
    ], undefined, [
      { runId: "source-paperclip-run", status: "cancelled" },
      { runId: "successful-paperclip-run", status: "succeeded", startedAt: "2026-10-26T15:00:00Z" },
    ]);
    Object.assign(ctx, { executionContinuation: { version: 1, trigger: { reason: "retry_failed_run", sourceRunId: "source-paperclip-run" } } });
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith(`/v1/runs/${publishedWorkflow}/resume`))).toBe(true);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs/pc-ISSUE-old-a1/resume"))).toBe(false);
    expect(calls.some(call => call.method === "POST" && call.url.endsWith("/v1/runs"))).toBe(false);
    expect(logs.join("")).toContain("reusing the latest successful review workflow");
  });

  it("gives up after a sustained outage instead of polling forever", async () => {
    const { ctx } = setup(() => new Response("down", { status: 503 }));
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Workflow inspection failed 60 times in a row");
  }, 20_000);
});
