import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/activity";
import type { StageInput, StageOutput } from "../src/contracts.js";
import { projectWorkflow } from "../src/workflows.js";

describe.each(["validation", "checklist", "spec-update"] as const)("OpenSpec %s repair", (scenario) => {
  it("re-runs the proposal stage once with diagnostics instead of failing the run", async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "orch-openspec-repair-"));
    const worktree = path.join(projectRoot, "worktree");
    await mkdir(worktree);
    const prompts = new Map<string, string>();
    const stageInputs: StageInput[] = [];
    const archiveCalls: string[] = [];
    let failVerification = false; let validateCalls = 0;
    const activities = {
      checkDependencies: async () => undefined,
      prepareWorktree: async () => worktree,
      prepareProjectDependencies: async () => ({ installed: true, summary: "fixture dependencies ready" }),
      prepareOpenSpec: async () => ({ changeId: "task-percent-run1", version: "1.14.3", artifactRef: path.join(projectRoot, "prepared.json") }),
      validateOpenSpec: async () => { validateCalls++; if (scenario === "validation" && validateCalls === 1) throw ApplicationFailure.nonRetryable("OpenSpec command failed (exit 1): Requirement is under ## Requirements, which is not a delta section"); return { context: "### Requirement: percentage uses the existing operand semantics\nThe button shall preserve operand behavior.\n\n#### Scenario: Apply percent\n- **THEN** the current operand is divided by 100", artifactRef: path.join(projectRoot, "spec-context.md"), version: "1.14.3" }; },
      archiveOpenSpecChange: async ({ changeId }: { changeId: string }) => { archiveCalls.push(changeId); if (scenario === "checklist" && archiveCalls.length === 1) throw ApplicationFailure.nonRetryable(`OpenSpec task checklist for '${changeId}' is not complete`); if (scenario === "spec-update" && archiveCalls.length === 1) throw ApplicationFailure.nonRetryable(`archive_spec_update_failed: dino MODIFIED failed for header "### Requirement: X" - not found`); return { archivedPath: `openspec/changes/archive/2026-10-21-${changeId}`, artifactRef: path.join(projectRoot, "archive.json") }; },
      executeStage: async (input: StageInput): Promise<StageOutput> => {
        stageInputs.push(input);
        prompts.set(input.stage, input.prompt);
        if (input.stage === "spec_optimize") return { stage: input.stage, ok: true, summary: JSON.stringify({ task_goal: "Add a percentage button while preserving operand behavior.", requirements: [{ id: "Requirement: percentage uses the existing operand semantics", intent: "Preserve operand behavior.", scenarios: [{ id: "Scenario: Apply percent", expected: "Divide current operand by 100." }] }], hard_constraints: [], relevant_design_decisions: [] }), findings: [], artifactRefs: [], provider: input.provider, durationMs: 0 };
        if (input.stage === "review") return { stage: input.stage, ok: true, summary: "Review passed", findings: [], review: { verdict: "pass", findings: [], notes: [] }, artifactRefs: [], provider: input.provider, durationMs: 0 };
        if (input.stage === "verify" && failVerification) return { stage: input.stage, ok: false, summary: "quality check failed", findings: ["test failure"], artifactRefs: [], provider: "quality-gate", durationMs: 0 };
        if (input.stage === "plan") return { stage: input.stage, ok: true, summary: JSON.stringify({ task_goal: "Add a percentage button", approach: "Preserve existing percentage behavior", important_decisions: ["Plan: preserve existing percentage behavior"], risks: [], acceptance_criteria: ["Requirement: percentage uses the existing operand semantics"], hard_constraints: [] }), findings: [], artifactRefs: [], provider: input.provider, durationMs: 0 };
        if (input.stage === "brief") return { stage: input.stage, ok: true, summary: JSON.stringify({ task_goal: "Add a percentage button", files_or_modules: ["calculator control"], must_follow: ["Add a percentage button.", "The button shall preserve operand behavior.", "Use the $openspec-apply-change workflow and mark checklist items complete only after code and validation are complete."], must_avoid: [], implementation_steps: ["Add the percentage control"], verification_steps: ["Run focused tests"], acceptance_checks: ["Requirement: percentage uses the existing operand semantics"] }), findings: [], artifactRefs: [], provider: input.provider, durationMs: 0 };
        return { stage: input.stage, ok: true, summary: `Completed ${input.stage}`, findings: [], artifactRefs: [], provider: input.provider, durationMs: 0 };
      },
      collectWorktree: async () => path.join(projectRoot, "worktree.patch"),
      publishWorktree: async ({ repository }: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: repository.branch, baseSha: repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/example/project/pull/1", prBaseBranch: repository.prBaseBranch }),
    };
    const taskQueue = `openspec-repair-${scenario}-${Date.now()}`;
    const input = { runId: "repair-run", taskId: "R-1", taskRevision: "rev-1", projectId: "p", profile: "implementation", prompt: "Add a percentage button.", openSpec: true, provider: "fake" as const, providerRouting: { implement: { provider: "codex" as const } }, projectRoot, artifactsDir: path.join(projectRoot, "artifacts"), repository: { remote: "origin", targetBranch: "main", branch: "codex/r-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "t" }, approval: false, plugins: [], qualityCommands: [] };
    try {
      const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace, taskQueue, workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
      await worker.runUntil(async () => {
        const result = await environment.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: `openspec-repair-${scenario}`, args: [input] });
        expect(result.status, result.message).toBe("completed");
        const openspecStages = stageInputs.filter(stage => stage.stage === "openspec");
        expect(openspecStages).toHaveLength(2);
        if (scenario === "validation") { expect(validateCalls).toBe(2); expect(openspecStages[1]!.prompt).toContain("failed strict validation"); expect(openspecStages[1]!.prompt).toContain("not a delta section"); }
        else if (scenario === "checklist") { expect(archiveCalls).toHaveLength(2); expect(openspecStages[1]!.prompt).toContain("tasks.md checklist is not fully checked"); expect(openspecStages[1]!.prompt).toContain("Unverified manually:"); }
        else { expect(archiveCalls).toHaveLength(2); expect(openspecStages[1]!.prompt).toContain("failed strict validation"); expect(openspecStages[1]!.prompt).toContain("belongs under ADDED"); expect(openspecStages[1]!.prompt).toContain("MODIFIED failed for header"); }
      });
    } finally { await environment.teardown(); await rm(projectRoot, { recursive: true, force: true }); }
  }, 120_000);
});
