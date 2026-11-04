// Task-size gate, workflow side (B-183): the admitted stage list, the progress limits and the size evidence reach the REAL workflow; a run without the new fields takes its old path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { RunInput, StageInput, StageOutput } from "../src/contracts.js";
import { escalationReasons, type ChangeStats } from "../src/lanes.js";
import { executeStage as realExecuteStage } from "../src/activities.js";
import { projectWorkflow } from "../src/workflows.js";
import { FakeProvider } from "../src/providers.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
const sizing = { firstEditMinutes: 15, idleMinutes: 10, largeMinFiles: 5 };
const size = { hint: "large" as const, files: 9, areas: 3, basis: "text" as const, reasons: ["names 9 files"] };

describe("escalationReasons limits", () => {
  it("uses the given file limit and keeps 15 without one", () => {
    const six: ChangeStats = { files: ["a", "b", "c", "d", "e", "f"].map(name => `src/${name}.ts`), lines: 10, deletedFiles: [] };
    expect(escalationReasons(six, false, { maxFiles: 5 })).toEqual(["6 files changed (limit 5)"]);
    expect(escalationReasons(six, false)).toEqual([]);
    const sixteen: ChangeStats = { files: Array.from({ length: 16 }, (_, index) => `src/f${index}.ts`), lines: 10, deletedFiles: [] };
    expect(escalationReasons(sixteen, false)).toEqual(["16 files changed (limit 15)"]);
  });
});

describe("workflow size gate", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  async function run(extra: Partial<RunInput>, options: { changes?: ChangeStats } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-size-"));
    const worktree = path.join(root, "worktree"); await mkdir(worktree);
    const calls: StageInput[] = [];
    const activities = {
      checkDependencies: async () => undefined,
      prepareWorktree: async () => worktree,
      prepareProjectDependencies: async () => ({ installed: true, summary: "ready" }),
      assessChanges: async (): Promise<ChangeStats> => options.changes ?? { files: ["src/a.ts"], lines: 10, deletedFiles: [] },
      // The real activity runs the injected implement failure, so its SizeSuspected classification is what reaches the workflow.
      executeStage: async (input: StageInput): Promise<StageOutput> => {
        calls.push(input);
        if (input.prompt.includes("[INJECT_NO_PROGRESS]")) return realExecuteStage(input);
        return { ...(await new FakeProvider().run(input)), stage: input.stage };
      },
      collectWorktree: async () => path.join(root, "worktree.patch"),
      publishWorktree: async ({ repository }: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: repository.branch, baseSha: repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/o/r/pull/1", prBaseBranch: repository.prBaseBranch, draft: true }),
    };
    const taskQueue = `size-${Math.random().toString(36).slice(2)}`;
    const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowsPath, activities });
    const input = {
      runId: `size-${taskQueue}`, taskId: "SIZE-1", taskRevision: "rev-1", projectId: "p", profile: "implementation", prompt: "Add a percentage button.\n\nAcceptance criteria:\n- The button shows a percentage.", openSpec: false, provider: "fake", providerRouting: {},
      projectRoot: root, artifactsDir: path.join(root, "artifacts"), repository: { remote: "origin", targetBranch: "main", branch: "codex/size-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "Size" },
      approval: false, plugins: [], qualityCommands: [{ executable: "npm", args: ["test"] }], ...extra,
    } as unknown as RunInput;
    const workflowId = `wf-${taskQueue}`;
    const result = await worker.runUntil(env.client.workflow.execute(projectWorkflow, { taskQueue, workflowId, args: [input] }));
    // The new code paths must themselves replay deterministically.
    await Worker.runReplayHistory({ workflowsPath }, await env.client.workflow.getHandle(workflowId).fetchHistory(), workflowId);
    return { result, stages: calls.map(call => call.stage), calls };
  }

  it("runs the admitted stage list in canonical order, records why, and carries the size warning and progress limits", async () => {
    const { result, stages, calls } = await run({ tier: "mvp", lane: "standard", stageList: ["verify", "implement"], stageListReason: "task Stages line", sizing, size, sizeWarning: "task names 9 files in 3 areas; limit is 5 files / 3 areas" });
    expect(result.status, result.message).toBe("completed");
    expect(stages).toEqual(["implement", "verify"]);
    expect(result.metadata?.warnings).toEqual(expect.arrayContaining([{ stage: "stages", message: "stage list set: task Stages line" }, { stage: "size", message: "task names 9 files in 3 areas; limit is 5 files / 3 areas" }]));
    expect(result.metadata?.warnings?.filter(warning => warning.stage === "size")).toHaveLength(1);
    expect(calls.find(call => call.stage === "implement")!.progress).toEqual({ firstEditMinutes: 15, idleMinutes: 10 });
  }, 90_000);

  it("uses the sizing file limit for the escalation review", async () => {
    const changes: ChangeStats = { files: Array.from({ length: 6 }, (_, index) => `src/f${index}.ts`), lines: 10, deletedFiles: [] };
    const limited = await run({ tier: "mvp", lane: "light", sizing }, { changes });
    expect([...limited.stages].sort()).toEqual(["implement", "review", "verify"]);
    expect(limited.result.message).toContain("6 files changed (limit 5)");
    const unlimited = await run({ tier: "mvp", lane: "light" }, { changes });
    expect(unlimited.stages).toEqual(["implement", "verify"]);
  }, 120_000);

  it("turns an implement stage that made no progress into a split request with the size evidence", async () => {
    const { result, stages } = await run({ tier: "prototype", lane: "standard", prompt: "Build everything at once. [INJECT_NO_PROGRESS]", sizing, size });
    expect(result.status).toBe("failed");
    expect(stages).toEqual(["implement"]);
    expect(result.message.startsWith("needs split: "), result.message).toBe(true);
    expect(result.message).toContain("codex no progress: no file change in 15 minutes");
    expect(result.metadata?.size).toMatchObject({ kind: "size_suspected", estimate: size });
    expect(result.metadata?.size?.reason).toMatch(/too big/);
    expect(result.metadata?.review.stopReason).toBe("implement_activity_failed");
  }, 90_000);

  it("leaves a run without the new fields on its old path", async () => {
    const { result, stages, calls } = await run({ tier: "mvp", lane: "standard" });
    expect(result.status, result.message).toBe("completed");
    expect([...stages].sort()).toEqual(["implement", "plan", "review", "verify"]);
    expect(stages[0]).toBe("plan");
    expect(result.metadata?.warnings).toBeUndefined();
    expect(result.metadata).not.toHaveProperty("size");
    expect(calls.find(call => call.stage === "implement")!).not.toHaveProperty("progress");
    expect(result.message).toBe("quality gates passed; draft PR published");
  }, 90_000);
});
