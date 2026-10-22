import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { analysisBlock, analysisConstraints, analysisPrompt, formatAnalysisMarkdown, validateAnalysis, type Analysis } from "../src/analysis.js";
import { writeAnalysisDocument } from "../src/activities.js";
import type { StageInput, StageOutput } from "../src/contracts.js";
import { FakeProvider } from "../src/providers.js";
import { HANDOFF_BUDGETS, estimateTokens, planningPrompt } from "../src/handoffs.js";
import { parseTaskDirectives } from "../src/openspec-policy.js";
import { projectWorkflow } from "../src/workflows.js";

const valid: Analysis = {
  problem: "Make the game harder over time without becoming unfair.",
  constraints: ["Every obstacle gap must stay jumpable"],
  candidates: [{ name: "Linear ramp", summary: "Speed grows linearly", strengths: ["Simple"], weaknesses: ["Outgrows reaction time"] }, { name: "Eased capped ramp", summary: "Ease towards a cap", strengths: ["Smooth"], weaknesses: ["More tuning"] }],
  evaluation_criteria: ["Fairness at the hardest level", "Smoothness"],
  chosen: { name: "Eased capped ramp", rationale: "Bounded and smooth", parameters: [{ name: "maxSpeed", value: "600 px/s", rationale: "Reachable with the existing jump" }] },
  validation_properties: ["Every gap is jumpable at maximum speed"],
  risks: ["Needs playtesting"],
  implementation_requirements: ["Speed never exceeds maxSpeed"],
};

describe("analysis module", () => {
  it("accepts a valid answer, also inside a code fence or prose", () => {
    expect(validateAnalysis(JSON.stringify(valid))).toEqual(valid);
    expect(validateAnalysis("```json\n" + JSON.stringify(valid) + "\n```").chosen.name).toBe("Eased capped ramp");
    expect(validateAnalysis("Result: " + JSON.stringify(valid)).problem).toContain("harder");
  });
  it("rejects a single candidate, missing requirements, unknown fields and over-budget answers", () => {
    expect(() => validateAnalysis(JSON.stringify({ ...valid, candidates: [valid.candidates[0]] }))).toThrow("candidates");
    expect(() => validateAnalysis(JSON.stringify({ ...valid, implementation_requirements: [] }))).toThrow("implementation_requirements");
    expect(() => validateAnalysis(JSON.stringify({ ...valid, extra: 1 }))).toThrow("required schema");
    expect(() => validateAnalysis("{ truncated")).toThrow("not valid JSON");
    expect(() => validateAnalysis(JSON.stringify(valid), HANDOFF_BUDGETS.analysis + 1)).toThrow("exceeds its");
  });
  it("turns requirements and validation properties into protected constraints", () => {
    expect(analysisConstraints(valid)).toEqual(["Speed never exceeds maxSpeed", "Validate: Every gap is jumpable at maximum speed"]);
  });
  it("renders a decisions block and a committed document with the comparison and parameters", () => {
    expect(analysisBlock(valid)).toContain("maxSpeed = 600 px/s");
    const markdown = formatAnalysisMarkdown(valid, { taskId: "DINO-5", title: "Difficulty curve" });
    for (const expected of ["# Analysis: Difficulty curve", "### Linear ramp", "### Eased capped ramp", "| maxSpeed | 600 px/s |", "## Validation properties", "Speed never exceeds maxSpeed"]) expect(markdown).toContain(expected);
  });
  it("asks for alternatives, derivations and bounded change, and fits the planning budget with the decisions block", () => {
    const prompt = analysisPrompt("Improve the challenge", "{}");
    for (const expected of ["at least two", "derive", "worst-case invariant", "gradual", "Return only one JSON object"]) expect(prompt).toContain(expected);
    expect(estimateTokens(analysisBlock(valid))).toBeLessThan(700);
    expect(() => planningPrompt("task", "d".repeat(6000), "", analysisBlock(valid))).not.toThrow();
  });
});

describe("task directives", () => {
  it("parses OpenSpec and Analysis switches, strips their lines and rejects conflicts", () => {
    expect(parseTaskDirectives("Improve it\nAnalysis: on\nOpenSpec: off\n\nMore text")).toEqual({ prompt: "Improve it\n\nMore text", analysis: true, openSpec: false });
    expect(parseTaskDirectives("Just a task")).toEqual({ prompt: "Just a task" });
    expect(parseTaskDirectives("x\nAnalysis: on\nAnalysis: off").error).toContain("conflicting Analysis");
    expect(parseTaskDirectives("x\nOpenSpec: on\nOpenSpec: off").error).toContain("conflicting OpenSpec");
  });
});

describe("analysis document activity", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  it("writes inside the worktree under a sanitized name and refuses to escape it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-analysis-doc-")); roots.push(root);
    const file = await writeAnalysisDocument({ worktree: root, docsDir: "docs/analysis", taskId: "DINO 5/odd", markdown: "# hi" });
    expect(file).toBe(path.join(root, "docs", "analysis", "DINO-5-odd.md"));
    expect(await readFile(file, "utf8")).toBe("# hi");
    await expect(writeAnalysisDocument({ worktree: root, docsDir: "../outside", taskId: "x", markdown: "no" })).rejects.toThrow("must stay inside");
  });
});

describe("analysis stage in the workflow", () => {
  async function run(firstAnalysisInvalid: boolean) {
    const environment = await TestWorkflowEnvironment.createLocal();
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "orch-analysis-wf-"));
    const worktree = path.join(projectRoot, "worktree"); await mkdir(worktree);
    const stageInputs: StageInput[] = []; const documents: Array<{ docsDir: string; markdown: string; taskId: string }> = [];
    let analyzeCalls = 0;
    const fake = new FakeProvider();
    const activities = {
      checkDependencies: async () => undefined,
      prepareWorktree: async () => worktree,
      prepareProjectDependencies: async () => ({ installed: false, summary: "none" }),
      executeStage: async (input: StageInput): Promise<StageOutput> => {
        stageInputs.push(input);
        if (input.stage === "analyze" && firstAnalysisInvalid && ++analyzeCalls === 1) return { stage: input.stage, ok: true, summary: "I think a ramp is best, no JSON here", findings: [], artifactRefs: [], provider: "fake", durationMs: 0 };
        return { ...(await fake.run(input)), stage: input.stage };
      },
      writeAnalysisDocument: async (input: { docsDir: string; markdown: string; taskId: string }) => { documents.push(input); return path.join(worktree, input.docsDir, "doc.md"); },
      collectWorktree: async () => path.join(projectRoot, "w.patch"),
      publishWorktree: async ({ repository }: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: repository.branch, baseSha: repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/example/p/pull/1", prBaseBranch: repository.prBaseBranch }),
    };
    const taskQueue = `analysis-${firstAnalysisInvalid}-${Date.now()}`;
    try {
      const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace, taskQueue, workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
      const result = await worker.runUntil(environment.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: `wf-${taskQueue}`, args: [{ runId: "r", taskId: "DINO-5", projectId: "p", profile: "implementation", prompt: "Make the game get harder over time but stay fair.", openSpec: false, analysis: true, analysisDocsDir: "docs/analysis", provider: "fake" as const, projectRoot, artifactsDir: path.join(projectRoot, "artifacts"), repository: { remote: "origin", targetBranch: "main", branch: "codex/d-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "Difficulty curve" }, approval: false, plugins: [], qualityCommands: [] }] }));
      return { result, stageInputs, documents };
    } finally { await environment.teardown(); await rm(projectRoot, { recursive: true, force: true }); }
  }

  it("analyses before planning, carries the decisions to plan, implementation and review, and commits the document", async () => {
    const { result, stageInputs, documents } = await run(false);
    expect(result.status, result.message).toBe("completed");
    const order = stageInputs.map(input => input.stage);
    expect(order.slice(0, 4)).toEqual(["analyze", "plan", "brief", "implement"]);
    const prompt = (stage: string) => stageInputs.find(input => input.stage === stage)!.prompt;
    expect(prompt("plan")).toContain("ANALYSIS DECISIONS");
    expect(prompt("plan")).toContain("Eased capped ramp");
    expect(prompt("implement")).toContain("Speed never exceeds maxSpeed");
    expect(prompt("implement")).toContain("ANALYSIS DECISIONS");
    expect(prompt("review")).toContain("analysis decisions");
    expect(documents).toHaveLength(1);
    expect(documents[0]!.markdown).toContain("# Analysis: Difficulty curve");
    expect(documents[0]!.docsDir).toBe("docs/analysis");
    expect(result.stages.find(stage => stage.stage === "analyze")?.metadata).toMatchObject({ analysisValidated: true, chosenApproach: "Eased capped ramp" });
  }, 120_000);

  it("repairs an invalid analysis answer once instead of failing the run", async () => {
    const { result, stageInputs } = await run(true);
    expect(result.status, result.message).toBe("completed");
    const analyzes = stageInputs.filter(input => input.stage === "analyze");
    expect(analyzes).toHaveLength(2);
    expect(analyzes[1]!.prompt).toContain("failed validation");
  }, 120_000);
});
