import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The Paperclip adapter is published as JavaScript without a declaration file.
import { createServerAdapter } from "../paperclip-adapter/index.js";

// Regression: a Paperclip server stall of several minutes made Paperclip abort the adapter ("Legacy controller lease lost"), and the adapter then
// cancelled a healthy Temporal workflow, killing a 10-minute implementation. Only a real cancel may cancel.
type Call = { method: string; url: string };
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function setup(pollResponse: (n: number, controller: AbortController) => Response | Promise<Response>) {
  const calls: Call[] = []; const logs: string[] = []; let polls = 0;
  const controller = new AbortController();
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input); const method = init?.method ?? "GET"; calls.push({ method, url });
    if (url.endsWith("/api/issues/ISSUE")) return Response.json({ id: "ISSUE", title: "Task", description: "Do it", projectId: "p1", updatedAt: "2026-10-23T00:00:00Z", blockedBy: [] });
    if (url.endsWith("/v1/runs") && method === "POST") return Response.json({ workflowId: "wf-1" }, { status: 202 });
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

  it("gives up after a sustained outage instead of polling forever", async () => {
    const { ctx } = setup(() => new Response("down", { status: 503 }));
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Workflow inspection failed 60 times in a row");
  }, 20_000);
});
