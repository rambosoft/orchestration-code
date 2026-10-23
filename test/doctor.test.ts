import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatDoctor, manifestProviders, parseNodeVersion, pluginProblem, runDoctor, type DoctorDeps } from "../src/doctor.js";

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    run: async (command, args) => {
      if (command === "claude") return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
      if (args.includes("login")) return "Logged in using ChatGPT";
      return "ok";
    },
    env: { ORCHESTRATOR_API_TOKEN: "t", ORCHESTRATOR_DATA_DIR: path.join(os.tmpdir(), "orch-doctor-none") },
    fetchJson: async () => ({ ok: true, projects: ["a", "b"] }),
    pollersOnTaskQueue: async () => 1,
    listDir: async () => [],
    buildStaleness: async () => undefined,
    readManifestProviders: async () => new Map([["codex", ["dino"]], ["claude", ["dino"]], ["fake", ["x"]]]),
    ...overrides,
  };
}
const failures = (checks: Awaited<ReturnType<typeof runDoctor>>) => checks.filter(check => !check.ok && check.severity === "error").map(check => check.name);

describe("doctor", () => {
  it("passes on a healthy setup and ignores the fake provider", async () => {
    const checks = await runDoctor(deps());
    expect(failures(checks)).toEqual([]);
    expect(checks.some(check => check.name === "provider:fake")).toBe(false);
    expect(formatDoctor(checks)).toContain("PASS");
  });
  it("names a logged-out claude, a dead worker and an unreachable bridge", async () => {
    const checks = await runDoctor(deps({
      run: async (command) => command === "claude" ? JSON.stringify({ loggedIn: false }) : "Logged in using ChatGPT",
      pollersOnTaskQueue: async () => 0,
      fetchJson: async () => { throw new Error("ECONNREFUSED"); },
    }));
    expect(failures(checks)).toEqual(expect.arrayContaining(["provider:claude", "worker", "bridge"]));
    expect(formatDoctor(checks)).toContain('claude auth login');
  });
  it("reports a missing OpenRouter key, bad config values and an unqueryable Temporal", async () => {
    const checks = await runDoctor(deps({
      env: { ORCHESTRATOR_API_TOKEN: "t", ORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY: "zero", TEMPORAL_ADDRESS: "nonsense" },
      readManifestProviders: async () => new Map([["openrouter", ["p"]]]),
      pollersOnTaskQueue: async () => { throw new Error("unavailable"); },
    }));
    expect(failures(checks)).toEqual(expect.arrayContaining(["config:concurrency", "config:temporal-address", "provider:openrouter", "temporal"]));
  });
  it("warns, but does not fail, about many leftover worktrees or a missing token", async () => {
    const checks = await runDoctor(deps({ env: {}, listDir: async () => Array.from({ length: 25 }, (_, i) => `w${i}`) }));
    expect(failures(checks)).toEqual([]);
    expect(checks.filter(check => !check.ok).map(check => check.name)).toEqual(expect.arrayContaining(["bridge", "worktrees"]));
  });
  it("parses node versions", () => { expect(parseNodeVersion("v22.22.2")).toEqual([22, 22]); });
});

describe("manifestProviders", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  it("collects providers per project from manifest files and skips invalid ones", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orch-doctor-")); dirs.push(dir);
    await writeFile(path.join(dir, "ok.json"), JSON.stringify({ id: "dino", name: "Dino", root: "dino", defaultProfile: "implementation", providers: { default: "codex" }, providerRouting: { implement: { provider: "claude" } } }));
    await writeFile(path.join(dir, "bad.json"), "{ not json");
    const used = await manifestProviders([dir]);
    expect([...used.keys()].sort()).toEqual(["claude", "codex"]);
    expect(used.get("claude")).toEqual(["dino"]);
  });
});

describe("codex login detection", () => {
  it("treats a silent successful check as logged in and a failing one as not logged in", async () => {
    const base = (login: () => Promise<string>) => deps({ run: async (command, args) => command === "claude" ? JSON.stringify({ loggedIn: true }) : args.includes("login") ? login() : "ok" });
    expect(failures(await runDoctor(base(async () => "")))).toEqual([]);
    expect(failures(await runDoctor(base(async () => { throw new Error("Not logged in"); })))).toEqual(["provider:codex"]);
  });
});

describe("build staleness", () => {
  it("warns (not fails) when the compiled worker is older than the sources", async () => {
    const checks = await runDoctor(deps({ buildStaleness: async () => "src is newer than dist" }));
    expect(checks.find(check => check.name === "build")).toMatchObject({ ok: false, severity: "warn" });
    expect(failures(checks)).toEqual([]);
  });
});

describe("running workflows", () => {
  it("warns (does not fail) when workflows are running, so a restart is not done blindly", async () => {
    const checks = await runDoctor(deps({ fetchJson: async (url) => url.endsWith("/health") ? { ok: true, projects: ["a"] } : [{ workflowId: "pc-abc", status: "RUNNING" }, { workflowId: "pc-old", status: "COMPLETED" }] }));
    const check = checks.find(item => item.name === "running-workflows")!;
    expect(check).toMatchObject({ ok: false, severity: "warn" });
    expect(check.detail).toContain("1 workflow(s) running");
    expect(failures(checks)).toEqual([]);
  });
  it("reports none when nothing is running", async () => {
    const checks = await runDoctor(deps({ fetchJson: async (url) => url.endsWith("/health") ? { ok: true, projects: [] } : [] }));
    expect(checks.find(item => item.name === "running-workflows")?.ok).toBe(true);
  });

  it("warns, not fails, when a project enables screenshot review but no browser is installed", async () => {
    const missing = await runDoctor(deps({ visualProjects: async () => ["dino"], findBrowser: () => undefined }));
    const check = missing.find(item => item.name === "visual:browser");
    expect(check).toMatchObject({ ok: false, severity: "warn" });
    expect(failures(missing)).toEqual([]);
    const present = await runDoctor(deps({ visualProjects: async () => ["dino"], findBrowser: () => "C:\chrome.exe" }));
    expect(present.find(item => item.name === "visual:browser")?.ok).toBe(true);
  });
  it("does not check for a browser when no project uses screenshots", async () => {
    const checks = await runDoctor(deps({ visualProjects: async () => [], findBrowser: () => undefined }));
    expect(checks.some(item => item.name === "visual:browser")).toBe(false);
  });
});

describe("project bootstrap plugin", () => {
  it("accepts a built plugin whose SDK pin matches the Paperclip checkout, with or without the tag's v", () => {
    expect(pluginProblem({ built: true, sdkPin: "2026.916.1", hostVersion: "v2026.916.1" })).toBeUndefined();
    expect(pluginProblem({ built: true, sdkPin: "2026.916.1" })).toBeUndefined();
  });
  it("names the fix for an unbuilt plugin and for an SDK pin that no longer matches Paperclip", () => {
    expect(pluginProblem({ built: false })).toContain("npm run plugin:build");
    expect(pluginProblem({ built: true, sdkPin: "2026.916.1", hostVersion: "v2026.1001.0" })).toContain("update the pin");
  });
  it("is reported only when the plugin folder exists, as a warning that never blocks a run", async () => {
    expect((await runDoctor(deps())).some(item => item.name.startsWith("plugin:"))).toBe(false);
    const stale = await runDoctor(deps({ env: { ORCHESTRATOR_API_TOKEN: "t" }, pluginStatus: async () => ({ built: true, sdkPin: "1", hostVersion: "v2" }) }));
    expect(stale.find(item => item.name === "plugin:project-bootstrap")).toMatchObject({ ok: false, severity: "warn" });
    expect(stale.find(item => item.name === "bootstrap:worker-env")).toMatchObject({ ok: false, severity: "warn" });
    expect(failures(stale)).toEqual([]);
    const healthy = await runDoctor(deps({ env: { ORCHESTRATOR_API_TOKEN: "t", ORCHESTRATOR_PROJECTS_ROOT: "C:\p", PAPERCLIP_API_TOKEN: "x" }, pluginStatus: async () => ({ built: true, sdkPin: "2", hostVersion: "v2" }) }));
    expect(healthy.find(item => item.name === "plugin:project-bootstrap")?.ok).toBe(true);
    expect(healthy.find(item => item.name === "bootstrap:worker-env")?.ok).toBe(true);
  });
});
