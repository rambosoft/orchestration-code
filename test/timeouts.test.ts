import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { executionTimeoutMs } from "../src/client.js";
import type { StageInput, StageOutput } from "../src/contracts.js";
import { projectWorkflow } from "../src/workflows.js";

describe("executionTimeoutMs", () => {
  it("defaults to 48h and accepts a positive override", () => {
    expect(executionTimeoutMs({})).toBe(172_800_000);
    expect(executionTimeoutMs({ ORCHESTRATOR_WORKFLOW_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(executionTimeoutMs({ ORCHESTRATOR_WORKFLOW_TIMEOUT_MS: "-1" })).toBe(172_800_000);
    expect(executionTimeoutMs({ ORCHESTRATOR_WORKFLOW_TIMEOUT_MS: "abc" })).toBe(172_800_000);
  });
});

describe("approval wait", () => {
  it("fails the run instead of waiting forever when nobody decides", async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const executed: string[] = [];
    const ok = (input: StageInput, summary: string): StageOutput => ({ stage: input.stage, ok: true, summary, findings: [], artifactRefs: [], provider: "fake", durationMs: 0 });
    const plan = JSON.stringify({ task_goal: "g", approach: "a", important_decisions: [], risks: [], acceptance_criteria: ["done"], hard_constraints: [] });
    const brief = JSON.stringify({ task_goal: "g", files_or_modules: [], must_follow: [], must_avoid: [], implementation_steps: ["s"], verification_steps: ["v"], acceptance_checks: ["done"] });
    const taskQueue = `approval-timeout-${Date.now()}`;
    try {
      const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace, taskQueue, workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
        activities: { executeStage: async (input: StageInput) => { executed.push(input.stage); return ok(input, input.stage === "plan" ? plan : input.stage === "brief" ? brief : "done"); } } });
      const result = await worker.runUntil(environment.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: "approval-timeout", args: [{ runId: "r1", taskId: "T-1", projectId: "p", profile: "implementation", prompt: "Do it", provider: "fake", projectRoot: ".", artifactsDir: ".", approval: true, approvalTimeoutMs: 600 }] }));
      expect(result.status).toBe("failed");
      expect(result.message).toContain("approval timed out");
      expect(result.metadata?.review.stopReason).toBe("approval_timeout");
      expect(executed).not.toContain("implement");
    } finally { await environment.teardown(); }
  }, 60_000);
});
