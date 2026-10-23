// Fault injection for the structured stages. A mock model corrupts one stage's answer in realistic ways and the REAL workflow runs against it.
// Invariants: plan, brief, digest and analysis never kill a run (they recover, or degrade with a recorded warning); a review answer nobody can read
// fails closed with a precise reason; a review that says "needs changes" is enforced for every provider; infrastructure failures stay bounded.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { RunResult, StageInput, StageOutput } from "../src/contracts.js";
import { deterministicDigest } from "../src/fallbacks.js";
import { changeOnlyContext } from "../src/handoffs.js";
import { FakeProvider } from "../src/providers.js";
import { applyReviewAssessment } from "../src/review.js";
import { projectWorkflow } from "../src/workflows.js";

const CONTEXT = "### openspec/changes/c1/proposal.md\n\n## Why\nThe game needs a fair difficulty curve.\n\n### openspec/changes/c1/specs/dino/spec.md\n\n## ADDED Requirements\n\n### Requirement: Ramp\nThe system SHALL ramp speed gradually. The system MUST NOT exceed the cap.\n\n#### Scenario: Ramp\n- **WHEN** time passes\n- **THEN** speed grows\n\n### Requirement: Gap\nThe system SHALL keep every gap jumpable.\n\n#### Scenario: Gap\n- **WHEN** at maximum speed\n- **THEN** a jump clears the gap\n";

type Defect = (summary: string) => string;
const mapStrings = (value: unknown, fn: (text: string) => string): unknown => typeof value === "string" ? fn(value) : Array.isArray(value) ? value.map(item => mapStrings(item, fn)) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) : value;
const withObject = (summary: string, change: (value: Record<string, unknown>) => unknown): string => { try { return JSON.stringify(change(JSON.parse(summary) as Record<string, unknown>)); } catch { return summary; } };
const DEFECTS: Record<string, Defect> = {
  fenced: s => "```json\n" + s + "\n```",
  prose: s => `Sure, here is the result you asked for:\n${s}\nLet me know if you want changes.`,
  truncated: s => s.slice(0, Math.max(1, Math.floor(s.length * 0.6))),
  proseOnly: () => "I analysed the task and recommend extending the existing rules module with careful tests; no structured answer follows.",
  extraKeys: s => withObject(s, value => ({ ...value, notes: "extra", metadata: { a: 1 } })),
  empty: () => "",
  wrongTypes: s => withObject(s, value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => typeof x === "string" ? x : JSON.stringify(x)).join("; ") : v]))),
  overlong: s => withObject(s, value => mapStrings(value, text => text.length > 40 ? text + " lorem ipsum".repeat(400) : text)),
};

type RunState = { calls: StageInput[]; stage?: string; defect?: Defect; mode?: "first" | "always"; reviewScript?: Array<"block" | "pass">; failStage?: { stage: string; times: number } };
const runs = new Map<string, RunState>();
const fake = new FakeProvider();
let env: TestWorkflowEnvironment; let worker: Worker; let running: Promise<void>; let tmp: string; let sequence = 0;

const ok = (input: StageInput, summary: string): StageOutput => ({ stage: input.stage, ok: true, summary, findings: [], artifactRefs: [], provider: "fake", durationMs: 0 });
const BLOCKING = JSON.stringify({ verdict: "needs_changes", findings: [{ severity: "high", category: "functional", title: "Gap can be impossible", evidence: "min gap below jump distance", fixableInCode: true }], notes: [] });
const PASSING = JSON.stringify({ verdict: "pass", findings: [], notes: [] });

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "orch-chaos-")); await mkdir(path.join(tmp, "wt"));
  env = await TestWorkflowEnvironment.createLocal();
  const activities = {
    checkDependencies: async () => undefined,
    prepareWorktree: async () => path.join(tmp, "wt"),
    prepareProjectDependencies: async () => ({ installed: false, summary: "none" }),
    prepareOpenSpec: async () => ({ changeId: "c1", version: "1.14.3", artifactRef: path.join(tmp, "prepared.json") }),
    validateOpenSpec: async () => ({ context: CONTEXT, artifactRef: path.join(tmp, "context.md"), version: "1.14.3" }),
    archiveOpenSpecChange: async () => ({ archivedPath: "archive/c1", artifactRef: path.join(tmp, "archive.json") }),
    writeAnalysisDocument: async () => path.join(tmp, "analysis.md"),
    collectWorktree: async () => path.join(tmp, "w.patch"),
    publishWorktree: async ({ repository }: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: repository.branch, baseSha: repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/example/p/pull/1", prBaseBranch: repository.prBaseBranch }),
    executeStage: async (input: StageInput): Promise<StageOutput> => {
      const state = runs.get(input.runId)!;
      state.calls.push(input);
      const nth = state.calls.filter(call => call.stage === input.stage).length;
      if (state.failStage?.stage === input.stage && nth <= state.failStage.times) throw new Error(`injected infrastructure failure #${nth}`);
      let out: StageOutput = input.stage === "spec_optimize" ? ok(input, JSON.stringify(deterministicDigest(changeOnlyContext(CONTEXT), "Fair difficulty curve"))) : { ...(await fake.run(input)), stage: input.stage };
      if (input.stage === "review") {
        // Emulate a CLI reviewer: only text comes back; the activity derives the assessment.
        const scripted = state.reviewScript?.[nth - 1] ?? state.reviewScript?.[state.reviewScript.length - 1];
        out = ok(input, scripted === "block" ? BLOCKING : scripted === "pass" ? PASSING : JSON.stringify(out.review ?? { verdict: "pass", findings: [], notes: [] }));
      }
      if (state.defect && state.stage === input.stage && (state.mode === "always" || nth === 1)) out = { ...out, summary: state.defect(out.summary) };
      return input.stage === "review" ? applyReviewAssessment(out) : out;
    },
  };
  worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: "chaos", workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
  running = worker.run();
}, 120_000);

afterAll(async () => { worker.shutdown(); await running; await env.teardown(); await rm(tmp, { recursive: true, force: true }); });

async function run(state: RunState, options: { openSpec?: boolean; analysis?: boolean; maxReviewRounds?: number } = {}): Promise<{ result: RunResult; state: RunState }> {
  const id = `chaos-${++sequence}`;
  runs.set(id, state);
  const result = await env.client.workflow.execute(projectWorkflow, { taskQueue: "chaos", workflowId: id, args: [{ runId: id, taskId: "CH-1", projectId: "p", profile: "implementation", prompt: "Make the game get harder over time but stay fair. The change MUST NOT break existing controls.", openSpec: options.openSpec ?? false, analysis: options.analysis ?? false, maxReviewRounds: options.maxReviewRounds ?? 2, provider: "fake" as const, projectRoot: tmp, artifactsDir: path.join(tmp, "art"), repository: { remote: "origin", targetBranch: "main", branch: "codex/ch", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "Chaos" }, approval: false, plugins: [], qualityCommands: [] }] });
  return { result, state };
}

const STAGES: Array<{ stage: string; options: { openSpec?: boolean; analysis?: boolean } }> = [
  { stage: "spec_optimize", options: { openSpec: true } },
  { stage: "plan", options: {} },
  { stage: "brief", options: {} },
  { stage: "analyze", options: { analysis: true } },
];

describe("structured stages never kill a run", () => {
  type Case = ["first" | "always", string, string, { openSpec?: boolean; analysis?: boolean }];
  const cases: Case[] = STAGES.flatMap(({ stage, options }) => Object.keys(DEFECTS).flatMap((defect): Case[] => [["always", stage, defect, options], ...(["truncated", "proseOnly", "empty"].includes(defect) ? [["first", stage, defect, options] as Case] : [])]));
  it.each(cases)("%s answer from %s is %s: the run still completes", async (mode, stage, defect, options) => {
    const { result } = await run({ calls: [], stage, defect: DEFECTS[defect]!, mode }, options);
    expect(result.status, `${stage}/${defect}/${mode}: ${result.message}`).toBe("completed");
    expect(result.publish?.prUrl).toContain("pull/1");
    if (mode === "first") expect(result.metadata?.warnings ?? []).toEqual([]);
  }, 90_000);

  it("records a warning when a deterministic fallback had to replace an unusable answer", async () => {
    const { result } = await run({ calls: [], stage: "plan", defect: DEFECTS.proseOnly!, mode: "always" });
    expect(result.metadata?.warnings?.some(w => w.stage === "plan" && w.message.includes("deterministic fallback"))).toBe(true);
    expect(result.message).toContain("warning");
  }, 90_000);

  it("keeps the protected constraints when the brief falls back", async () => {
    const { state } = await run({ calls: [], stage: "brief", defect: DEFECTS.proseOnly!, mode: "always" });
    const implement = state.calls.find(call => call.stage === "implement")!;
    expect(implement.prompt).toContain("MUST NOT break existing controls");
  }, 90_000);

  it("skips analysis with a warning when nothing usable can be salvaged", async () => {
    const { result } = await run({ calls: [], stage: "analyze", defect: DEFECTS.truncated!, mode: "always" }, { analysis: true });
    expect(result.status).toBe("completed");
    expect(result.metadata?.warnings?.some(w => w.stage === "analyze")).toBe(true);
  }, 90_000);
});

describe("review gate", () => {
  it.each(["fenced", "prose", "extraKeys"])("reads a %s review answer and passes it", async defect => {
    const { result } = await run({ calls: [], stage: "review", defect: DEFECTS[defect]!, mode: "always" });
    expect(result.status, result.message).toBe("completed");
  }, 90_000);

  it.each(["truncated", "proseOnly", "empty"])("fails closed with a precise reason when the review is %s on every attempt", async defect => {
    const { result } = await run({ calls: [], stage: "review", defect: DEFECTS[defect]!, mode: "always" });
    expect(result.status).toBe("failed");
    expect(result.metadata?.review.stopReason).toBe("review_unparseable");
  }, 90_000);

  it("recovers when only the first review answer is unreadable (one restatement request)", async () => {
    const { result, state } = await run({ calls: [], stage: "review", defect: DEFECTS.proseOnly!, mode: "first" });
    expect(result.status, result.message).toBe("completed");
    expect(state.calls.filter(call => call.stage === "review").length).toBe(2);
  }, 90_000);

  it("enforces a blocking verdict from a CLI-style reviewer: repair, deterministic checks, follow-up review, then publish", async () => {
    const { result, state } = await run({ calls: [], reviewScript: ["block", "pass"] });
    expect(result.status, result.message).toBe("completed");
    expect(state.calls.filter(call => call.stage === "implement").length).toBe(2);
    expect(state.calls.filter(call => call.stage === "review").length).toBe(2);
    expect(result.metadata?.review.repairCount).toBe(1);
    expect(state.calls.find(call => call.stage === "implement" && call.prompt.includes("REPAIR"))?.prompt).toContain("Gap can be impossible");
  }, 90_000);

  it("supports more than one repair round and stops at the configured limit with the unresolved finding", async () => {
    const three = await run({ calls: [], reviewScript: ["block", "block", "pass"] }, { maxReviewRounds: 3 });
    expect(three.result.status, three.result.message).toBe("completed");
    expect(three.result.metadata?.review.repairCount).toBe(2);
    const stuck = await run({ calls: [], reviewScript: ["block"] }, { maxReviewRounds: 2 });
    expect(stuck.result.status).toBe("failed");
    expect(stuck.result.metadata?.review.stopReason).toBe("blocking_findings_remain_after_final_review");
    expect(stuck.result.metadata?.review.unresolvedFindings[0]?.title).toBe("Gap can be impossible");
  }, 120_000);
});

describe("infrastructure failures stay bounded", () => {
  it("retries a transient activity failure and completes", async () => {
    const { result } = await run({ calls: [], failStage: { stage: "plan", times: 1 } });
    expect(result.status, result.message).toBe("completed");
  }, 90_000);
  it("fails with a precise stop reason when an activity keeps failing, without unbounded retries", async () => {
    const { result, state } = await run({ calls: [], failStage: { stage: "plan", times: 99 } });
    expect(result.status).toBe("failed");
    expect(result.metadata?.review.stopReason).toBe("plan_output_invalid");
    expect(state.calls.filter(call => call.stage === "plan").length).toBeLessThanOrEqual(3);
  }, 90_000);
});
