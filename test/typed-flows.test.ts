// Task-type flows (ADR 0008). Pure modules first, then the REAL workflow against the fake provider with mocked activities, in the style of chaos.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { buildContextPack as buildContextPackActivity, changedPaths, verifyReproduction } from "../src/activities.js";
import { diagnosisBlock, diagnosisConstraints, needsInfoMessage, regressionGate, reproductionCommandProblem, salvageDiagnosis, validateDiagnosis, validateReproduction, type ReproVerification } from "../src/bug.js";
import type { RunInput, RunResult, StageInput, StageOutput } from "../src/contracts.js";
import { buildContextPack } from "../src/context-pack.js";
import { redactSecrets } from "../src/redact.js";
import { FakeProvider } from "../src/providers.js";
import { deterministicScope, rawReport, validateReport } from "../src/research.js";
import { projectWorkflow } from "../src/workflows.js";

const hypothesis = { id: "H1", kind: "root_cause", title: "Cache key omits locale", mechanism: "key uses id only", evidence: ["src/cache.ts:12 - key built without locale"], observable_failure: "wrong language", confidence: "high" };
const diagnosis = {
  summary: "The cache key ignores the locale.", hypotheses: [hypothesis], reproduction_scenarios: ["two locales in a row"],
  fix_options: [{ name: "Include locale", kind: "root_cause", summary: "Add locale to the key", tradeoffs: [] }, { name: "Flush cache", kind: "workaround", summary: "Clear on change", tradeoffs: ["thrashes"] }],
  chosen_fix: { option: "Include locale", rationale: "Fixes the key", addresses: ["H1"] }, validation_properties: ["Locales never share an entry"], implementation_requirements: ["The key includes the locale"],
};

describe("bug diagnosis", () => {
  it("accepts a grounded diagnosis, also inside a fence", () => {
    expect(validateDiagnosis(JSON.stringify(diagnosis)).hypotheses[0]!.id).toBe("H1");
    expect(validateDiagnosis("```json\n" + JSON.stringify(diagnosis) + "\n```").chosen_fix?.option).toBe("Include locale");
  });
  it("drops hypotheses that cite no evidence instead of keeping an invented problem", () => {
    const parsed = validateDiagnosis(JSON.stringify({ ...diagnosis, hypotheses: [hypothesis, { ...hypothesis, id: "H2", evidence: [] }, { ...hypothesis, id: "H3", evidence: "   " }, { id: "H4", title: "no evidence field" }] }));
    expect(parsed.hypotheses.map(item => item.id)).toEqual(["H1"]);
  });
  it("accepts an honest 'no defect found' answer without a fix design", () => {
    const parsed = validateDiagnosis(JSON.stringify({ summary: "Works as designed", hypotheses: [] }));
    expect(parsed.hypotheses).toEqual([]);
    expect(parsed.chosen_fix).toBeUndefined();
  });
  it("requires a fix design when a defect is reported, and refuses an unjustified workaround", () => {
    expect(() => validateDiagnosis(JSON.stringify({ ...diagnosis, chosen_fix: undefined, fix_options: [] }))).toThrow("fix_options");
    expect(() => validateDiagnosis(JSON.stringify({ ...diagnosis, chosen_fix: { option: "Flush cache", rationale: "quick", addresses: ["H1"] } }))).toThrow("workaround_justification");
    expect(() => validateDiagnosis(JSON.stringify({ ...diagnosis, chosen_fix: { option: "Not an option", rationale: "x", addresses: [] } }))).toThrow("not one of the fix_options");
    expect(validateDiagnosis(JSON.stringify({ ...diagnosis, chosen_fix: { option: "Flush cache", rationale: "root cause is in a vendored library", addresses: ["H1"], workaround_justification: "the vendored key builder cannot be changed" } })).chosen_fix?.option).toBe("Flush cache");
  });
  it("salvages the grounded hypotheses when the fix design is invalid", () => {
    const salvaged = salvageDiagnosis(JSON.stringify({ ...diagnosis, chosen_fix: { option: "Not an option", rationale: "x", addresses: [] } }));
    expect(salvaged?.hypotheses).toHaveLength(1);
    expect(salvageDiagnosis("not json")).toBeUndefined();
  });
  it("turns the diagnosis into a bounded decisions block, protected constraints and a regression gate", () => {
    const parsed = validateDiagnosis(JSON.stringify(diagnosis));
    const reproduction = validateReproduction(JSON.stringify({ outcome: "reproduced", summary: "fails", test_files: ["test/repro.test.ts"], command: { executable: "npm", args: ["test", "--", "test/repro.test.ts"] }, expected_failure: "locale mismatch" }));
    const verification: ReproVerification = { reproduced: true, exitCode: 1, evidence: "locale mismatch" };
    const outcome = { diagnosis: parsed, reproduction, verification };
    const block = diagnosisBlock(outcome);
    for (const expected of ["DIAGNOSIS DECISIONS", "Chosen fix (root_cause): Include locale", "H1 [root_cause]", "Make it pass without weakening", "Locales never share an entry"]) expect(block).toContain(expected);
    expect(diagnosisConstraints(outcome)).toEqual(["The key includes the locale", "Validate: Locales never share an entry"]);
    expect(regressionGate(outcome)).toEqual({ executable: "npm", args: ["test", "--", "test/repro.test.ts"], severity: "fail" });
    expect(regressionGate({ diagnosis: parsed, reproduction })).toBeUndefined();
    expect(diagnosisBlock({ diagnosis: parsed, reproduction: null })).toContain("not reproduced");
    expect(needsInfoMessage({ diagnosis: { ...parsed, summary: "Works as designed" }, reproduction: null })).toContain("Works as designed");
  });
});

describe("reproduction", () => {
  const command = (executable: "node" | "npm" | "pnpm" | "yarn", ...args: string[]) => reproductionCommandProblem({ executable, args });
  it("only allows running existing tests or relative scripts", () => {
    for (const ok of [command("npm", "test"), command("npm", "test", "--", "test/repro.test.ts"), command("pnpm", "run", "test:unit"), command("yarn", "test"), command("node", "--test", "test/a.test.js"), command("node", "scripts/repro.mjs", "--case", "2")]) expect(ok).toBeUndefined();
    for (const bad of [command("node", "-e", "process.exit(1)"), command("node", "--eval", "x"), command("node", "-p", "1"), command("node", "--import", "./x.js", "a.js"), command("node", "/etc/x.js"), command("node", "../x.js"), command("node", "--test", "--require", "x"), command("npm", "install", "left-pad"), command("npm", "exec", "x"), command("npm", "run", "--prefix"), command("pnpm", "dlx", "x"), command("yarn", "add", "x"), command("npm", "test", "--", "../../secret"), command("npm", "test", "a\nb")]) expect(bad, String(bad)).toBeTypeOf("string");
    expect(reproductionCommandProblem({ executable: "npm", args: ["test"], cwd: "../other" })).toContain("cwd");
    expect(reproductionCommandProblem({ executable: "npm", args: ["test"], cwd: "packages/app" })).toBeUndefined();
  });
  it("requires the command and a failure signature before it accepts 'reproduced', and rejects forbidden commands", () => {
    const base = { outcome: "reproduced", summary: "s", test_files: ["test/r.test.ts"] };
    expect(() => validateReproduction(JSON.stringify(base))).toThrow("needs a command");
    expect(() => validateReproduction(JSON.stringify({ ...base, command: { executable: "npm", args: ["test"] } }))).toThrow("expected_failure");
    expect(() => validateReproduction(JSON.stringify({ ...base, command: { executable: "node", args: ["-e", "1"] }, expected_failure: "boom" }))).toThrow("not allowed");
    expect(validateReproduction(JSON.stringify({ outcome: "not_reproduced", summary: "s", attempts: ["a"], blockers: ["needs data"] })).outcome).toBe("not_reproduced");
    expect(() => validateReproduction("not json")).toThrow("not valid JSON");
  });
  it("parses git porcelain output including renames", () => {
    expect(changedPaths(" M src/a.ts\0?? test/new.test.ts\0R  src/b.ts\0src/old.ts\0A  c.md\0")).toEqual([{ file: "src/a.ts", untracked: false }, { file: "test/new.test.ts", untracked: true }, { file: "src/b.ts", untracked: false }, { file: "c.md", untracked: false }]);
  });
});

describe("verifyReproduction activity", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "pipe" });
  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "orch-repro-"));
    git("init", "-q");
    await mkdir(path.join(repo, "src")); await mkdir(path.join(repo, "test"));
    await writeFile(path.join(repo, "src", "lib.js"), "module.exports = 1;\n");
    git("add", "--all"); git("commit", "-q", "-m", "base");
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });
  const run = (script: string, expectedFailure: string, extra: Array<[string, string]> = []) => (async () => {
    await writeFile(path.join(repo, "test", "repro-case.js"), script);
    for (const [file, content] of extra) await writeFile(path.join(repo, file), content);
    return verifyReproduction({ worktree: repo, command: { executable: "node", args: ["test/repro-case.js"] }, expectedFailure, testFiles: ["test/repro-case.js"] });
  })();

  it("confirms a failure that carries the announced signature and undoes changes outside the tests", async () => {
    const result = await run("console.error('LOCALE_MISMATCH expected de got en'); process.exit(1);", "locale_mismatch", [["src/lib.js", "module.exports = 2; // production edit\n"], ["src/extra.js", "x\n"]]);
    expect(result.reproduced).toBe(true);
    expect(result.revertedFiles?.sort()).toEqual(["src/extra.js", "src/lib.js"]);
    expect((await readFile(path.join(repo, "src", "lib.js"), "utf8")).replace(/\r\n/g, "\n")).toBe("module.exports = 1;\n");
    await expect(readFile(path.join(repo, "src", "extra.js"))).rejects.toThrow();
  });
  it("does not accept a passing test, or a failure for another reason", async () => {
    expect(await run("process.exit(0);", "anything")).toMatchObject({ reproduced: false, exitCode: 0 });
    const other = await run("console.error('SyntaxError: unexpected token'); process.exit(1);", "LOCALE_MISMATCH");
    expect(other.reproduced).toBe(false);
    expect(other.evidence).toContain("not with the announced signature");
  });
  it("refuses a command that is not an existing test or script", async () => {
    const result = await verifyReproduction({ worktree: repo, command: { executable: "node", args: ["-e", "process.exit(1)"] }, expectedFailure: "x", testFiles: [] });
    expect(result).toMatchObject({ reproduced: false, exitCode: null });
    expect(result.evidence).toContain("not allowed");
  });
});

describe("research report", () => {
  const report = { summary: "s", findings: [{ question: "q", answer: "a", evidence: ["src/a.ts:1 - x"], confidence: "high" }], options: [], recommendation: "r", consequences: [], risks: [], open_questions: [], follow_up_tasks: [] };
  it("requires findings, and for architecture options, a decision and consequences", () => {
    expect(validateReport(JSON.stringify(report), "research").findings).toHaveLength(1);
    expect(() => validateReport(JSON.stringify({ ...report, findings: [] }), "research")).toThrow("no findings");
    expect(() => validateReport(JSON.stringify(report), "architecture")).toThrow("two options");
    const option = (name: string) => ({ name, summary: "s", pros: [], cons: [] });
    expect(() => validateReport(JSON.stringify({ ...report, options: [option("a"), option("b")], recommendation: undefined }), "architecture")).toThrow("decision or recommendation");
    expect(() => validateReport(JSON.stringify({ ...report, options: [option("a"), option("b")] }), "architecture")).toThrow("consequences");
    expect(validateReport(JSON.stringify({ ...report, options: [option("a"), option("b")], decision: "d", consequences: ["c"] }), "architecture").decision).toBe("d");
  });
  it("keeps an unreadable answer as a redacted, marked report and derives a scope from the request alone", () => {
    const raw = rawReport("The key is password=hunter2hunter2 and routing is in router.ts", deterministicScope("How is routing done?"));
    expect(raw.findings[0]!.answer).toContain("[REDACTED]");
    expect(raw.findings[0]!.answer).not.toContain("hunter2");
    expect(deterministicScope("How does the routing table pick a handler?").search_terms).toContain("routing");
  });
});

describe("context pack", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "orch-pack-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(path.join(root, "src")); await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "README.md"), "# Demo\nA router demo.\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest" }, dependencies: { zod: "1" } }));
    await writeFile(path.join(root, "src", "router.ts"), "export function route(path) {\n  const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';\n  return handlers[path];\n}\n");
    await writeFile(path.join(root, ".env"), "TOKEN=supersecretvalue\n");
    await writeFile(path.join(root, "node_modules", "dep.js"), "route route route\n");
    execFileSync("git", ["add", "--all", "--force"], { cwd: root });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("contains the map, README, package scripts and the lines around the search terms, but no secrets or credential files", async () => {
    const pack = await buildContextPack({ root, terms: ["route"], paths: [] });
    for (const expected of ["File map", "A router demo", "scripts: test", "src/router.ts (matches)", "1: export function route"]) expect(pack.text).toContain(expected);
    expect(pack.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(pack.text).not.toContain("supersecretvalue");
    expect(pack.text).not.toContain("node_modules/dep.js");
    expect(pack.files).toContain("src/router.ts");
  });
  it("stays within its size limit, and ignores requested paths that leave the repository", async () => {
    const small = await buildContextPack({ root, terms: ["route"], paths: ["../outside", "/etc/passwd", "src"], maxChars: 120 });
    expect(small.text.length).toBeLessThanOrEqual(120);
    expect(small.truncated).toBe(true);
    const escaped = await buildContextPack({ root, terms: [], paths: ["../outside", "/etc/passwd"] });
    expect(escaped.text).not.toContain("outside");
  });
  it("runs as an activity and redacts credential shapes", async () => {
    expect((await buildContextPackActivity({ worktree: root, terms: ["handlers"], paths: [] })).text).toContain("handlers[path]");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop and token = 'abcdefghijklmnopqrstuvwxyz'")).not.toMatch(/abcdefghijklmnop/);
  });
});

// ---- workflow scenarios -------------------------------------------------------------------------------------------------------------------------------------------

type Doc = { dir?: string; docsDir?: string; name?: string; taskId?: string; markdown: string };
type Defect = { stage: string; apply: (summary: string) => string; mode: "first" | "always" };
type RunState = { calls: StageInput[]; docs: Doc[]; published: Array<Record<string, unknown>>; packRequests: Array<{ terms: string[]; paths: string[] }>; verifications: ReproVerification[]; defect?: Defect };
const runs = new Map<string, RunState>();
const fake = new FakeProvider();
let env: TestWorkflowEnvironment; let worker: Worker; let running: Promise<void>; let tmp: string; let sequence = 0;
const REPRODUCED: ReproVerification = { reproduced: true, exitCode: 1, evidence: "FAKE_REPRO_FAIL: wrong locale" };
const NOT_REPRODUCED: ReproVerification = { reproduced: false, exitCode: 0, evidence: "the reproduction test passed, so it does not show the defect" };
let currentRun: RunState;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "orch-typed-")); await mkdir(path.join(tmp, "wt"));
  env = await TestWorkflowEnvironment.createLocal();
  const activities = {
    checkDependencies: async () => undefined,
    prepareWorktree: async () => path.join(tmp, "wt"),
    prepareProjectDependencies: async () => ({ installed: false, summary: "none" }),
    writeAnalysisDocument: async (input: { taskId: string; docsDir: string; markdown: string }) => { currentRun.docs.push({ docsDir: input.docsDir, taskId: input.taskId, markdown: input.markdown }); return path.join(tmp, "analysis.md"); },
    writeDocument: async (input: { dir: string; name: string; markdown: string }) => { currentRun.docs.push({ dir: input.dir, name: input.name, markdown: input.markdown }); return path.join(tmp, `${input.name}.md`); },
    buildContextPack: async (input: { terms: string[]; paths: string[] }) => { currentRun.packRequests.push(input); return { text: "PACK_MARKER: router.ts matches", files: ["src/router.ts"], truncated: false }; },
    verifyReproduction: async (): Promise<ReproVerification> => currentRun.verifications.shift() ?? NOT_REPRODUCED,
    collectWorktree: async () => path.join(tmp, "w.patch"),
    publishWorktree: async (input: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => { currentRun.published.push(input); return { branch: input.repository.branch, baseSha: input.repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/example/p/pull/1", prBaseBranch: input.repository.prBaseBranch }; },
    executeStage: async (input: StageInput): Promise<StageOutput> => {
      const state = runs.get(input.runId)!;
      state.calls.push(input);
      const out = { ...(await fake.run(input)), stage: input.stage };
      const nth = state.calls.filter(call => call.stage === input.stage).length;
      return state.defect?.stage === input.stage && (state.defect.mode === "always" || nth === 1) ? { ...out, summary: state.defect.apply(out.summary) } : out;
    },
  };
  worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: "typed", workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
  running = worker.run();
}, 120_000);
afterAll(async () => { worker.shutdown(); await running; await env.teardown(); await rm(tmp, { recursive: true, force: true }); });

const repository = { remote: "origin", targetBranch: "main", branch: "codex/t-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "Wrong language shown" };
async function run(input: Partial<RunInput> & Pick<RunInput, "prompt">, verifications: ReproVerification[] = [], defect?: Defect): Promise<{ result: RunResult; state: RunState }> {
  const id = `typed-${++sequence}`;
  const state: RunState = { calls: [], docs: [], published: [], packRequests: [], verifications: [...verifications], ...(defect ? { defect } : {}) };
  runs.set(id, state); currentRun = state;
  const full: RunInput = { runId: id, taskId: `T-${sequence}`, projectId: "p", profile: "bugfix", provider: "fake", projectRoot: tmp, artifactsDir: tmp, repository, qualityCommands: [{ executable: "npm", args: ["test"] }], ...input };
  const result = await env.client.workflow.execute(projectWorkflow, { taskQueue: "typed", workflowId: id, args: [full] });
  return { result, state };
}
const stagesOf = (state: RunState) => state.calls.map(call => call.stage);
const GATE_ARGS = ["test", "--", "test/repro.test.ts"];
const hasGate = (call: StageInput) => (call.qualityCommands ?? []).some(command => JSON.stringify(command.args) === JSON.stringify(GATE_ARGS));

describe("bug flow in the workflow", () => {
  it("diagnoses and reproduces before planning, carries the decisions to the brief and implementation, gates verification on the reproduction and commits the diagnosis", async () => {
    const { result, state } = await run({ taskType: "bug", prompt: "Users see English after choosing German" }, [REPRODUCED]);
    expect(result.status).toBe("completed");
    expect(result.metadata?.taskType).toBe("bug");
    const order = stagesOf(state);
    expect(order.slice(0, 2).sort()).toEqual(["diagnose", "reproduce"]);
    expect(order.indexOf("plan")).toBeGreaterThan(order.lastIndexOf("reproduce"));
    for (const stage of ["plan", "brief", "implement", "review", "verify"]) expect(order, stage).toContain(stage);
    expect(state.calls.find(call => call.stage === "brief")!.prompt).toContain("The cache key includes the locale");
    expect(state.calls.find(call => call.stage === "implement")!.prompt).toContain("DIAGNOSIS DECISIONS");
    expect(state.calls.find(call => call.stage === "implement")!.prompt).toContain("Make it pass without weakening");
    const verifies = state.calls.filter(call => call.stage === "verify");
    expect(verifies.length).toBeGreaterThan(0);
    expect(verifies.every(hasGate)).toBe(true);
    expect(state.calls.find(call => call.stage === "diagnose")!.prompt).toContain("Evidence rule");
    expect(state.docs.some(doc => doc.taskId?.endsWith("-diagnosis") && doc.markdown.includes("# Bug diagnosis"))).toBe(true);
    expect(state.published).toHaveLength(1);
    expect(state.published[0]!.kind).toBeUndefined();
  });
  it("retries reproduction with the code analysis as a hint when the first attempt found nothing", async () => {
    const { result, state } = await run({ taskType: "bug", prompt: "Wrong language [INJECT_REPRO_ON_HINT]" }, [REPRODUCED]);
    expect(result.status).toBe("completed");
    const attempts = state.calls.filter(call => call.stage === "reproduce");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.prompt).not.toContain("HINTS from code analysis");
    expect(attempts[1]!.prompt).toContain("HINTS from code analysis");
    expect(attempts[1]!.prompt).toContain("Cache key omits locale");
    expect(state.calls.filter(call => call.stage === "verify").every(hasGate)).toBe(true);
  });
  it("re-runs the analysis with the failing test when only the reproduction succeeded", async () => {
    const { result, state } = await run({ taskType: "bug", prompt: "Wrong language [INJECT_DIAGNOSE_ON_REPRO]" }, [REPRODUCED]);
    expect(result.status).toBe("completed");
    const analyses = state.calls.filter(call => call.stage === "diagnose");
    expect(analyses).toHaveLength(2);
    expect(analyses[1]!.prompt).toContain("HINTS from reproduction");
    expect(analyses[1]!.prompt).toContain("FAKE_REPRO_FAIL");
  });
  it("proceeds on code analysis alone when the claimed reproduction does not hold up, without a regression gate, and says so", async () => {
    const { result, state } = await run({ taskType: "bug", prompt: "Wrong language" }, [NOT_REPRODUCED, NOT_REPRODUCED]);
    expect(result.status).toBe("completed");
    expect(state.calls.filter(call => call.stage === "reproduce")).toHaveLength(2);
    expect(state.calls.some(hasGate)).toBe(false);
    expect(state.calls.find(call => call.stage === "implement")!.prompt).toContain("Reproduction: not reproduced");
    expect(result.metadata?.warnings?.some(warning => warning.message.includes("could not be reproduced"))).toBe(true);
  });
  it("stops with needs_info, changing nothing, when there is neither a reproduction nor a defect in the code", async () => {
    const { result, state } = await run({ taskType: "bug", prompt: "Something is off [INJECT_NO_HYPOTHESIS] [INJECT_NO_REPRO]" });
    expect(result.status).toBe("needs_info");
    expect(result.message).toContain("neither reproduced nor traced");
    expect(result.message).toContain("Reproduction attempts");
    expect(result.metadata?.review.stopReason).toBe("bug_needs_info");
    expect(stagesOf(state).filter(stage => ["plan", "brief", "implement", "review", "verify"].includes(stage))).toEqual([]);
    expect(state.published).toHaveLength(0);
  });
  it("leaves OpenSpec and the optional analysis out of the bug flow", async () => {
    const { result, state } = await run({ taskType: "bug", prompt: "Wrong language", analysis: true }, [REPRODUCED]);
    expect(result.status).toBe("completed");
    expect(stagesOf(state)).not.toContain("analyze");
  });
});

describe("research and architecture in the workflow", () => {
  it("explores from the context pack and publishes the report as a document PR without implementing anything", async () => {
    const { result, state } = await run({ taskType: "research", profile: "research", prompt: "How are requests routed?", documentsDir: "docs/research", qualityCommands: [] });
    expect(result.status).toBe("completed");
    expect(result.message).toContain("report produced; draft PR published");
    expect(stagesOf(state)).toEqual(["scope", "explore"]);
    expect(state.packRequests).toMatchObject([{ terms: ["route", "handler"], paths: ["src"] }]);
    expect(state.calls[1]!.prompt).toContain("PACK_MARKER");
    expect(state.calls[1]!.prompt).toContain("EXPLORE stage (research)");
    expect(state.docs).toHaveLength(1);
    expect(state.docs[0]).toMatchObject({ dir: "docs/research" });
    expect(state.docs[0]!.markdown).toContain("# Research: Wrong language shown");
    expect(state.docs[0]!.markdown).toContain("src/router.ts:10");
    expect(result.report?.markdown).toBe(state.docs[0]!.markdown);
    expect(state.published[0]!.kind).toBe("document");
    expect(result.publish?.prUrl).toContain("/pull/1");
    expect(result.metadata?.taskType).toBe("research");
  });
  it("produces an ADR-style architecture report in its own folder", async () => {
    const { result, state } = await run({ taskType: "architecture", profile: "research", prompt: "Should routing become a plugin registry?", documentsDir: "docs/architecture", qualityCommands: [] });
    expect(result.status).toBe("completed");
    expect(state.calls[1]!.prompt).toContain("EXPLORE stage (architecture)");
    expect(state.docs[0]).toMatchObject({ dir: "docs/architecture" });
    for (const expected of ["# Architecture:", "## Decision", "## Options considered", "## Consequences", "Status: proposed"]) expect(state.docs[0]!.markdown).toContain(expected);
  });
  it("keeps an unreadable exploration as a marked, redacted report and warns", async () => {
    const { result, state } = await run({ taskType: "research", profile: "research", prompt: "How are requests routed? [INJECT_UNSTRUCTURED_REPORT]", qualityCommands: [] });
    expect(result.status).toBe("completed");
    expect(state.calls.filter(call => call.stage === "explore")).toHaveLength(2);
    expect(state.docs[0]!.markdown).toContain("incomplete");
    expect(result.metadata?.warnings?.some(warning => warning.stage === "explore" && warning.message.includes("deterministic fallback"))).toBe(true);
  });
  it("needs a repository for real providers, because the report is published as a draft PR", async () => {
    const { result, state } = await run({ taskType: "research", profile: "research", prompt: "x", provider: "claude", qualityCommands: [] , repository: undefined });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("configure a clean GitHub repository");
    expect(state.calls).toHaveLength(0);
  });
  it("does not change the original pipeline for a run without a task type", async () => {
    const { result, state } = await run({ profile: "implementation", prompt: "Add a button" });
    expect(result.status).toBe("completed");
    expect(stagesOf(state)).not.toContain("diagnose");
    expect(result.metadata?.taskType).toBeUndefined();
  });
});

// Every structured stage of the typed flows recovers (repair, hint from the other half, deterministic fallback) rather than killing the run.
const DEFECTS: Record<string, (summary: string) => string> = {
  fenced: summary => ["```json", summary, "```"].join("\n"),
  prose: summary => ["Here is the result:", summary, "Tell me if you need more."].join("\n"),
  truncated: summary => summary.slice(0, Math.max(1, Math.floor(summary.length * 0.6))),
  proseOnly: () => "I looked at it and have thoughts, but no structured answer follows.",
  extraKeys: summary => { try { return JSON.stringify({ ...JSON.parse(summary) as object, notes: "extra" }); } catch { return summary; } },
  empty: () => "",
};
describe("structured stages of the typed flows never kill a run", () => {
  const bug = (stage: string) => ({ input: { taskType: "bug" as const, prompt: "Wrong language" }, stage, verifications: [REPRODUCED] });
  const research = (stage: string) => ({ input: { taskType: "research" as const, profile: "research", prompt: "How are requests routed?", qualityCommands: [] }, stage, verifications: [] });
  const cases = [...["diagnose", "reproduce"].map(stage => bug(stage)), ...["scope", "explore"].map(stage => research(stage))].flatMap(item => Object.keys(DEFECTS).flatMap(defect => (["always", ...(["truncated", "proseOnly", "empty"].includes(defect) ? ["first"] : [])] as Array<"first" | "always">).map(mode => [item, defect, mode] as const)));
  it.each(cases)("%# answer is damaged: the run still completes", async (item, defect, mode) => {
    const { result } = await run(item.input, item.verifications, { stage: item.stage, apply: DEFECTS[defect]!, mode });
    expect(result.status, `${item.stage}/${defect}/${mode}: ${result.message}`).toBe("completed");
  }, 90_000);

  it("falls back to the other half of the bug investigation, with a warning, when the analysis is unreadable on every attempt", async () => {
    const { result } = await run({ taskType: "bug", prompt: "Wrong language" }, [REPRODUCED], { stage: "diagnose", apply: DEFECTS.proseOnly!, mode: "always" });
    expect(result.status).toBe("completed");
    expect(result.metadata?.warnings?.some(warning => warning.stage === "diagnose")).toBe(true);
  }, 90_000);
});
