// The worker reports a finished run to its Paperclip issue (ADR 0018). Unit tests use a fake Paperclip; workflow tests run the real workflow with a stub report activity.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { RunInput, RunResult, StageInput, StageOutput } from "../src/contracts.js";
import { reportResultTo } from "../src/result-report.js";
import { projectWorkflow } from "../src/workflows.js";

const publish = { branch: "codex/t-a1", baseSha: "a".repeat(40), headSha: "b".repeat(40), prUrl: "https://github.com/o/r/pull/7", prBaseBranch: "main" };
const result = (over: Partial<RunResult> = {}): RunResult => ({ runId: "r", status: "completed", stages: [], artifactRefs: [], message: "all gates passed", publish, ...over } as RunResult);
function fakePaperclip(existing: string[] = []) {
  const calls: Array<{ method: string; route: string; body?: Record<string, unknown> }> = [];
  const client = (async (method: string, route: string, body?: unknown) => { calls.push({ method, route, ...(body ? { body: body as Record<string, unknown> } : {}) }); return method === "GET" ? existing.map(text => ({ body: text })) : {}; }) as never;
  return { calls, client };
}

describe("reportResultTo", () => {
  it("marks a published task done with the result as its comment", async () => {
    const { calls, client } = fakePaperclip();
    expect(await reportResultTo(client, { workflowId: "pc-T1-1-a1", issueId: "T1", result: result() })).toEqual({ reported: true, reason: "reported" });
    const patch = calls.find(call => call.method === "PATCH")!;
    expect(patch.route).toBe("/api/issues/T1");
    expect(patch.body).toMatchObject({ status: "done" });
    expect(String(patch.body!.comment)).toContain("Temporal workflow `pc-T1-1-a1` finished with status **completed**");
    expect(String(patch.body!.comment)).toContain("orchestration-publish");
    expect(String(patch.body!.comment)).toContain("Reported by the orchestrator worker");
  });
  it("puts a result that needs a decision in review and a bug that needs information on hold", async () => {
    const review = fakePaperclip(); await reportResultTo(review.client, { workflowId: "w1", issueId: "T1", result: result({ status: "needs_review" }) });
    expect(review.calls.find(call => call.method === "PATCH")!.body).toMatchObject({ status: "in_review" });
    const info = fakePaperclip(); await reportResultTo(info.client, { workflowId: "w2", issueId: "T1", result: result({ status: "needs_info", publish: undefined }) });
    expect(info.calls.find(call => call.method === "PATCH")!.body).toMatchObject({ status: "blocked" });
  });
  it("posts once: a result the adapter or an earlier try already put on the task is left alone", async () => {
    const { calls, client } = fakePaperclip(["Temporal workflow `pc-T1-1-a1` finished with status **completed**. ok"]);
    expect(await reportResultTo(client, { workflowId: "pc-T1-1-a1", issueId: "T1", result: result() })).toEqual({ reported: true, reason: "already_reported" });
    expect(calls.some(call => call.method !== "GET")).toBe(false);
  });
  it("never comments on a failed run, a bootstrap run or an unconfigured worker", async () => {
    const failed = fakePaperclip();
    expect(await reportResultTo(failed.client, { workflowId: "w", issueId: "T1", result: result({ status: "failed", publish: undefined }) })).toEqual({ reported: false, reason: "no_status" });
    expect(failed.calls).toEqual([]);
    const boot = fakePaperclip();
    expect((await reportResultTo(boot.client, { workflowId: "w", issueId: "T1", result: result({ metadata: { taskType: "bootstrap" } as never }) })).reason).toBe("bootstrap");
    expect(boot.calls).toEqual([]);
    expect(await reportResultTo(undefined, { workflowId: "w", issueId: "T1", result: result() })).toEqual({ reported: false, reason: "not_configured" });
  });
});

describe("workflow report step", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  async function run(extra: Partial<RunInput>, report: (call: { workflowId: string; issueId: string; result: RunResult }) => Promise<unknown>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-report-"));
    const worktree = path.join(root, "worktree"); await mkdir(worktree);
    const activities = {
      checkDependencies: async () => undefined,
      prepareWorktree: async () => worktree,
      prepareProjectDependencies: async () => ({ installed: true, summary: "ready" }),
      assessChanges: async () => ({ files: ["src/a.ts"], lines: 5, deletedFiles: [] }),
      reportResult: report,
      executeStage: async (input: StageInput): Promise<StageOutput> => ({ stage: input.stage, ok: true, summary: input.stage === "review" ? "Review passed" : `Completed ${input.stage}`, findings: [], ...(input.stage === "review" ? { review: { verdict: "pass" as const, findings: [], notes: [] } } : {}), artifactRefs: [], provider: input.provider, durationMs: 0 }),
      collectWorktree: async () => path.join(root, "worktree.patch"),
      publishWorktree: async ({ repository }: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: repository.branch, baseSha: repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/o/r/pull/1", prBaseBranch: repository.prBaseBranch, draft: true }),
    };
    const taskQueue = `report-${Math.random().toString(36).slice(2)}`;
    const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
    const input = {
      runId: `report-${taskQueue}`, taskId: "ISSUE-9", taskRevision: "rev-1", projectId: "p", profile: "implementation", prompt: "Add a button.", openSpec: false, provider: "fake", providerRouting: {},
      projectRoot: root, artifactsDir: path.join(root, "artifacts"), repository: { remote: "origin", targetBranch: "main", branch: "codex/report-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "Report" },
      approval: false, plugins: [], qualityCommands: [{ executable: "npm", args: ["test"] }], tier: "prototype", lane: "light", ...extra,
    } as unknown as RunInput;
    return worker.runUntil(env.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: `wf-${taskQueue}`, args: [input] }));
  }

  it("reports the result as its last step and marks it, so the adapter does not post it again", async () => {
    const calls: Array<{ workflowId: string; issueId: string; status: string }> = [];
    const outcome = await run({ reportToPaperclip: true }, async call => { calls.push({ workflowId: call.workflowId, issueId: call.issueId, status: call.result.status }); return { reported: true, reason: "reported" }; });
    expect(outcome.status).toBe("completed");
    expect(outcome.reportedToPaperclip).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ issueId: "ISSUE-9", status: "completed" });
    expect(calls[0]!.workflowId).toMatch(/^wf-report-/);
  }, 60_000);
  it("does not report a run started without the flag (every run recorded before this existed)", async () => {
    let called = 0;
    const outcome = await run({}, async () => { called++; return { reported: true, reason: "reported" }; });
    expect(outcome.status).toBe("completed");
    expect(called).toBe(0);
    expect(outcome.reportedToPaperclip).toBeUndefined();
  }, 60_000);
  it("keeps the result when Paperclip cannot be reached, and leaves the report to the adapter and the reconcile step", async () => {
    const outcome = await run({ reportToPaperclip: true }, async () => { throw new Error("Paperclip down"); });
    expect(outcome.status).toBe("completed");
    expect(outcome.reportedToPaperclip).toBeUndefined();
  }, 120_000);
  it("does not mark a result the worker chose not to report", async () => {
    const outcome = await run({ reportToPaperclip: true }, async () => ({ reported: false, reason: "not_configured" }));
    expect(outcome.reportedToPaperclip).toBeUndefined();
  }, 60_000);
});
