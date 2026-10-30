import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { StageInput, StageOutput } from "../src/contracts.js";
import { projectWorkflow } from "../src/workflows.js";

describe("OpenSpec workflow gating", () => {
  it("passes validated specs and plan into implementation, archives only after quality passes", async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "orch-openspec-workflow-"));
    const worktree = path.join(projectRoot, "worktree");
    await mkdir(worktree);
    const prompts = new Map<string, string>();
    const stageInputs: StageInput[] = [];
    const archiveCalls: string[] = [];
    let failVerification = false;
    let mixedExternalReview = false;
    let reviewCalls = 0;
    const activities = {
      checkDependencies: async () => undefined,
      prepareWorktree: async () => worktree,
      prepareProjectDependencies: async () => ({ installed: true, summary: "fixture dependencies ready" }),
      prepareOpenSpec: async () => ({ changeId: "task-percent-run1", version: "1.14.3", artifactRef: path.join(projectRoot, "prepared.json") }),
      validateOpenSpec: async () => ({ context: "### Requirement: percentage uses the existing operand semantics\nThe button shall preserve operand behavior.\n\n#### Scenario: Apply percent\n- **THEN** the current operand is divided by 100", artifactRef: path.join(projectRoot, "spec-context.md"), version: "1.14.3" }),
      archiveOpenSpecChange: async ({ changeId }: { changeId: string }) => { archiveCalls.push(changeId); return { archivedPath: `openspec/changes/archive/2026-10-21-${changeId}`, artifactRef: path.join(projectRoot, "archive.json") }; },
      executeStage: async (input: StageInput): Promise<StageOutput> => {
        stageInputs.push(input);
        prompts.set(input.stage, input.prompt);
        if (input.stage === "spec_optimize") return { stage: input.stage, ok: true, summary: JSON.stringify({ task_goal: "Add a percentage button while preserving operand behavior.", requirements: [{ id: "Requirement: percentage uses the existing operand semantics", intent: "Preserve operand behavior.", scenarios: [{ id: "Scenario: Apply percent", expected: "Divide current operand by 100." }] }], hard_constraints: [], relevant_design_decisions: [] }), findings: [], artifactRefs: [], provider: input.provider, durationMs: 0 };
        if (input.stage === "review") {
          if (mixedExternalReview) {
            reviewCalls++;
            const findings = reviewCalls === 1
              ? [
                  { severity: "high" as const, category: "functional" as const, title: "Repair the visible launch action", evidence: "The action is not connected to the start flow.", fixableInCode: true },
                  { severity: "high" as const, category: "environment" as const, title: "Unity license unavailable", evidence: "Unity could not acquire an Editor license.", fixableInCode: false },
                ]
              : [{ severity: "high" as const, category: "environment" as const, title: "Unity license unavailable", evidence: "Unity could not acquire an Editor license.", fixableInCode: false }];
            return { stage: input.stage, ok: false, summary: "Review found code and environment blockers", findings: findings.map(item => item.title), review: { verdict: "needs_changes", findings, notes: [] }, artifactRefs: [], provider: input.provider, durationMs: 0 };
          }
          return { stage: input.stage, ok: true, summary: "Review passed", findings: [], review: { verdict: "pass", findings: [], notes: [] }, artifactRefs: [], provider: input.provider, durationMs: 0 };
        }
        if (input.stage === "verify" && failVerification) return { stage: input.stage, ok: false, summary: "quality check failed", findings: ["test failure"], artifactRefs: [], provider: "quality-gate", durationMs: 0 };
        if (input.stage === "plan") return { stage: input.stage, ok: true, summary: JSON.stringify({ task_goal: "Add a percentage button", approach: "Preserve existing percentage behavior", important_decisions: ["Plan: preserve existing percentage behavior"], risks: [], acceptance_criteria: ["Requirement: percentage uses the existing operand semantics"], hard_constraints: [] }), findings: [], artifactRefs: [], provider: input.provider, durationMs: 0 };
        if (input.stage === "brief") return { stage: input.stage, ok: true, summary: JSON.stringify({ task_goal: "Add a percentage button", files_or_modules: ["calculator control"], must_follow: ["Add a percentage button.", "The button shall preserve operand behavior.", "Use the $openspec-apply-change workflow and mark checklist items complete only after code and validation are complete."], must_avoid: [], implementation_steps: ["Add the percentage control"], verification_steps: ["Run focused tests"], acceptance_checks: ["Requirement: percentage uses the existing operand semantics"] }), findings: [], artifactRefs: [], provider: input.provider, durationMs: 0 };
        return { stage: input.stage, ok: true, summary: `Completed ${input.stage}`, findings: [], artifactRefs: [], provider: input.provider, durationMs: 0 };
      },
      collectWorktree: async () => path.join(projectRoot, "worktree.patch"),
      publishWorktree: async ({ repository }: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: repository.branch, baseSha: repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/example/project/pull/1", prBaseBranch: repository.prBaseBranch }),
    };
    const taskQueue = `openspec-workflow-${Date.now()}`;
    const baseInput = {
      runId: "workflow-openspec-success", taskId: "PERCENT-1", taskRevision: "rev-1", projectId: "calculator", profile: "implementation", prompt: "Add a percentage button.", openSpec: true,
      provider: "fake" as const, providerRouting: { implement: { provider: "codex" as const, reasoningEffort: "low" as const } }, uiUxFrameworks: ["react", "web"], projectRoot, artifactsDir: path.join(projectRoot, "artifacts"),
      repository: { remote: "origin", targetBranch: "main", branch: "codex/percent-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "Percentage button" },
      approval: false, plugins: [], qualityCommands: [{ executable: "npm" as const, args: ["test"] }],
    };
    try {
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        namespace: environment.namespace,
        taskQueue,
        workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
        activities,
      });
      await worker.runUntil(async () => {
        const successful = await environment.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: "openspec-success", args: [baseInput] });
        expect(successful.status, successful.message).toBe("completed");
        expect(successful.metadata?.openSpec?.archivedPath).toContain("task-percent-run1");
        expect(archiveCalls).toEqual(["task-percent-run1"]);
        expect(prompts.get("plan")).toContain("Requirement: percentage uses the existing operand semantics");
        expect(prompts.get("brief")).toContain("Requirement: percentage uses the existing operand semantics");
        expect(prompts.get("implement")).toContain("Requirement: percentage uses the existing operand semantics");
        expect(prompts.get("implement")).not.toContain("Plan: preserve existing percentage behavior");
        expect(prompts.get("spec_optimize")).toContain("Coverage ledger");
        expect(prompts.get("plan")).not.toContain("Relevant UI/UX guidance");
        expect(prompts.get("implement")).toContain("React composition patterns");
        expect(prompts.get("review")).toContain("responsive reflow, keyboard access");
        expect(prompts.get("review")).toContain("Requirement: percentage uses the existing operand semantics");
        expect(stageInputs.find(stage => stage.stage === "brief")).toMatchObject({ provider: "fake" });
        expect(stageInputs.map(stage => stage.stage).slice(0, 6)).toEqual(["openspec", "spec_optimize", "plan", "brief", "implement", "review"]);
        const verificationStages = stageInputs.filter(stage => stage.stage === "verify");
        // The deterministic quality commands are the verification: no second, always-passing model verify call.
        expect(verificationStages).toHaveLength(1);
        expect(verificationStages[0]).toMatchObject({ provider: "fake", verificationOnly: true });
        expect(stageInputs.find(stage => stage.stage === "implement")?.reasoningEffort).toBe("low");
        expect(stageInputs.find(stage => stage.stage === "review")?.prompt).toContain("running concurrently");

        stageInputs.length = 0;
        reviewCalls = 0;
        mixedExternalReview = true;
        const mixed = await environment.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: "openspec-mixed-external-review", args: [{ ...baseInput, runId: "workflow-mixed-external-review", taskId: "PERCENT-4" }] });
        expect(mixed.status).toBe("failed");
        expect(mixed.message).toContain("external prerequisite");
        expect(mixed.metadata?.review.repairCount).toBe(1);
        expect(stageInputs.filter(stage => stage.stage === "implement")).toHaveLength(2);
        expect(stageInputs.filter(stage => stage.stage === "review")).toHaveLength(2);
        expect(archiveCalls).toEqual(["task-percent-run1"]);
        mixedExternalReview = false;

        prompts.clear();
        stageInputs.length = 0;
        failVerification = true;
        const failed = await environment.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: "openspec-quality-failure", args: [{ ...baseInput, runId: "workflow-openspec-failure", taskId: "PERCENT-2", prompt: "[FAIL_VERIFY] Add a percentage button." }] });
        expect(failed.status).toBe("failed");
        expect(failed.message).toContain("verify quality gate failed");
        expect(archiveCalls).toHaveLength(1);

        prompts.clear();
        stageInputs.length = 0;
        failVerification = false;
        const disabled = await environment.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: "openspec-disabled", args: [{ ...baseInput, runId: "workflow-openspec-disabled", taskId: "PERCENT-3", openSpec: false }] });
        expect(disabled.status, disabled.message).toBe("completed");
        expect(stageInputs.map(stage => stage.stage).slice(0, 5)).toEqual(["plan", "brief", "implement", "review", "verify"]);
        expect(stageInputs.some(stage => stage.stage === "spec_optimize" || stage.stage === "openspec")).toBe(false);
        expect(prompts.get("implement")).toContain("Requirement: percentage uses the existing operand semantics");
      });
    } finally {
      await environment.teardown();
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
