import { describe, expect, it } from "vitest";
import { ProjectManifestSchema } from "../src/contracts.js";
import { profiles } from "../src/profiles.js";
import { PluginRegistry } from "../src/plugins.js";
import { cliProviderEnvironment, codexExecutionArgs, FakeProvider, OpenRouterProvider, parseCodexTelemetry } from "../src/providers.js";
import { StageOutputSchema } from "../src/contracts.js";
import { workflowId } from "../src/client.js";
import { blockingFindings, effectiveMaxReviewRounds, externalBlockers, failureDetails, implementationPrompt, reviewPrompt, stageRoute } from "../src/workflows.js";
import { executeStage, reviewPromptWithDiff } from "../src/activities.js";
import { resolveRtkStatus } from "../src/rtk.js";
import { DEFAULT_UI_UX_CONFIG, resolveUiUxConfig, selectUiUxSkills, uiUxGuidance } from "../src/uiux.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProjectFrameworks } from "../src/uiux-config.js";
import { resolveProjectId } from "../paperclip-adapter/index.js";
import { resolveProjectHostRoot } from "../src/project-roots.js";

describe("manifest and profiles", () => {
  it("attaches the current implementation diff to the focused review prompt", () => {
    const prompt = reviewPromptWithDiff("Acceptance checklist", "diff --git a/src/example.ts b/src/example.ts\n+changed() {}");
    expect(prompt).toContain("Acceptance checklist");
    expect(prompt).toContain("Implementation diff (review this code against the task requirements)");
    expect(prompt).toContain("+changed() {}");
  });
  it("routes Paperclip issues to their own project instead of pinning the shared agent", () => {
    expect(resolveProjectId({ projectId: "project-from-issue" }, "legacy-agent-project")).toBe("project-from-issue");
    expect(resolveProjectId({ projectId: null }, "legacy-agent-project")).toBe("legacy-agent-project");
    expect(resolveProjectId({ projectId: null }, undefined)).toBeUndefined();
  });
  it("resolves projects below one shared checkout root and rejects paths outside it", () => {
    expect(resolveProjectHostRoot({ id: "ui-pilot", root: "mobile-rts-landing" }, { ORCHESTRATOR_PROJECTS_ROOT: "C:/projects" })).toBe(path.win32.resolve("C:/projects/mobile-rts-landing"));
    expect(() => resolveProjectHostRoot({ id: "unsafe", root: "../other" }, { ORCHESTRATOR_PROJECTS_ROOT: "C:/projects" })).toThrow("must stay inside ORCHESTRATOR_PROJECTS_ROOT");
    expect(resolveProjectHostRoot({ id: "legacy", root: "unused", rootEnv: "LEGACY_ROOT" }, { LEGACY_ROOT: "C:/legacy/project" })).toBe(path.win32.resolve("C:/legacy/project"));
  });
  it("validates project manifests and rejects malformed identifiers", () => {
    expect(ProjectManifestSchema.safeParse({ id: "demo-typescript", name: "Demo", root: "./demo", defaultProfile: "implementation" }).success).toBe(true);
    expect(ProjectManifestSchema.safeParse({ id: "BAD ID", name: "Demo", root: "./demo", defaultProfile: "unknown" }).success).toBe(false);
    const legacy = ProjectManifestSchema.parse({ id: "demo-typescript", name: "Demo", root: "./demo", defaultProfile: "implementation", policy: { maxRepairAttempts: 3 } });
    expect(legacy.policy.maxReviewRounds).toBe(4);
    expect(effectiveMaxReviewRounds({ maxReviewRounds: legacy.policy.maxReviewRounds, maxRepairAttempts: legacy.policy.maxRepairAttempts })).toBe(4);
    expect(ProjectManifestSchema.parse({ id: "demo-typescript", name: "Demo", root: "./demo", defaultProfile: "implementation" }).policy.maxReviewRounds).toBe(2);
    expect(effectiveMaxReviewRounds({ maxRepairAttempts: 0 })).toBe(1);
    expect(effectiveMaxReviewRounds({})).toBe(2);
  });
  it("research skips implementation stages", () => expect(profiles.research.stages).toEqual(["research", "verify"]));
  it("uses stable task and revision workflow identity", () => {
    expect(workflowId({ taskId: "PAP-5", taskRevision: "r2", runId: "one" })).toBe(workflowId({ taskId: "PAP-5", taskRevision: "r2", runId: "two" }));
    expect(workflowId({ taskId: "PAP-5", taskRevision: "r3", runId: "one" })).not.toBe(workflowId({ taskId: "PAP-5", taskRevision: "r2", runId: "one" }));
    expect(workflowId({ taskId: "PAP-5", taskRevision: "r2", attempt: 2, runId: "one" })).not.toBe(workflowId({ taskId: "PAP-5", taskRevision: "r2", attempt: 1, runId: "two" }));
  });
  it("validates MiniMax routing and requires an OpenRouter model", () => {
    const base = { id: "demo-typescript", name: "Demo", root: "./demo", defaultProfile: "research" };
    expect(ProjectManifestSchema.safeParse({ ...base, providerRouting: { research: { provider: "openrouter", model: "minimax/minimax-m3.1-flash:free" }, implement: { provider: "codex", reasoningEffort: "low" } } }).success).toBe(true);
    expect(ProjectManifestSchema.safeParse({ ...base, providerRouting: { research: { provider: "openrouter" } } }).success).toBe(false);
  });
  it("validates optional UI/UX project overrides", () => {
    const base = { id: "demo-typescript", name: "Demo", root: "./demo", defaultProfile: "implementation" };
    expect(ProjectManifestSchema.safeParse({ ...base, uiUx: { autoSelect: false, include: ["vercel-composition-patterns"] } }).success).toBe(true);
    expect(ProjectManifestSchema.safeParse({ ...base, uiUx: { include: ["unknown-skill"] } }).success).toBe(false);
  });
  it("auto-selects compatible skills and lets project overrides force or exclude them", () => {
    const selected = selectUiUxSkills({ prompt: "Improve the dashboard layout and responsive behavior", frameworks: ["react", "web"] });
    expect(selected.map(skill => skill.id)).toEqual(["ui-ux-pro-max", "frontend-design", "vercel-composition-patterns"]);
    expect(selectUiUxSkills({ prompt: "Fix the parser", frameworks: ["react"] })).toEqual([]);
    const config = resolveUiUxConfig({ ...DEFAULT_UI_UX_CONFIG, exclude: ["ui-ux-pro-max"] }, { include: ["ui-ux-pro-max"], autoSelect: false });
    expect(config.enabled).toBe(true);
    expect(selectUiUxSkills({ prompt: "Fix the parser", frameworks: ["react"], config }).map(skill => skill.id)).toEqual(["ui-ux-pro-max"]);
    expect(uiUxGuidance({ prompt: "Build a mobile screen", frameworks: ["react-native"] })).toContain("React Native and Expo UI/performance practices");
    expect(selectUiUxSkills({ prompt: "Improve the screen", config: { ...DEFAULT_UI_UX_CONFIG, enabled: false } })).toEqual([]);
  });
  it("detects UI frameworks from a project package manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uiux-frameworks-"));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19", expo: "^55", next: "^16" } }));
      expect(await detectProjectFrameworks(root)).toEqual(["react-native", "react", "next"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("routes Codex to implementation and repair while non-coding stages use MiniMax", () => {
    const routing = {
      plan: { provider: "openrouter" as const, model: "minimax/minimax-m3.1-flash:free" },
      research: { provider: "openrouter" as const, model: "minimax/minimax-m3.1-flash:free" },
      review: { provider: "openrouter" as const, model: "minimax/minimax-m3.1-flash:free" },
      verify: { provider: "openrouter" as const, model: "minimax/minimax-m3.1-flash:free" },
      implement: { provider: "codex" as const, reasoningEffort: "low" as const },
    };
    const input = { runId: "r", taskId: "t", projectId: "p", profile: "implementation", prompt: "task", projectRoot: ".", artifactsDir: ".", providerRouting: routing };
    expect(stageRoute(input, "implement")).toEqual({ provider: "codex", reasoningEffort: "low" });
    expect(stageRoute(input, "review")).toEqual({ provider: "openrouter", model: "minimax/minimax-m3.1-flash:free" });
  });
  it("makes the first review comprehensive and follow-up reviews focus on prior fixes and regressions", () => {
    const initial = reviewPrompt("Task acceptance", [], 1);
    expect(initial).toContain("FIRST REVIEW");
    expect(initial).toContain("check this checklist against the full diff");
    expect(initial).toContain("Return exactly one JSON object");
    const followUp = reviewPrompt("Task acceptance", [
      { stage: "review", ok: false, summary: "VERDICT: NEEDS_CHANGES", findings: ["Fix error-state recovery"], artifactRefs: [], provider: "openrouter", durationMs: 1 },
      { stage: "implement", ok: true, summary: "Fixed error-state recovery", findings: [], artifactRefs: [], provider: "codex", durationMs: 1 },
      { stage: "verify", ok: true, summary: "Deterministic quality checks passed before focused review.", findings: [], artifactRefs: [], provider: "quality-gate", durationMs: 1 },
    ], 2);
    expect(followUp).toContain("FOLLOW-UP REVIEW 2");
    expect(followUp).toContain("Fix error-state recovery");
    expect(followUp).toContain("repeat fixed findings");
    expect(followUp).toContain("verify only prior blockers");
    expect(followUp).toContain("return pass");
    expect(followUp).toContain("Implementation summary");
    expect(followUp).toContain("Deterministic check result before this review");
  });
  it("requires acceptance evidence, focused tests, and exact check results for implementation", () => {
    const prompt = implementationPrompt("Add expression editing with undo and redo.", undefined, [
      { executable: "npm", args: ["test"] },
      { executable: "npm", args: ["run", "test:e2e"] },
    ]);
    expect(prompt).toContain("satisfy every acceptance_check");
    expect(prompt).toContain("run focused tests only");
    expect(prompt).toContain("Inspect the diff");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("npm run test:e2e");
  });
  it("turns every blocking review finding into a test-backed repair checklist", () => {
    const prompt = implementationPrompt("Build the editor.", [
      { severity: "high", category: "functional", title: "Redo throws", evidence: "Redo reads an undefined selection", acceptanceCriterion: "Undo and redo restore cursor state", fixableInCode: true },
      { severity: "critical", category: "acceptance", title: "Degree notation rejected", evidence: "45° returns parse error", fixableInCode: true },
    ], [{ executable: "npm", args: ["test"] }, { executable: "npm", args: ["run", "test:e2e"] }]);
    expect(prompt).toContain("One bounded repair pass remains");
    expect(prompt).toContain("Redo throws");
    expect(prompt).toContain("45° returns parse error");
    expect(prompt).toContain("add or update a regression test");
    expect(prompt).toContain("Resolve each blocker below");
    expect(prompt).toContain("Run focused tests");
  });
});

const stageInput = { runId: "r", taskId: "t", projectId: "p", profile: "research", stage: "research" as const, prompt: "produce a short report", attempt: 1, provider: "openrouter", model: "minimax/minimax-m3.1-flash:free", projectRoot: ".", artifactsDir: ".", plugins: [] };
describe("OpenRouter provider", () => {
  it("keeps the OpenRouter key out of other provider CLI environments", () => {
    const filtered = cliProviderEnvironment({ OPENROUTER_API_KEY: "secret", PATH: "C:/tools" });
    expect(filtered.OPENROUTER_API_KEY).toBeUndefined();
    expect(filtered.PATH).toBe("C:/tools");
  });

  it("sends the configured model and returns structured output without exposing the key", async () => {
    const key = "test-secret-openrouter-key";
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenRouterProvider(key, async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ model: "minimax/minimax-m3.1-flash:free", choices: [{ message: { content: "A concise result." } }], usage: { total_tokens: 12 } });
    });
    const result = await provider.run(stageInput);
    expect(requestBody?.model).toBe(stageInput.model);
    expect(requestBody?.max_tokens).toBe(4096);
    expect(requestBody?.reasoning_effort).toBe("low");
    expect(result.summary).toBe("A concise result.");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.metadata?.model).toBe(stageInput.model);
  });

  it("requests JSON mode for structured stages on Gemma 4", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenRouterProvider("test-key", async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: "{}" } }] });
    });
    await provider.run({ ...stageInput, stage: "plan", model: "google/gemma-4-26b-a4b-it:free" });
    expect(requestBody?.response_format).toEqual({ type: "json_object" });
  });

  it("uses a required structured tool for Nemotron and reads its arguments", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const structured = JSON.stringify({ task_goal: "Fix the feature", approach: "Update the UI", important_decisions: [], risks: [], acceptance_criteria: ["Build passes"], hard_constraints: [] });
    const provider = new OpenRouterProvider("test-key", async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "submit_structured_result", arguments: structured } }] } }] });
    });
    const result = await provider.run({ ...stageInput, stage: "plan", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    expect((requestBody?.tools as Array<{ function: { name: string } }>)[0]?.function.name).toBe("submit_structured_result");
    expect(requestBody?.tool_choice).toEqual({ type: "function", function: { name: "submit_structured_result" } });
    expect(result.summary).toBe(structured);
  });

  it("turns a MiniMax review verdict into the configured repair gate", async () => {
    let reviewPrompt = "";
    const provider = new OpenRouterProvider("test-key", async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      reviewPrompt = body.messages[0]!.content;
      return Response.json({ choices: [{ message: { content: "VERDICT: NEEDS_CHANGES\n1. Fix the calculator edge case." } }] });
    });
    const result = await provider.run({ ...stageInput, stage: "review" });
    expect(result.ok).toBe(false);
    expect(result.findings.join("\n")).toContain("Fix the calculator edge case");
    expect(result.review?.findings[0]?.severity).toBe("high");
    expect(reviewPrompt).toContain("review contract in the task prompt");
  });

  it("parses structured severity and keeps polish non-blocking", async () => {
    const response = JSON.stringify({ verdict: "pass", findings: [], notes: [{ severity: "low", category: "polish", title: "Tweak spacing", evidence: "Minor visual preference", fixableInCode: true }] });
    const provider = new OpenRouterProvider("test-key", async () => Response.json({ choices: [{ message: { content: response } }] }));
    const result = await provider.run({ ...stageInput, stage: "review" });
    expect(result.ok).toBe(true);
    expect(result.review?.notes).toHaveLength(1);
    expect(blockingFindings(result)).toEqual([]);
  });

  it("classifies environment prerequisites separately from code fixes", async () => {
    const response = JSON.stringify({ verdict: "needs_changes", findings: [{ severity: "high", category: "environment", title: "Hook is not trusted", evidence: "Codex project hook is inactive", fixableInCode: false }], notes: [] });
    const provider = new OpenRouterProvider("test-key", async () => Response.json({ choices: [{ message: { content: response } }] }));
    const result = await provider.run({ ...stageInput, stage: "review" });
    expect(blockingFindings(result)).toEqual([]);
    expect(externalBlockers(result)).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it("accepts a passing MiniMax review verdict", async () => {
    const provider = new OpenRouterProvider("test-key", async () => Response.json({ choices: [{ message: { content: "VERDICT: PASS" } }] }));
    const result = await provider.run({ ...stageInput, stage: "review" });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it.each([[401, "authentication"], [429, "rate limit"], [503, "server"]])("surfaces bounded HTTP %i errors", async (status, category) => {
    const provider = new OpenRouterProvider("private-key", async () => new Response("provider failure", { status }));
    await expect(provider.run(stageInput)).rejects.toThrow(`OpenRouter ${category} error (${status})`);
  });

  it("fails clearly when the host key is missing", async () => {
    const provider = new OpenRouterProvider(undefined, async () => Response.json({}));
    await expect(provider.run(stageInput)).rejects.toThrow("OPENROUTER_API_KEY is not configured");
  });

  it("bounds timeout errors without leaking credential values", async () => {
    const provider = new OpenRouterProvider("private-key", async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")), { once: true });
    }), 1);
    await expect(provider.run(stageInput)).rejects.toThrow("OpenRouter request timed out after 1ms");
  });
});

describe("Codex execution telemetry", () => {
  it("requests structured JSONL events and can set an implementation-only reasoning effort for controlled benchmarks", () => {
    const defaultArgs = codexExecutionArgs("task", "implement");
    expect(defaultArgs).toContain("--json");
    expect(defaultArgs).not.toContain("model_reasoning_effort=low");
    expect(codexExecutionArgs("task", "implement", "low")).toContain("model_reasoning_effort=low");
    expect(codexExecutionArgs("task", "openspec", "low")).not.toContain("model_reasoning_effort=low");
  });

  it("summarizes turns, tool items, token usage, and the final agent message", () => {
    const result = parseCodexTelemetry([
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Implementation complete." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, output_tokens: 30 } }),
    ].join("\n"));
    expect(result.summary).toBe("Implementation complete.");
    expect(result.telemetry).toMatchObject({ turnCount: 1, eventCounts: { "item.completed": 2 }, itemCounts: { command_execution: 1, agent_message: 1 }, usage: { input_tokens: 120, output_tokens: 30 } });
  });
});

describe("deterministic verification gate", () => {
  it("runs a quality-only check before a focused review without invoking a provider", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-quality-only-"));
    try {
      const result = await executeStage({ ...stageInput, runId: "quality-only", stage: "verify", provider: "fake", projectRoot: root, artifactsDir: path.join(root, "artifacts"), verificationOnly: true, qualityCommands: [{ executable: "node", args: ["-e", "process.exit(0)"] }] });
      expect(result.ok).toBe(true);
      expect(result.provider).toBe("quality-gate");
      expect(result.metadata?.verificationOnly).toBe(true);
      expect(result.metadata?.deterministicQuality).toMatchObject({ passed: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("fails before calling the provider when a configured command fails and preserves its output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-quality-gate-"));
    try {
      const result = await executeStage({ ...stageInput, runId: "quality-failure", stage: "verify", projectRoot: root, artifactsDir: path.join(root, "artifacts"), qualityCommands: [{ executable: "node", args: ["-e", "process.stderr.write('expected failure'); process.exit(7)"] }] });
      expect(result.ok).toBe(false);
      expect(result.provider).toBe("quality-gate");
      expect(result.metadata?.passed).toBe(false);
      expect(result.findings.join("\n")).toContain("expected failure");
      const report = JSON.parse(await readFile(result.artifactRefs[0]!, "utf8"));
      expect(report.checks[0].exitCode).toBe(7);
      expect(report.checks[0].stderr).toContain("expected failure");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
describe("plugin policy", () => {
  it("blocks required missing and unhealthy plugins and tolerates optional missing plugins", async () => {
    const registry = new PluginRegistry(); registry.register({ id: "bad", version: "1", capabilities: ["review"], dependencies: [], compatible: () => true, validateConfig: () => true, permissions: ["read"], errorPolicy: { maxAttempts: 1, timeoutMs: 5000 }, required: false, healthCheck: async () => false });
    expect(await registry.check([{ id: "missing", required: false, enabled: true }])).toEqual([]);
    expect(await registry.check([{ id: "missing", required: true, enabled: true }])).toHaveLength(1);
    expect(await registry.check([{ id: "bad", version: "1", required: true, enabled: true }])).toHaveLength(1);
  });
  it("checks stage-scoped capabilities only when their provider stage matches", async () => {
    const registry = new PluginRegistry(); let healthChecks = 0;
    registry.register({ id: "stage-plugin", version: "1", capabilities: [], dependencies: [], compatible: () => true, validateConfig: () => true, permissions: [], errorPolicy: { maxAttempts: 1, timeoutMs: 1000 }, required: false, appliesTo: context => context.stage === "implement" && context.provider === "codex", healthCheck: async () => { healthChecks++; return false; } });
    expect(await registry.check([{ id: "stage-plugin", required: false, enabled: true }], { stage: "review", provider: "openrouter" })).toEqual([]);
    expect(healthChecks).toBe(0);
    expect(await registry.check([{ id: "stage-plugin", required: false, enabled: true }], { stage: "implement", provider: "codex" })).toEqual([]);
    expect(healthChecks).toBe(1);
  });
});
describe("project-scoped RTK integration", () => {
  it("keeps RTK disabled unless the project plugin is explicitly enabled", async () => {
    const status = await resolveRtkStatus({ plugins: [{ id: "rtk", required: false, enabled: false }], stage: "implement", provider: "codex", projectRoot: "." }, async () => { throw new Error("must not invoke RTK"); });
    expect(status).toEqual({ active: false, reason: "disabled-by-project" });
    const manifest = ProjectManifestSchema.parse({ id: "demo-typescript", name: "Demo", root: ".", defaultProfile: "implementation", plugins: [{ id: "rtk", version: "0.1.0", enabled: false, config: { stages: ["implement"] } }] });
    expect(manifest.plugins[0]?.enabled).toBe(false);
  });

  it("activates only when RTK is installed and the project Codex hook is registered", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-rtk-"));
    try {
      await (await import("node:fs/promises")).mkdir(path.join(root, ".codex"));
      await (await import("node:fs/promises")).writeFile(path.join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook codex" }] }] } }));
      const runner = async () => ({ code: 0, stdout: "rtk 0.33.0", stderr: "" });
      const active = await resolveRtkStatus({ plugins: [{ id: "rtk", required: false, enabled: true, config: { stages: ["implement"] } }], stage: "implement", provider: "codex", projectRoot: root }, runner);
      expect(active).toEqual({ active: true, version: "rtk 0.33.0" });
      const wrongStage = await resolveRtkStatus({ plugins: [{ id: "rtk", required: false, enabled: true }], stage: "review", provider: "codex", projectRoot: root }, runner);
      expect(wrongStage.reason).toBe("unsupported-stage-or-provider");
      await expect(resolveRtkStatus({ plugins: [{ id: "rtk", required: true, enabled: true }], stage: "implement", provider: "claude", projectRoot: root }, runner)).rejects.toThrow("RTK requires Codex");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("falls back when RTK is optional and reports a setup error when required", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-rtk-missing-"));
    const common = { stage: "implement" as const, provider: "codex", projectRoot: root };
    try {
      const optional = await resolveRtkStatus({ ...common, plugins: [{ id: "rtk", required: false, enabled: true }] }, async () => ({ code: 0, stdout: "rtk 0.33.0", stderr: "" }));
      expect(optional).toEqual({ active: false, reason: "the project has no valid .codex/hooks.json; install the project-scoped hook with 'rtk init --codex'" });
      await expect(resolveRtkStatus({ ...common, plugins: [{ id: "rtk", required: true, enabled: true }] }, async () => ({ code: 1, stdout: "", stderr: "not found" }))).rejects.toThrow("RTK is required by project");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
describe("workflow failure reporting", () => {
  it("preserves bounded provider error causes for run status", () => {
    const root = new Error("OpenRouter authentication error (401)");
    const wrapped = new Error("Activity task failed", { cause: root });
    expect(failureDetails(wrapped)).toContain("OpenRouter authentication error (401)");
  });
});
describe("fake provider", () => {
  it("produces stable structured results and supports a deterministic review fault", async () => {
    const provider = new FakeProvider(); const base = { runId: "r", taskId: "t", projectId: "p", profile: "implementation", stage: "review" as const, prompt: "[INJECT_REVIEW_FAILURE]", attempt: 1, provider: "fake", projectRoot: ".", artifactsDir: ".", plugins: [] };
    const a = await provider.run(base); const b = await provider.run(base); expect(a).toEqual(b); expect(a.ok).toBe(false);
    expect(StageOutputSchema.safeParse(a).success).toBe(true);
    expect(StageOutputSchema.safeParse({ ...a, durationMs: -1 }).success).toBe(false);
  });
});
