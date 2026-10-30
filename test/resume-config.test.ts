import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectManifestSchema, type RunInput } from "../src/contracts.js";
import { loadManifest, refreshConfig, refreshedInput, savedStages } from "../src/resume-config.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const temp = async (prefix: string) => { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };

const manifest = (overrides: Record<string, unknown> = {}) => ProjectManifestSchema.parse({
  id: "81f81b2c-fcff-4fc8-8650-568cd059e4f5", aliases: ["signal-zero"], name: "Signal Zero", root: "p", defaultProfile: "implementation",
  providers: { default: "codex" }, providerRouting: { plan: { provider: "codex" }, implement: { provider: "codex" }, review: { provider: "codex" }, verify: { provider: "codex" } },
  providerTimeouts: { implement: 7_200_000, review: 1_800_000 }, ...overrides,
});
// The input of the failed LOC-92 run: review was routed to a free OpenRouter model.
const failedInput = (artifactsDir: string): RunInput => ({
  runId: "aa0a0bbe", taskId: "9bb432c0", projectId: "81f81b2c-fcff-4fc8-8650-568cd059e4f5", profile: "implementation", prompt: "Add input abstraction and save format", projectRoot: "p", artifactsDir,
  provider: "codex", providerTimeouts: { implement: 7_200_000, review: 1_800_000 },
  providerRouting: { plan: { provider: "codex" }, implement: { provider: "codex" }, review: { provider: "openrouter", model: "nvidia/nemotron-3.5-super-vl:free" }, verify: { provider: "codex" } },
} as RunInput);

describe("refreshConfig", () => {
  it("moves a stage that has not finished to the route the manifest has now (the LOC-92 case) and says so", () => {
    const { input, changes } = refreshConfig(failedInput("a"), manifest(), new Set(["plan", "implement"]));
    expect(input.providerRouting!.review).toEqual({ provider: "codex" });
    expect(changes).toEqual(["review: openrouter:nvidia/nemotron-3.5-super-vl:free -> codex"]);
  });
  it("keeps the route of a stage that already has a saved result, even when the manifest changed it, so finished work is reused and not redone", () => {
    const changed = manifest({ providerRouting: { plan: { provider: "claude" }, implement: { provider: "claude" }, review: { provider: "codex" }, verify: { provider: "codex" } } });
    const { input, changes } = refreshConfig(failedInput("a"), changed, new Set(["plan", "implement"]));
    expect(input.providerRouting!.plan).toEqual({ provider: "codex" });
    expect(input.providerRouting!.implement).toEqual({ provider: "codex" });
    expect(changes.some(change => change.startsWith("plan") || change.startsWith("implement"))).toBe(false);
  });
  it("takes a new model, reasoning effort, default provider, timeouts and budget from the manifest, and drops a route the manifest no longer has", () => {
    const changed = manifest({ providers: { default: "claude" }, providerRouting: { review: { provider: "codex", model: "gpt-x", reasoningEffort: "high" } }, providerTimeouts: { review: 900_000 }, budget: { maxCostUnits: 3_000_000 } });
    const { input, changes } = refreshConfig(failedInput("a"), changed, new Set());
    expect(input.providerRouting!.review).toEqual({ provider: "codex", model: "gpt-x", reasoningEffort: "high" });
    expect(input.providerRouting!.plan).toBeUndefined();
    expect(input.provider).toBe("claude");
    expect(input.providerTimeouts).toEqual({ review: 900_000 });
    expect(input.budget).toEqual({ maxCostUnits: 3_000_000, warnAt: 0.8 });
    expect(changes).toEqual(expect.arrayContaining(["review: openrouter:nvidia/nemotron-3.5-super-vl:free -> codex:gpt-x (high)", "plan: codex -> the default", "default provider: codex -> claude", "stage timeouts updated from the manifest", "token budget updated from the manifest"]));
  });
  it("leaves everything that identifies or defines the task as it started", () => {
    const { input } = refreshConfig(failedInput("a"), manifest(), new Set());
    expect(input).toMatchObject({ runId: "aa0a0bbe", taskId: "9bb432c0", projectId: "81f81b2c-fcff-4fc8-8650-568cd059e4f5", prompt: "Add input abstraction and save format", projectRoot: "p", profile: "implementation" });
  });
  it("reports nothing when the manifest and the run agree", () => {
    const same = failedInput("a"); same.providerRouting = { plan: { provider: "codex" }, implement: { provider: "codex" }, review: { provider: "codex" }, verify: { provider: "codex" } };
    expect(refreshConfig(same, manifest(), new Set()).changes).toEqual([]);
  });
});

describe("savedStages", () => {
  it("lists the stages with a successful saved result, not failures, not other files, not unreadable ones", async () => {
    const dir = await temp("orch-saved-"); const run = path.join(dir, "r1"); await mkdir(run);
    await writeFile(path.join(run, "plan-1.json"), JSON.stringify({ ok: true }));
    await writeFile(path.join(run, "implement-1.json"), JSON.stringify({ ok: true }));
    await writeFile(path.join(run, "implement-2.json"), JSON.stringify({ ok: false }));
    await writeFile(path.join(run, "review-1.json"), JSON.stringify({ ok: false }));
    await writeFile(path.join(run, "review-1-activity-2-failure.json"), JSON.stringify({ ok: true }));
    await writeFile(path.join(run, "quality-1.json"), JSON.stringify({ passed: true }));
    await writeFile(path.join(run, "brief-1.json"), "{ broken");
    expect([...await savedStages({ artifactsDir: dir, runId: "r1" })].sort()).toEqual(["implement", "plan"]);
    expect((await savedStages({ artifactsDir: dir, runId: "missing" })).size).toBe(0);
  });
});

describe("loadManifest and refreshedInput", () => {
  async function projectsFolder() {
    const dir = await temp("orch-projects-"); await mkdir(path.join(dir, "generated"));
    await writeFile(path.join(dir, "generated", "81f81b2c.json"), JSON.stringify(manifest()));
    await writeFile(path.join(dir, "broken.json"), "{ not json");
    await writeFile(path.join(dir, "notes.txt"), "x");
    return dir;
  }
  it("finds a generated manifest by id or alias, skipping files that are not valid manifests", async () => {
    const dir = await projectsFolder(); const env = { ORCHESTRATOR_PROJECTS_DIR: dir, ORCHESTRATOR_PROJECT_FILE: path.join(dir, "none.json") };
    expect((await loadManifest("81f81b2c-fcff-4fc8-8650-568cd059e4f5", env))?.name).toBe("Signal Zero");
    expect((await loadManifest("signal-zero", env))?.id).toBe("81f81b2c-fcff-4fc8-8650-568cd059e4f5");
    expect(await loadManifest("unknown-project", env)).toBeUndefined();
  });
  it("refreshes a failed run end to end from its folder, and leaves the input alone when the project has no manifest here", async () => {
    const dir = await projectsFolder(); const artifacts = await temp("orch-art-"); const run = path.join(artifacts, "aa0a0bbe"); await mkdir(run);
    await writeFile(path.join(run, "plan-1.json"), JSON.stringify({ ok: true })); await writeFile(path.join(run, "implement-1.json"), JSON.stringify({ ok: true }));
    const env = { ORCHESTRATOR_PROJECTS_DIR: dir, ORCHESTRATOR_PROJECT_FILE: path.join(dir, "none.json") };
    const result = await refreshedInput(failedInput(artifacts), env);
    expect(result.input.providerRouting!.review).toEqual({ provider: "codex" });
    expect(result.changes).toEqual(["review: openrouter:nvidia/nemotron-3.5-super-vl:free -> codex"]);
    const orphan = { ...failedInput(artifacts), projectId: "someone-elses" };
    expect(await refreshedInput(orphan, env)).toEqual({ input: orphan, changes: [] });
  });
});
