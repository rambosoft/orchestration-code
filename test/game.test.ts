// Game projects: the game design stage, the Unity stack decision and template, the option rules, the manifest and scaffold for a Unity game (with fake Unity tools),
// and the REAL bootstrap workflow with the design stage against the fake provider.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { blueprintPrompt, buildIssuePlan, buildManifest, DEFAULT_BOOTSTRAP_CONFIG, deterministicCharter, planLimits, validateBlueprint, type BootstrapRunInput } from "../src/bootstrap.js";
import { scaffoldProjectImpl, type ScaffoldDeps } from "../src/bootstrap-activities.js";
import { renderDocs, renderPlanSummary } from "../src/bootstrap-docs.js";
import { BootstrapFormSchema, PLAN_LIMITS, resolveOptions } from "../src/bootstrap-options.js";
import { TEMPLATES, templateSummaries, usableTemplate } from "../src/bootstrap-templates.js";
import { ProjectManifestSchema, type RunInput, type RunResult, type StageInput, type StageOutput } from "../src/contracts.js";
import { designBar } from "../src/design-direction.js";
import { deterministicGameDesign, gameDesignDigest, gameDesignPrompt, isGame, isUnityGame, normalizeGameDesign, renderGameDesign, renderRulesSpec, unityStackDecision, validateGameDesign, type GameDesign } from "../src/game.js";
import { FakeProvider } from "../src/providers.js";
import { fillTemplate, findUnityEditor, templateValues, templatesRoot, withTestFramework, type UnityTools } from "../src/unity-scaffold.js";
import { unityAgentContext } from "../src/unity.js";
import { claudeExecutionArgs } from "../src/providers.js";
import { approveSignal, bootstrapStateQuery, projectWorkflow } from "../src/workflows.js";

const ids = { companyId: randomUUID(), projectId: randomUUID(), agentId: randomUUID() };
const gameOptions = { product_kind: "game", maturity: "production", approval: "required", repo_create: false };
const form = (extra: Record<string, unknown> = {}) => BootstrapFormSchema.parse({ name: "Tile Merge 2048", description: "A 2048-like mobile puzzle: slide tiles on a 4x4 board, equal tiles merge into their sum, the highest tile shows a special icon.", paperclip: { ...ids, projectId: randomUUID() }, ...extra });
function runInput(options: Record<string, string | boolean> = gameOptions, extra: Record<string, unknown> = {}): BootstrapRunInput {
  const resolved = resolveOptions(options);
  return { form: form(extra), options: resolved.values, provenance: resolved.provenance };
}
const design = (): GameDesign => validateGameDesign(designJson);
const designJson = JSON.stringify({ summary: "Tile merge puzzle.", genre: "puzzle", core_loop: ["Swipe", "Merge", "Spawn"], controls: ["Swipe"], rules: [{ id: "R-001", statement: "Slide all tiles.", edge_cases: ["No-op move is invalid"] }, { id: "R-002", statement: "Merge equal tiles once per move.", edge_cases: [] }, { id: "R-003", statement: "Game over when no move changes the board.", edge_cases: [] }], screens: [{ name: "Play", purpose: "Board", elements: ["Board"] }], test_cases: [{ rule: "R-001", given: "[2,0,0,2]", expect: "[4,0,0,0]" }] });

describe("options for a game", () => {
  it("moves a web default to Android, picks Unity, keeps visual checks on and raises a missing test depth", () => {
    const resolved = resolveOptions({ product_kind: "game", test_depth: "none" });
    expect(resolved.errors).toEqual([]);
    expect(resolved.values).toMatchObject({ platform: "mobile_android", engine: "unity", architecture: "frontend_only", visual_verification: true, test_depth: "unit" });
    expect(resolved.provenance).toMatchObject({ platform: "derived", engine: "derived", test_depth: "derived" });
    expect(resolved.warnings.join(" ")).toContain("'test_depth' was set to unit instead of your choice");
    expect(isGame(resolved.values)).toBe(true);
    expect(isUnityGame(resolved.values)).toBe(true);
  });
  it("leaves applications alone: no derived values, visual checks off for mobile apps as before", () => {
    const app = resolveOptions({ platform: "mobile_android" });
    expect(app.values).toMatchObject({ product_kind: "app", visual_verification: false });
    expect(isGame(app.values)).toBe(false);
    expect(isUnityGame(resolveOptions({ product_kind: "game", platform: "web" }).values)).toBe(true);
  });
  it("uses the game visual bar for a game and the web bar for an application", () => {
    expect(designBar(resolveOptions({ product_kind: "game", maturity: "production" }).values).join(" ")).toContain("safeArea");
    expect(designBar(resolveOptions({ maturity: "production" }).values).join(" ")).not.toContain("safeArea");
  });
});

describe("game design", () => {
  it("normalises ids, drops test cases for unknown rules and gives every rule a test case", () => {
    const parsed = validateGameDesign(JSON.stringify({ ...JSON.parse(designJson), rules: [{ id: "r 1", statement: "a" }, { id: "R-001", statement: "b" }, { id: "R-001", statement: "c" }, { statement: "d" }], test_cases: [{ rule: "R-001", given: "g", expect: "e" }, { rule: "R-099", given: "x", expect: "y" }] }));
    expect(parsed.rules.map(rule => rule.id)).toEqual(["R-001", "R-002", "R-003", "R-004"]);
    expect(parsed.test_cases.some(testCase => testCase.rule === "R-099")).toBe(false);
    expect(new Set(parsed.test_cases.map(testCase => testCase.rule))).toEqual(new Set(["R-001", "R-002", "R-003", "R-004"]));
  });
  it("rejects too few rules, no screens and unreadable answers, naming the problem", () => {
    expect(() => validateGameDesign("not json")).toThrow("not valid JSON");
    expect(() => validateGameDesign(JSON.stringify({ ...JSON.parse(designJson), rules: [{ id: "R-001", statement: "only" }] }))).toThrow("at least 3 numbered rules");
    expect(() => validateGameDesign(JSON.stringify({ ...JSON.parse(designJson), screens: [] }))).toThrow("name the screens");
    expect(() => validateGameDesign(JSON.stringify({ genre: "x" }))).toThrow("does not match its required schema");
  });
  it("falls back to the requester's own sentences as rules and says the design is missing, inventing nothing", () => {
    const fallback = deterministicGameDesign(form());
    expect(fallback.rules[0]!.statement).toContain("2048-like mobile puzzle");
    expect(fallback.open_questions[0]).toContain("could not be generated");
    expect(fallback.rules.every(rule => /^R-\d{3}$/.test(rule.id))).toBe(true);
    expect(normalizeGameDesign(fallback).test_cases.length).toBe(fallback.rules.length);
  });
  it("puts the requester's text in a data block and asks for exact values, boundaries and test cases", () => {
    const prompt = gameDesignPrompt(runInput(), "Charter vision");
    expect(prompt).toContain('"""');
    expect(prompt).toContain("GAME DESIGN stage");
    expect(prompt).toContain("exact values");
    expect(prompt).toContain("win");
    expect(prompt).toContain("test_cases");
  });
  it("renders the design and the rules spec with rule ids and cases, and the digest for the plan", () => {
    const parsed = design();
    expect(renderRulesSpec("Tile", parsed)).toContain("## R-001");
    expect(renderRulesSpec("Tile", parsed)).toContain("Given [2,0,0,2]: expect [4,0,0,0]");
    expect(renderGameDesign("Tile", parsed)).toContain("## Core loop");
    expect(gameDesignDigest(parsed)).toContain("R-002: Merge equal tiles once per move.");
  });
});

describe("unity template and plan", () => {
  it("is offered only to games, never to the stack stage of an application", () => {
    expect(templateSummaries().map(item => item.id)).not.toContain("unity-mobile-2d");
    expect(usableTemplate("unity-mobile-2d", "mobile_android", "frontend_only")).toBeUndefined();
    expect(usableTemplate("unity-mobile-2d", "mobile_android", "frontend_only", true)?.ecosystem).toBe("unity");
    expect(usableTemplate("unity-mobile-2d", "web", "frontend_only", true)).toBeUndefined();
  });
  it("states the Unity stack without asking a model", () => {
    const stack = unityStackDecision();
    expect(stack).toMatchObject({ template_id: "unity-mobile-2d", language: "C#", architecture: "frontend_only" });
  });
  it("tells the blueprint stage the game milestone order, rule coverage and the design digest", () => {
    const run = runInput();
    const prompt = blueprintPrompt(run, { ...unityStackDecision(), template_id: "unity-mobile-2d" }, deterministicCharter(run), planLimits("normal"), true, design());
    expect(prompt).toContain("This is a game built with Unity");
    expect(prompt).toContain("Covers: R-003");
    expect(prompt).toContain("--strict-rules");
    expect(prompt).toContain("R-002: Merge equal tiles once per move.");
    expect(prompt).not.toContain("default browser styling");
  });
  it("puts the game bar and the rule documents into the generated documents and the plan summary", () => {
    const run = runInput(); const parsed = design();
    const docs = renderDocs({ form: run.form, options: run.options, provenance: run.provenance, stack: { ...unityStackDecision(), template_id: "unity-mobile-2d" }, charter: deterministicCharter(run), blueprint: validateBlueprint(blueprintJsonFor(), PLAN_LIMITS.normal!), design: parsed, template: TEMPLATES["unity-mobile-2d"]! });
    expect(Object.keys(docs)).toEqual(expect.arrayContaining(["docs/GAME_DESIGN.md", "docs/RULES_SPEC.md", "docs/DESIGN_DIRECTION.md", "CLAUDE.md", "AGENTS.md"]));
    expect(docs["docs/PROJECT_CONTRACT.md"]).toContain("Never edit scene, prefab or .meta YAML by hand");
    expect(docs["CLAUDE.md"]).toContain("unity test --mode EditMode");
    expect(docs["CLAUDE.md"]).toContain("Covers: R-001");
    expect(docs["README.md"]).toContain("unity build --target Android");
    expect(docs["docs/DESIGN_DIRECTION.md"]).toContain("PlayMode capture test");
    expect(renderPlanSummary({ form: run.form, options: run.options, provenance: run.provenance, stack: { ...unityStackDecision(), template_id: "unity-mobile-2d" }, charter: deterministicCharter(run), blueprint: validateBlueprint(blueprintJsonFor(), PLAN_LIMITS.normal!), design: parsed })).toContain("Rules (3):");
  });
  it("gates tasks on the Unity CLI by maturity and gives the unity-mobile manifest the Unity visual capture", () => {
    const template = TEMPLATES["unity-mobile-2d"]!;
    const manifestFor = (maturity: string, testDepth = "unit") => ProjectManifestSchema.parse(buildManifest({ projectId: randomUUID(), form: form({ repoName: "tile-merge" }), options: resolveOptions({ product_kind: "game", maturity, test_depth: testDepth }).values, template, hasRepository: true, config: DEFAULT_BOOTSTRAP_CONFIG, editorVersion: "6000.3.11f1" }));
    const production = manifestFor("production");
    expect(production.stack).toMatchObject({ profile: "unity-mobile", unity: { editorVersion: "6000.3.11f1", executeMethods: ["Builder.Android"] } });
    expect(production.qualityCommands.map(command => `${command.executable} ${command.args[0]}${command.severity === "warn" ? " (warn)" : ""}`)).toEqual(["node scripts/check-unity-hygiene.mjs", "unity test", "unity test", "unity build"]);
    expect(production.visual).toMatchObject({ engine: "unity", unityFilter: "CaptureTests" });
    expect(production.providerTimeouts.implement).toBeGreaterThanOrEqual(3_600_000);
    expect(manifestFor("mvp").qualityCommands.at(-1)).toMatchObject({ severity: "warn" });
    // a game never runs below unit tests (derived), so even a prototype gates on both test modes but has no build gate
    expect(manifestFor("prototype", "smoke").qualityCommands.map(command => command.args[0])).toEqual(["scripts/check-unity-hygiene.mjs", "test", "test"]);
  });
  it("adds the design block with the game bar to every building task", () => {
    const run = runInput();
    const plan = buildIssuePlan(validateBlueprint(blueprintJsonFor(), PLAN_LIMITS.normal!), run.options, true, deterministicCharter(run));
    const task = plan.find(issue => issue.kind === "task")!;
    expect(task.description).toContain("UI/UX direction");
    expect(task.description).toContain("safe");
  });
});

function blueprintJsonFor() {
  const task = (key: string, deps: string[] = []) => ({ key, title: `Task ${key}`, description: "Covers R-001", type: "task", acceptance: ["Covers: R-001"], depends_on: deps });
  return JSON.stringify({ summary: "s", milestones: [{ key: "M1", title: "Core", goal: "g", exit_criteria: [], tasks: [task("T1"), task("T2", ["T1"])] }] });
}

describe("unity scaffold helpers", () => {
  it("fills the placeholders with safe values", () => {
    const values = templateValues('Tile "Merge" \\ 2048', "2048-tile-merge", { game_orientation: "both", game_fps: "30" });
    expect(values).toMatchObject({ PACKAGE: "g2048tilemerge", ORIENTATION: "AutoRotation", FPS: "30" });
    expect(values.NAME).toContain("Merge");
    expect(values.NAME).not.toMatch(/["\\]/);
    expect(templateValues("Game", "tile-merge", {}).ORIENTATION).toBe("Portrait");
    expect(templateValues("Game", "tile-merge", { game_orientation: "landscape" }).ORIENTATION).toBe("LandscapeLeft");
    expect(fillTemplate('X "{{NAME}}" {{PACKAGE}} {{FPS}} {{ORIENTATION}} {{OTHER}}', values)).toContain("{{OTHER}}");
  });
  it("adds the test framework once and keeps the other dependencies", () => {
    const patched = JSON.parse(withTestFramework(JSON.stringify({ dependencies: { "com.unity.modules.ui": "1.0.0" } })));
    expect(patched.dependencies).toEqual({ "com.unity.test-framework": "1.6.0", "com.unity.modules.ui": "1.0.0" });
    expect(JSON.parse(withTestFramework(JSON.stringify({ dependencies: { "com.unity.test-framework": "9.9.9" } }))).dependencies["com.unity.test-framework"]).toBe("9.9.9");
  });
  it("finds the newest Unity 6 Editor or the configured one", () => {
    const list = () => ["2022.3.1f1", "6000.3.9f1", "6000.3.11f1", "6000.10.0f1", "notes"];
    expect(findUnityEditor({ UNITY_EDITORS_ROOT: "R" }, () => true, list)).toBe(path.join("R", "6000.10.0f1", "Editor", "Unity.exe"));
    expect(findUnityEditor({ UNITY_EDITOR_PATH: "C:/u/Unity.exe" }, file => file === "C:/u/Unity.exe", list)).toBe("C:/u/Unity.exe");
    expect(findUnityEditor({ UNITY_EDITOR_PATH: "C:/gone/Unity.exe" }, () => false, list)).toBeUndefined();
    expect(findUnityEditor({ UNITY_EDITORS_ROOT: "R" }, () => false, list)).toBeUndefined();
    expect(findUnityEditor({}, () => true, () => { throw new Error("no folder"); })).toBeUndefined();
  });
  it("ships the template files the scaffold copies", async () => {
    for (const file of ["Assets/Scripts/Logic/Game.Logic.asmdef", "Assets/Tests/PlayMode/CaptureTests.cs", "Assets/Editor/Builder.cs", "scripts/check-unity-hygiene.mjs", ".gitignore", ".gitattributes"]) await stat(path.join(templatesRoot(), "unity-mobile-2d", file));
  });
  it("lets Claude run the Unity CLI and load the official plugin only in a Unity project", () => {
    expect(unityAgentContext("C:/p", {}, () => false)).toBeUndefined();
    expect(unityAgentContext("C:/p", {}, file => file.endsWith("ProjectVersion.txt"))).toEqual({});
    const context = unityAgentContext("C:/p", { UNITY_AGENT_PLUGIN_DIR: "C:/plugin" }, () => true);
    expect(context).toEqual({ pluginDir: "C:/plugin" });
    const withUnity = claudeExecutionArgs("go", "implement", {}, undefined, context);
    expect(withUnity.join(" ")).toContain("--plugin-dir C:/plugin");
    expect(withUnity.find(arg => arg.startsWith("--allowedTools="))).toContain("Bash(unity:*)");
    expect(claudeExecutionArgs("go", "implement", {}).join(" ")).not.toContain("unity");
    expect(claudeExecutionArgs("go", "review", {}, undefined, context).join(" ")).not.toContain("allowedTools");
  });
});

describe("unity scaffold", () => {
  let root: string; let manifests: string;
  beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "orch-unity-scaffold-")); manifests = path.join(root, "manifests"); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  /** Stand-in for the Editor and the CLI: creates the folders Unity would, writes .meta files on import and a passing report on test. */
  function fakeTools(behaviour: { createCode?: number; importCode?: number; testCode?: number; xml?: string; noMeta?: boolean } = {}) {
    const calls: string[] = [];
    const tools: UnityTools = {
      createProject: async dir => {
        calls.push("create");
        if (behaviour.createCode) return { code: behaviour.createCode, output: "", stderr: "No valid Unity Editor licence" };
        await mkdir(path.join(dir, "ProjectSettings"), { recursive: true }); await mkdir(path.join(dir, "Packages"), { recursive: true }); await mkdir(path.join(dir, "Assets"), { recursive: true });
        await writeFile(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.11f1\n");
        await writeFile(path.join(dir, "ProjectSettings", "EditorSettings.asset"), "EditorSettings:\n  m_SerializationMode: 2\n");
        await writeFile(path.join(dir, "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.unity.modules.ui": "1.0.0" } }));
        return { code: 0, output: "", stderr: "" };
      },
      cli: async (args, cwd) => {
        calls.push(args[0]!);
        if (args[0] === "run") { if (!behaviour.noMeta) await writeFile(path.join(cwd, "Assets/Scripts/Logic/Game.Logic.asmdef.meta"), "x"); return { code: behaviour.importCode ?? 0, output: "", stderr: behaviour.importCode ? "compile error CS0246" : "" }; }
        const report = args[args.indexOf("--output") + 1]!;
        await mkdir(path.dirname(report), { recursive: true });
        await writeFile(report, behaviour.xml ?? '<test-run total="1" passed="1" failed="0"></test-run>');
        return { code: behaviour.testCode ?? 0, output: "", stderr: "" };
      },
    };
    return { tools, calls };
  }
  const deps = (tools: UnityTools, calls: string[] = []): ScaffoldDeps => ({
    env: { ORCHESTRATOR_PROJECTS_ROOT: path.join(root, "projects"), ORCHESTRATOR_PROJECTS_DIR: manifests, ORCHESTRATOR_BOOTSTRAP_CONFIG: path.join(root, "none.json") },
    run: async (command, args) => { calls.push(`${command} ${args.join(" ")}`); return command === "git" && args[0] === "rev-parse" ? "d".repeat(40) : ""; },
    npm: async () => { throw new Error("a Unity project must not call npm"); }, unity: tools,
  });
  const request = (repoName: string, options: Record<string, string | boolean> = gameOptions) => {
    const run = runInput(options, { repoName, paperclip: { ...ids, projectId: randomUUID() } });
    return { runId: "r", run, stack: { ...unityStackDecision(), template_id: "unity-mobile-2d" }, charter: deterministicCharter(run), blueprint: validateBlueprint(blueprintJsonFor(), PLAN_LIMITS.normal!), design: design() };
  };

  it("creates the project with Unity, copies the template and documents, proves it, commits and writes a Unity manifest", async () => {
    const { tools, calls } = fakeTools(); const runs: string[] = [];
    const outcome = await scaffoldProjectImpl(request("tile-merge"), deps(tools, runs));
    expect(calls).toEqual(["create", "run", "test"]);
    expect(outcome).toMatchObject({ template: "unity-mobile-2d", verified: true, commit: "d".repeat(40) });
    const dir = path.join(root, "projects", "tile-merge");
    for (const file of ["Assets/Scripts/Logic/Game.Logic.asmdef", "Assets/Tests/PlayMode/CaptureTests.cs", "scripts/check-unity-hygiene.mjs", ".gitignore", "docs/GAME_DESIGN.md", "docs/RULES_SPEC.md", "docs/PROJECT_CONTRACT.md", "CLAUDE.md"]) await stat(path.join(dir, file));
    expect(await readFile(path.join(dir, "Assets/Scripts/Logic/GameInfo.cs"), "utf8")).toContain('"Tile Merge 2048"');
    expect(await readFile(path.join(dir, "Assets/Editor/Builder.cs"), "utf8")).toContain("com.paperclip.tilemerge");
    expect(JSON.parse(await readFile(path.join(dir, "Packages/manifest.json"), "utf8")).dependencies["com.unity.test-framework"]).toBe("1.6.0");
    expect(runs[0]).toBe("node scripts/check-unity-hygiene.mjs");
    expect(runs).toContain("git init -b main");
    const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile(outcome.manifestPath, "utf8")));
    expect(manifest.stack).toMatchObject({ profile: "unity-mobile", unity: { editorVersion: "6000.3.11f1" } });
    expect(manifest.visual?.engine).toBe("unity");
  });
  it("fails closed with a readable message and removes the folder when Unity has no licence, the import fails or tests fail", async () => {
    await expect(scaffoldProjectImpl(request("no-licence"), deps(fakeTools({ createCode: 198 }).tools))).rejects.toThrow("No valid Unity Editor licence");
    await expect(stat(path.join(root, "projects", "no-licence"))).rejects.toThrow();
    await expect(scaffoldProjectImpl(request("bad-import"), deps(fakeTools({ importCode: 6 }).tools))).rejects.toThrow("import of the new project failed");
    await expect(scaffoldProjectImpl(request("bad-tests"), deps(fakeTools({ testCode: 8 }).tools))).rejects.toThrow("failed its EditMode tests");
    await expect(scaffoldProjectImpl(request("empty-run"), deps(fakeTools({ xml: '<test-run total="0" passed="0" failed="0"></test-run>' }).tools))).rejects.toThrow("0 tests");
    await expect(scaffoldProjectImpl(request("no-meta"), deps(fakeTools({ noMeta: true }).tools))).rejects.toThrow(".meta");
    await expect(stat(path.join(root, "projects", "bad-tests"))).rejects.toThrow();
  });
});

// ---- the real workflow ---------------------------------------------------------------------------------------------------------------------------------------------

type State = { calls: StageInput[]; scaffolds: Array<{ design?: GameDesign }>; defect?: (stage: string, summary: string) => string };
const states = new Map<string, State>();
const fake = new FakeProvider();
let env: TestWorkflowEnvironment; let worker: Worker; let running: Promise<void>; let tmp: string; let sequence = 0;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "orch-gameflow-"));
  env = await TestWorkflowEnvironment.createLocal();
  const activities = {
    prepareBootstrapSandbox: async () => tmp,
    scaffoldProject: async (request: { runId: string; design?: GameDesign }) => { states.get(request.runId)!.scaffolds.push({ ...(request.design ? { design: request.design } : {}) }); return { projectRoot: path.join(tmp, "game"), commit: "e".repeat(40), manifestPath: path.join(tmp, "m.json"), template: "unity-mobile-2d", verified: true, warnings: [] }; },
    materializeIssues: async (request: { issues: Array<{ key: string; title: string; kind: "milestone" | "task" }> }) => request.issues.map((issue, index) => ({ key: issue.key, id: `I-${index}`, title: issue.title, kind: issue.kind, status: "backlog" })),
    executeStage: async (input: StageInput): Promise<StageOutput> => {
      const state = states.get(input.runId)!; state.calls.push(input);
      const out = { ...(await fake.run(input)), stage: input.stage };
      return state.defect ? { ...out, summary: state.defect(input.stage, out.summary) } : out;
    },
  };
  worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: "game", workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
  running = worker.run();
}, 120_000);
afterAll(async () => { worker.shutdown(); await running; await env.teardown(); await rm(tmp, { recursive: true, force: true }); });

async function start(options: Record<string, string | boolean>, defect?: State["defect"]) {
  const id = `game-${++sequence}`;
  const state: State = { calls: [], scaffolds: [], ...(defect ? { defect } : {}) }; states.set(id, state);
  const resolved = resolveOptions(options);
  const input: RunInput = { runId: id, taskId: `G-${sequence}`, projectId: ids.projectId, profile: "bootstrap", prompt: "Set up", taskType: "bootstrap", provider: "fake", projectRoot: tmp, artifactsDir: tmp, approval: true, plugins: [], qualityCommands: [], bootstrap: { form: form(), options: resolved.values, provenance: resolved.provenance }, providerRouting: DEFAULT_BOOTSTRAP_CONFIG.stages };
  const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: "game", workflowId: id, args: [input] });
  return { handle, state };
}
async function awaitPhase(handle: Awaited<ReturnType<typeof start>>["handle"], phase: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await handle.query(bootstrapStateQuery).catch(() => undefined);
    if (state?.phase === phase) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`workflow never reached ${phase}`);
}

describe("game bootstrap workflow", () => {
  it("skips the stack model stage, runs the design stage between charter and blueprint, shows the rules for approval and scaffolds with the design", async () => {
    const { handle, state } = await start(gameOptions);
    const waiting = await awaitPhase(handle, "awaiting_approval");
    expect(state.calls.map(call => call.stage)).toEqual(["charter", "design", "blueprint"]);
    expect(waiting.stack?.template_id).toBe("unity-mobile-2d");
    expect(waiting.design?.rules.map(rule => rule.id)).toEqual(["R-001", "R-002", "R-003"]);
    expect(waiting.summary).toContain("## Game design");
    expect(state.calls[1]!.prompt).toContain("GAME DESIGN stage");
    expect(state.calls[2]!.prompt).toContain("R-002: Two equal tiles that meet merge once per move into their sum.");
    expect(state.scaffolds).toHaveLength(0);
    await handle.signal(approveSignal, true);
    const result: RunResult = await handle.result();
    expect(result.status).toBe("completed");
    expect(state.scaffolds[0]!.design?.rules).toHaveLength(3);
    expect(result.bootstrap!.template).toBe("unity-mobile-2d");
  });
  it("repairs an unusable design answer once and falls back to the requester's own words when it stays unusable, with the run still reaching approval", async () => {
    const { handle, state } = await start(gameOptions, (stage, summary) => stage === "design" ? "this is not a design" : summary);
    const waiting = await awaitPhase(handle, "awaiting_approval");
    expect(state.calls.filter(call => call.stage === "design").length).toBeGreaterThanOrEqual(2);
    expect(waiting.design?.open_questions[0]).toContain("could not be generated");
    expect(waiting.warnings.join(" ")).toContain("design");
    await handle.signal(approveSignal, false);
    expect((await handle.result()).status).toBe("rejected");
  });
  it("leaves an application on the original three stages with the model's stack", async () => {
    const { handle, state } = await start({ maturity: "prototype" });
    await awaitPhase(handle, "awaiting_approval");
    expect(state.calls.map(call => call.stage)).toEqual(["stack", "charter", "blueprint"]);
    await handle.signal(approveSignal, false);
    await handle.result();
  });
});
