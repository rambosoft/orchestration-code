import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The Paperclip adapter is published as JavaScript without a declaration file.
import { createServerAdapter } from "../paperclip-adapter/index.js";

// A project bootstrap (ADR 0009) publishes no pull request, so the adapter must still close its Paperclip task on success and cancel it when the plan is rejected.
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

type Patch = { status?: string; comment?: string };
function setup(result: Record<string, unknown>) {
  const patches: Patch[] = []; const comments: string[] = []; const started: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input); const method = init?.method ?? "GET";
    if (url.endsWith("/api/issues/ISSUE") && method === "GET") return Response.json({ id: "ISSUE", title: "Bootstrap Shop", description: "x", projectId: "p1", updatedAt: "2026-10-23T00:00:00Z", blockedBy: [], labels: [{ name: "type:bootstrap" }] });
    if (url.endsWith("/api/issues/ISSUE") && method === "PATCH") { patches.push(JSON.parse(init!.body!) as Patch); return Response.json({}); }
    if (url.endsWith("/api/issues/ISSUE/comments") && method === "POST") { comments.push((JSON.parse(init!.body!) as { body: string }).body); return Response.json({}); }
    if (url.endsWith("/v1/runs") && method === "POST") { started.push(JSON.parse(init!.body!) as Record<string, unknown>); return Response.json({ workflowId: "wf-1" }, { status: 202 }); }
    if (/\/v1\/runs\/wf-1$/.test(url)) return Response.json({ workflowId: "wf-1", status: "COMPLETED", result });
    return Response.json({});
  }) as typeof fetch;
  const ctx = {
    runId: "run-1", authToken: "t", signal: new AbortController().signal, onLog: async () => undefined,
    context: { taskId: "ISSUE", issueId: "ISSUE", updatedAt: "2026-10-23T00:00:00Z" },
    config: { bridgeUrl: "http://bridge", bridgeToken: "b", paperclipApiUrl: "http://paperclip", paperclipApiToken: "t", profile: "implementation", pollIntervalMs: 5, retryDelayMs: 5 },
  };
  return { ctx, patches, comments, started };
}
const adapter = createServerAdapter();

describe("Paperclip adapter and project bootstrap", () => {
  it("forwards the task type label, so the bridge can recognise a bootstrap", async () => {
    const { ctx, started } = setup({ runId: "r", status: "failed", message: "x", stages: [], artifactRefs: [], metadata: { taskType: "bootstrap" } });
    await adapter.execute(ctx);
    expect(started[0]!.labels).toEqual(["type:bootstrap"]);
  });
  it("marks the task done and posts the plan when the project was created", async () => {
    const { ctx, patches } = setup({ runId: "r", status: "completed", message: "project created: 6 Paperclip issues", stages: [], artifactRefs: [], metadata: { taskType: "bootstrap" }, bootstrap: { issues: [{}] }, report: { title: "Project plan: Shop", markdown: "# Project plan: Shop" } });
    const outcome = await adapter.execute(ctx);
    expect(outcome.exitCode).toBe(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.status).toBe("done");
    expect(patches[0]!.comment).toContain("# Project plan: Shop");
  });
  it("cancels the task when the plan was rejected", async () => {
    const { ctx, patches } = setup({ runId: "r", status: "rejected", message: "the project plan was rejected; nothing was created", stages: [], artifactRefs: [], metadata: { taskType: "bootstrap" } });
    await adapter.execute(ctx);
    expect(patches[0]!.status).toBe("cancelled");
  });
  it("leaves a failed bootstrap open with guidance that names what may exist", async () => {
    const { ctx, patches, comments } = setup({ runId: "r", status: "failed", message: "scaffold step failed: npm install failed", stages: [], artifactRefs: [], metadata: { taskType: "bootstrap" } });
    const outcome = await adapter.execute(ctx);
    expect(patches).toHaveLength(0);
    expect(outcome.exitCode).toBe(1);
    expect(comments.join("\n")).toContain("Project not created");
  });
  it("does not change how an ordinary completed task without a pull request is treated", async () => {
    const { ctx, patches } = setup({ runId: "r", status: "completed", message: "ok", stages: [], artifactRefs: [], metadata: { taskType: "task" } });
    await adapter.execute(ctx);
    expect(patches).toHaveLength(0);
  });
});
