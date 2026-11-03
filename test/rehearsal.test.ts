// Integration rehearsal for Gate G1 (B-168, readiness plan "Test plan"): the parts built for Milestone 1 are proven together, not only one by one.
//  A. survey -> characterized, area-tagged tasks -> per-area routing -> skills within budget -> the real manifest's gate shape and the affected-test token
//  B. a ported slice through every gate of the react-ts-vite pack, then one seeded violation per gate that must fail exactly that gate
//  C. the real workflow (fake provider) carries the chain's task prompt, the skills and the contract through plan, implement and review
// The live canary on luxus-app-react (two real tasks, compared with the pilot baseline) stays a manual step recorded in docs/engineering/knowledge/metrics/runs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { effectiveRouting } from "../src/area-routing.js";
import { expandChangedArgs } from "../src/affected-tests.js";
import { ProjectManifestSchema, type RunInput, type RunResult, type StageInput, type StageOutput } from "../src/contracts.js";
import { buildContractBlock, DEFAULT_DRIFT_RULES } from "../src/contract-text.js";
import { parseTaskDirectives } from "../src/openspec-policy.js";
import { parseSurveyBacklog, planFromBacklog } from "../src/plan-from-survey.js";
import { FakeProvider } from "../src/providers.js";
import { loadCatalog, selectSkills, skillGuidance } from "../src/skills.js";
import { renderSkillsBlock } from "../src/skills-text.js";
import { projectWorkflow } from "../src/workflows.js";

const run = promisify(execFile);
const pack = path.resolve("templates/react-ts-vite");
const tmpDirs: string[] = [];
afterAll(async () => { for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true }); });

describe("rehearsal A: survey to routed, characterized tasks with skills and the real manifest", () => {
  it("turns the survey into area-tagged characterize-first tasks, routes critical areas to the strong model, and keeps every stage prompt inside the skills budget", async () => {
    const items = parseSurveyBacklog(await readFile(new URL("./fixtures/survey-luxus-app.md", import.meta.url), "utf8"));
    const plan = planFromBacklog(items, { projectId: "luxus-app-react", prefix: "LUX", reference: true, characterize: true });
    expect(plan.spec.tasks.length).toBeGreaterThan(5);
    const base = { implement: { provider: "codex" as const }, review: { provider: "claude" as const } };
    const areaRouting = { critical: { implement: { provider: "claude" as const } } };
    let critical = 0; let ordinary = 0;
    for (const task of plan.spec.tasks) {
      expect(task.prompt).toContain("CHARACTERIZE FIRST");
      expect(task.prompt).toContain("reference repository:");
      const directives = parseTaskDirectives(task.prompt);
      expect(directives.area, task.taskId).toBeTruthy();
      const routing = effectiveRouting(base, areaRouting, { area: directives.area!, critical: directives.critical === true });
      expect(routing.implement?.provider).toBe(directives.critical ? "claude" : "codex");
      expect(routing.review?.provider).toBe("claude");
      if (directives.critical) critical += 1; else ordinary += 1;
    }
    expect(critical).toBeGreaterThan(0);
    expect(ordinary).toBeGreaterThan(0);
    const catalog = loadCatalog();
    const guidance = skillGuidance(catalog, selectSkills(catalog, { profile: "react-ts", taskType: "task" }), {});
    expect(guidance?.skills.length).toBeGreaterThan(0);
    for (const stage of ["plan", "implement", "review"]) {
      const block = renderSkillsBlock(guidance, stage);
      expect(block, stage).toContain("catalog v");
      expect(block.length, stage).toBeLessThanOrEqual(3600);
    }
  });
  it("the real luxus manifest is valid, runs related tests per task through {changed}, the full suite at milestone scope and its cheap gates in parallel", async () => {
    const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile("projects/luxus-app-react.json", "utf8")));
    const gates = manifest.qualityCommands;
    const related = gates.find(gate => gate.args.includes("{changed}"));
    expect(related?.scope).toBeUndefined();
    expect(gates.find(gate => gate.args.join(" ") === "test")?.scope).toBe("milestone");
    expect(gates.filter(gate => gate.parallel).length).toBeGreaterThanOrEqual(5);
    expect(manifest.reference?.root).toBe("luxus-app");
    expect(expandChangedArgs(related!.args, ["src/router/router.ts"]).args.at(-1)).toBe("src/router/router.ts");
    expect(expandChangedArgs(related!.args, []).skipped).toBe("none-changed");
  });
});

describe("rehearsal B: a ported slice through every pack gate, then one seeded violation per gate", () => {
  let root: string;
  const script = async (name: string, ...extra: string[]): Promise<{ code: number; out: string }> => {
    try { const { stdout, stderr } = await run("node", [path.join(pack, "scripts", name), root, ...extra]); return { code: 0, out: stdout + stderr }; }
    catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
  };
  const write = async (file: string, content: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); };
  const GATES: Array<[string, string[]]> = [["check-ai-files.mjs", []], ["check-debt-ledger.mjs", []], ["check-page-docs.mjs", []], ["check-style-tokens.mjs", []], ["generate-ai-index.mjs", ["--check"]], ["check-journeys.mjs", []], ["check-module-contracts.mjs", []], ["check-parity.mjs", []], ["check-device-tiers.mjs", []], ["check-legacy-apis.mjs", []], ["check-legacy-syntax.mjs", []], ["check-legacy-budget.mjs", []]];

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "orch-rehearsal-"));
    tmpDirs.push(root);
    await write("package.json", JSON.stringify({ name: "demo", scripts: { build: "vite build" } }));
    await write("vite.config.ts", "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n");
    await write("src/main.tsx", "import App from './App'\n");
    await write("src/App.tsx", "export default function App() { return null }\n");
    await run("node", [path.resolve("scripts/apply-react-pack.mjs"), root, "--name", "Demo"]);
    await write("src/pages/offline/index.tsx", "export {};\n");
    await write("src/pages/offline/index.test.tsx", "it('C-001 reconnect clears the redirect', () => {});\n");
    await write("src/router/router.ts", "export const routes = {\n  \"/offline\": \"offline\",\n};\n");
    await write("src/router/README.md", "# router\n\nResolves a path to a route.\n\n## Interface\n`routes` maps a path to a route name.\n\n## Invariants\nOne route per path.\n\n## Side Effects\nnone\n");
    await write("docs/pages/offline.md", "# Offline\n\nRoute: /offline\n\n## Purpose\nTells the user the device is offline.\n\n## Visible content\nx\n\n## Actions\nx\n\n## Inputs\nx\n\n## Data\nx\n\n## Cases\n- C-001 reconnect clears the redirect\n");
    await write("docs/characterization/offline.json", JSON.stringify({ schemaVersion: 1, slice: "offline", legacy: { revision: "abc1234" }, cases: [{ id: "C-001", page: "offline", behaviour: "Reconnect clears the redirect cookie", expected: "cookie cleared once", basis: "static", sources: ["pages/offline.vue:1-9"] }] }));
    await write("docs/migration/map.md", "# Migration map\n\n| old file | new file | status | tests |\n|---|---|---|---|\n| pages/offline.vue | src/pages/offline/index.tsx | verified | src/pages/offline/index.test.tsx |\n");
    await write("dist/index.html", "<html><script nomodule id=\"vite-legacy-polyfill\" src=\"/assets/polyfills-legacy-x.js\"></script></html>");
    await write("dist/assets/index-legacy-a.js", "var a=function(){return[1].map(function(n){return n})};");
    await write("dist/assets/polyfills-legacy-b.js", "!function(){var x=1}();");
    await run("node", [path.join(pack, "scripts/generate-ai-index.mjs"), root]);
  }, 120_000);

  it("passes every gate on the complete slice", async () => {
    for (const [name, args] of GATES) { const result = await script(name, ...args); expect(result.code, `${name}: ${result.out}`).toBe(0); }
  }, 60_000);

  it.each([
    ["a raw colour in a component stylesheet", "check-style-tokens.mjs", [], "src/router/bad.css", ".x { color: #fff; }\n", "raw colour"],
    ["a module folder without a contract", "check-module-contracts.mjs", [], "src/hooks/useThing.ts", "export const useThing = () => 1;\n", "src/hooks/ has no README.md"],
    ["a documented case no test cites", "check-page-docs.mjs", [], "docs/pages/offline.md", "# Offline\n\nRoute: /offline\n\n## Purpose\nTells the user the device is offline.\n\n## Visible content\nx\n\n## Actions\nx\n\n## Inputs\nx\n\n## Data\nx\n\n## Cases\n- C-001 reconnect clears the redirect\n- C-002 untested\n", "case C-002 is not cited"],
    ["a characterized case the page document does not list", "check-parity.mjs", [], "docs/characterization/other.json", JSON.stringify({ schemaVersion: 1, slice: "other", legacy: { revision: "abc" }, cases: [{ id: "C-009", page: "offline", behaviour: "b", expected: "e", basis: "static", sources: ["a.vue:1"] }] }), "does not list C-009"],
    ["CSS Grid on the legacy tier", "check-legacy-apis.mjs", [], "src/router/grid.css", ".g { display: grid; }\n", "css-grid needs Chrome 57"],
    ["a new module that the AI map does not list", "generate-ai-index.mjs", ["--check"], "src/hooks/README.md", "# hooks\n\nShared hooks.\n\n## Interface\nx x\n\n## Invariants\nx x\n\n## Side Effects\nnone\n", "out of date"],
    ["modern syntax in a legacy chunk", "check-legacy-syntax.mjs", [], "dist/assets/index-legacy-a.js", "var a = b?.c;", "not valid ES2016"],
    ["a journey that covers an unknown case", "check-journeys.mjs", [], "e2e/journeys/x.md", "# J\n\nId: J-001\nMilestone: M1\n\n## Steps\n1. a\n2. b\n\n## Covers\n- offline/C-077\n", "does not list"],
  ])("fails exactly the gate for %s", async (_name, gate, args, file, content, expected) => {
    const full = path.join(root, file as string);
    let before: string | undefined;
    try { before = await readFile(full, "utf8"); } catch { before = undefined; }
    await write(file as string, content as string);
    try {
      const failing = await script(gate as string, ...(args as string[]));
      expect(failing.code).toBe(1);
      expect(failing.out).toContain(expected);
      const others = [];
      for (const [name, extra] of GATES) if (name !== gate && !(gate === "generate-ai-index.mjs" && name === "check-module-contracts.mjs")) { const result = await script(name, ...extra); if (result.code !== 0 && !(file === "src/hooks/useThing.ts" && name === "generate-ai-index.mjs")) others.push(`${name}: ${result.out.split("\n")[0]}`); }
      expect(others, "no other gate should fail").toEqual([]);
    } finally {
      if (before === undefined) await rm(full, { force: true }); else await writeFile(full, before);
    }
  }, 60_000);
});

describe("rehearsal C: the real workflow carries the chain's prompt, skills and contract", () => {
  const calls: StageInput[] = [];
  const fake = new FakeProvider();
  let env: TestWorkflowEnvironment; let worker: Worker; let running: Promise<void>; let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "orch-rehearsal-wf-"));
    tmpDirs.push(tmp);
    env = await TestWorkflowEnvironment.createLocal();
    const activities = {
      checkDependencies: async () => undefined,
      prepareWorktree: async () => tmp,
      prepareProjectDependencies: async () => ({ installed: false, summary: "none" }),
      collectWorktree: async () => path.join(tmp, "w.patch"),
      commentOnPullRequest: async () => undefined,
      publishWorktree: async (input: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: input.repository.branch, baseSha: input.repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/example/p/pull/1", prBaseBranch: input.repository.prBaseBranch }),
      executeStage: async (input: StageInput): Promise<StageOutput> => { calls.push(input); return { ...(await fake.run(input)), stage: input.stage }; },
    };
    worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: "rehearsal", workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
    running = worker.run();
  }, 120_000);
  afterAll(async () => { worker.shutdown(); await running; await env.teardown(); });

  it("completes a planned task whose prompt, skills and contract reach the plan, implement and review stages in order", async () => {
    const items = parseSurveyBacklog(await readFile(new URL("./fixtures/survey-luxus-app.md", import.meta.url), "utf8"));
    const task = planFromBacklog(items, { projectId: "luxus-app-react", prefix: "LUX", characterize: true }).spec.tasks[0]!;
    const catalog = loadCatalog();
    const skills = skillGuidance(catalog, selectSkills(catalog, { profile: "react-ts", taskType: "task" }), {});
    const contract = buildContractBlock({ rules: DEFAULT_DRIFT_RULES, contract: "REHEARSAL-CONTRACT-MARKER", file: "docs/PROJECT_CONTRACT.md", maxChars: 3000 });
    const input: RunInput = { runId: "rehearsal-1", taskId: task.taskId, projectId: "luxus-app-react", profile: "implementation", provider: "fake", prompt: task.prompt, projectRoot: tmp, artifactsDir: tmp, qualityCommands: [{ executable: "npm", args: ["test"] }],
      repository: { remote: "origin", targetBranch: "main", branch: "codex/lux-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: task.title ?? task.taskId }, projectContract: contract, ...(skills ? { skills } : {}) };
    const result: RunResult = await env.client.workflow.execute(projectWorkflow, { taskQueue: "rehearsal", workflowId: "rehearsal-1", args: [input] });
    expect(result.status).toBe("completed");
    expect(result.skills?.ids.length).toBeGreaterThan(0);
    const order = calls.map(call => call.stage);
    expect(order.indexOf("plan")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("plan")).toBeLessThan(order.indexOf("implement"));
    expect(order.indexOf("implement")).toBeLessThan(order.lastIndexOf("review"));
    for (const stage of ["plan", "implement", "review"] as const) {
      const prompts = calls.filter(call => call.stage === stage).map(call => call.prompt);
      expect(prompts.length, stage).toBeGreaterThan(0);
      expect(prompts.every(prompt => prompt.includes("REHEARSAL-CONTRACT-MARKER") && prompt.includes("SKILLS (")), stage).toBe(true);
    }
    // The plan stage sees the task text, so the characterize paragraph reaches the planner; the implementer gets the planner's brief, and the parity gate (a verified page needs a characterization) is what enforces it.
    expect(calls.find(call => call.stage === "plan")!.prompt).toContain("CHARACTERIZE FIRST");
  }, 90_000);
});
