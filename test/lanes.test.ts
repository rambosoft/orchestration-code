// Lanes and tiers (ADR 0015). The golden table is the contract: a change to which stages a tier and lane run must show up here as a deliberate edit. The workflow tests run the real
// workflow against stub activities and read back which stages were actually called.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { RunInput, StageInput, StageOutput } from "../src/contracts.js";
import { ESCALATION, LANES, TIERS, escalationReasons, laneFor, lanePlan, type ChangeStats, type Lane, type Tier } from "../src/lanes.js";
import { parseTaskDirectives } from "../src/openspec-policy.js";
import { buildIssuePlan } from "../src/bootstrap.js";
import { projectWorkflow } from "../src/workflows.js";

const GOLDEN: Record<Tier, Record<Lane, string>> = {
  throwaway: { light: "implement verify", standard: "implement verify", heavy: "plan implement verify" },
  prototype: { light: "implement verify", standard: "implement verify", heavy: "plan implement review verify" },
  mvp: { light: "implement verify", standard: "plan implement review verify", heavy: "plan brief implement review verify" },
  production: { light: "implement review verify", standard: "plan brief implement review verify", heavy: "plan brief implement review verify" },
};

describe("lane table", () => {
  it("is the stage list every tier and lane runs", () => {
    for (const tier of TIERS) for (const lane of LANES) expect(lanePlan(tier, lane).stages.join(" "), `${tier}/${lane}`).toBe(GOLDEN[tier][lane]);
  });
  it("runs OpenSpec and analysis only for heavy production tasks", () => {
    const on = TIERS.flatMap(tier => LANES.filter(lane => lanePlan(tier, lane).openSpec || lanePlan(tier, lane).analysis).map(lane => `${tier}/${lane}`));
    expect(on).toEqual(["production/heavy"]);
  });
  it("hands out copies, so a run that edits its stage list cannot change the table", () => {
    lanePlan("prototype", "light").stages.push("review");
    expect(lanePlan("prototype", "light").stages).toEqual(["implement", "verify"]);
  });
  it("takes the lane from an explicit line first, then from the size the blueprint gave", () => {
    expect([laneFor("small"), laneFor("normal"), laneFor("large"), laneFor(undefined), laneFor("small", "heavy")]).toEqual(["light", "standard", "heavy", "standard", "heavy"]);
  });
  it("reads a Lane line from the task text and removes it, and rejects two different ones", () => {
    expect(parseTaskDirectives("Build the board.\n\nLane: light\nOpenSpec: off")).toMatchObject({ prompt: "Build the board.", lane: "light", openSpec: false });
    expect(parseTaskDirectives("Build the board.").lane).toBeUndefined();
    expect(parseTaskDirectives("Lane: light\nLane: heavy").error).toContain("conflicting Lane");
  });
});

describe("milestone checks", () => {
  const task = (key: string, over: Record<string, unknown> = {}) => ({ key, title: `Task ${key}`, description: "d", type: "task" as const, size: "normal" as const, acceptance: ["works"], depends_on: [] as string[], ...over });
  const blueprint = {
    summary: "s",
    milestones: [
      { key: "M1", title: "Core", goal: "g", exit_criteria: ["Board renders", "Mines are placed"], tasks: [task("T1"), task("T2")] },
      { key: "M2", title: "Polish", goal: "g", exit_criteria: [], tasks: [task("T3")] },
      { key: "M3", title: "Study", goal: "g", exit_criteria: [], tasks: [task("R1", { type: "research" })] },
    ],
  };
  const issues = (maturity: string) => buildIssuePlan(blueprint as never, { maturity, autostart: "none" }, true);
  const titles = (maturity: string) => issues(maturity).filter(issue => issue.kind === "task").map(issue => issue.title);

  it("ends each prototype milestone with one check task, and only a prototype", () => {
    expect(titles("prototype")).toEqual(["Task T1", "Task T2", "Check milestone: Core", "Task T3", "Check milestone: Polish", "Task R1"]);
    for (const maturity of ["throwaway", "mvp", "production"]) expect(titles(maturity)).toEqual(["Task T1", "Task T2", "Task T3", "Task R1"]);
  });
  it("runs the check in the heavy lane against the milestone's exit criteria, and chains it between the tasks", () => {
    const plan = issues("prototype"); const byKey = new Map(plan.map(issue => [issue.key, issue]));
    const check = byKey.get("task:M1-CHECK")!;
    expect(check.description).toContain("Lane: heavy");
    expect(check.description).toContain("- Board renders");
    expect(check.description).toContain("- Mines are placed");
    expect(byKey.get("task:M2-CHECK")!.description).toContain("Polish works as its goal describes");
    expect(check.blockedByKeys).toEqual(["task:T2"]);
    expect(byKey.get("task:T3")!.blockedByKeys).toEqual(["task:M1-CHECK"]);
  });
  it("keeps the whole-product polish block on the last real task, not on a check", () => {
    const plan = buildIssuePlan(blueprint as never, { maturity: "prototype", autostart: "none", product_kind: "app", ui_ux: true }, true, { design_rules: ["rule"], page_directions: [] } as never);
    expect(plan.find(issue => issue.key === "task:M2-CHECK")!.description).not.toContain("visual polish");
  });
});

describe("escalation", () => {
  const stats = (overrides: Partial<ChangeStats> = {}): ChangeStats => ({ files: ["src/board.ts", "test/board.test.ts"], lines: 80, deletedFiles: [], ...overrides });
  it("leaves a small, ordinary change without a review", () => {
    expect(escalationReasons(stats(), false)).toEqual([]);
  });
  it("asks for a review when the result is large, risky, removes tests or admits unmet criteria", () => {
    expect(escalationReasons(stats({ files: Array.from({ length: ESCALATION.maxFiles + 1 }, (_, i) => `src/f${i}.ts`) }), false)[0]).toContain("files changed");
    expect(escalationReasons(stats({ lines: ESCALATION.maxLines + 1 }), false)[0]).toContain("lines changed");
    expect(escalationReasons(stats({ files: ["src/auth/login.ts"] }), false)[0]).toContain("security");
    expect(escalationReasons(stats({ files: ["db/migrations/001.sql"] }), false)[0]).toContain("security");
    expect(escalationReasons(stats({ deletedFiles: ["test/board.test.ts"] }), false)[0]).toContain("deletes test files");
    expect(escalationReasons(stats({ deletedFiles: ["Assets/Tests/EditMode/BoardTests.cs"] }), false)[0]).toContain("deletes test files");
    expect(escalationReasons(stats(), true)[0]).toContain("did not meet");
  });
  it("does not mistake a path that only contains the word for a risky one", () => {
    expect(escalationReasons(stats({ files: ["src/authors/list.ts", "src/schemas-doc.md"] }), false)).toEqual([]);
  });
});

describe("workflow lanes", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  async function run(extra: Partial<RunInput>, options: { changes?: ChangeStats; failVerifyOnce?: boolean; implementSummary?: string; documents?: Array<{ docsDir: string; taskId: string; markdown: string }> } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-lane-"));
    const worktree = path.join(root, "worktree"); await mkdir(worktree);
    const calls: StageInput[] = []; let verifyFailures = options.failVerifyOnce ? 1 : 0;
    const activities = {
      checkDependencies: async () => undefined,
      prepareWorktree: async () => worktree,
      prepareProjectDependencies: async () => ({ installed: true, summary: "ready" }),
      assessChanges: async (): Promise<ChangeStats> => options.changes ?? { files: ["src/a.ts"], lines: 10, deletedFiles: [] },
      writeAnalysisDocument: async (document: { docsDir: string; taskId: string; markdown: string }) => { options.documents?.push(document); return `${document.docsDir}/${document.taskId}.md`; },
      executeStage: async (input: StageInput): Promise<StageOutput> => {
        calls.push(input);
        if (input.stage === "verify" && verifyFailures-- > 0) return { stage: "verify", ok: false, summary: "quality check failed", findings: ["npm test failed"], artifactRefs: [], provider: "quality-gate", durationMs: 0 };
        const summary = input.stage === "review" ? "Review passed" : input.stage === "implement" ? options.implementSummary ?? "Completed implement" : `Completed ${input.stage}`;
        return { stage: input.stage, ok: true, summary, findings: [], ...(input.stage === "review" ? { review: { verdict: "pass" as const, findings: [], notes: [] } } : {}), artifactRefs: [], provider: input.provider, durationMs: 0 };
      },
      collectWorktree: async () => path.join(root, "worktree.patch"),
      publishWorktree: async ({ repository }: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: repository.branch, baseSha: repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/o/r/pull/1", prBaseBranch: repository.prBaseBranch, draft: true }),
    };
    const taskQueue = `lane-${Math.random().toString(36).slice(2)}`;
    const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
    const input = {
      runId: `lane-${taskQueue}`, taskId: "LANE-1", taskRevision: "rev-1", projectId: "p", profile: "implementation", prompt: "Add a percentage button.\n\nAcceptance criteria:\n- The button shows a percentage.", openSpec: false, provider: "fake", providerRouting: {},
      projectRoot: root, artifactsDir: path.join(root, "artifacts"), repository: { remote: "origin", targetBranch: "main", branch: "codex/lane-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "Lane" },
      approval: false, plugins: [], qualityCommands: [{ executable: "npm", args: ["test"] }], ...extra,
    } as unknown as RunInput;
    const result = await worker.runUntil(env.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: `wf-${taskQueue}`, args: [input] }));
    return { result, stages: calls.map(call => call.stage), calls };
  }

  it("runs a prototype task as implement and verify: no plan, brief, review or spec", async () => {
    const { result, stages, calls } = await run({ tier: "prototype", lane: "standard" });
    expect(result.status, result.message).toBe("completed");
    expect(stages).toEqual(["implement", "verify"]);
    expect(calls[0]!.prompt).toContain("Add a percentage button");
  }, 60_000);
  it("adds a review to a light task whose result is risky, and says why", async () => {
    const { result, stages } = await run({ tier: "prototype", lane: "light" }, { changes: { files: ["src/auth/session.ts"], lines: 20, deletedFiles: [] } });
    expect(result.status, result.message).toBe("completed");
    // Review and the deterministic checks run side by side once review is added, so their order is not fixed.
    expect(stages[0]).toBe("implement");
    expect([...stages].sort()).toEqual(["implement", "review", "verify"]);
    expect(result.message).toContain("review added");
  }, 60_000);
  it("adds a review when the implementer reports unmet acceptance", async () => {
    const { stages } = await run({ tier: "prototype", lane: "light" }, { implementSummary: "Done.\n\nUNMET_ACCEPTANCE:\n- The button shows a percentage." });
    expect(stages).toContain("review");
  }, 60_000);
  it("gives a lane without review the same one bounded repair pass when a check fails", async () => {
    const { result, stages } = await run({ tier: "prototype", lane: "light" }, { failVerifyOnce: true });
    expect(result.status, result.message).toBe("completed");
    expect(stages).toEqual(["implement", "verify", "implement", "verify"]);
  }, 60_000);
  it("plans but does not write a separate brief for a standard MVP task", async () => {
    const { result, stages } = await run({ tier: "mvp", lane: "standard" });
    expect(result.status, result.message).toBe("completed");
    expect(stages.filter(stage => stage === "brief")).toEqual([]);
    expect(stages.indexOf("plan")).toBeLessThan(stages.indexOf("implement"));
    expect(stages).toContain("review");
  }, 60_000);
  it("keeps every review for a light production task", async () => {
    const { stages } = await run({ tier: "production", lane: "light" });
    expect(stages[0]).toBe("implement");
    expect([...stages].sort()).toEqual(["implement", "review", "verify"]);
  }, 60_000);
  it("keeps the profile's full pipeline for a run without a tier (runs recorded before lanes)", async () => {
    const { stages } = await run({});
    expect(stages.indexOf("plan")).toBeLessThan(stages.indexOf("brief"));
    expect(stages.indexOf("brief")).toBeLessThan(stages.indexOf("implement"));
    expect(stages).toContain("review");
  }, 60_000);

  // ADR 0026: a milestone check that verifies everything and changes nothing used to fail at the publish gate ("no changes were committed") and stop the project.
  const checkRepository = (taskTitle: string) => ({ repository: { remote: "origin", targetBranch: "main", branch: "codex/check-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle } });
  it("commits a report for a milestone check that changed nothing, so it publishes and the next milestone has a branch", async () => {
    const documents: Array<{ docsDir: string; taskId: string; markdown: string }> = [];
    const { result } = await run({ tier: "prototype", lane: "heavy", ...checkRepository("Check milestone: UX shell") }, { changes: { files: [], lines: 0, deletedFiles: [] }, documents, implementSummary: "Verification found no defects, so I changed no files." });
    expect(result.status, result.message).toBe("completed");
    expect(result.publish?.prUrl).toContain("/pull/1");
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ docsDir: "docs/checks", taskId: "LANE-1" });
    expect(documents[0]!.markdown).toContain("Check milestone: UX shell");
    expect(documents[0]!.markdown).toContain("nothing needed to change");
    expect(documents[0]!.markdown).toContain("Verification found no defects");
  }, 60_000);
  it("writes no report when the check changed something, and none for an ordinary task that changed nothing (that one still fails at the publish gate)", async () => {
    const withChanges: Array<{ docsDir: string; taskId: string; markdown: string }> = [];
    await run({ tier: "prototype", lane: "heavy", ...checkRepository("Check milestone: Core logic") }, { documents: withChanges });
    expect(withChanges).toEqual([]);
    const ordinary: Array<{ docsDir: string; taskId: string; markdown: string }> = [];
    await run({ tier: "prototype", lane: "light", ...checkRepository("Add a percentage button") }, { changes: { files: [], lines: 0, deletedFiles: [] }, documents: ordinary });
    expect(ordinary).toEqual([]);
  }, 90_000);
});
