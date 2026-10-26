import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeRunSettings, pluginsToDisable, settingSources } from "../src/claude-settings.js";
import { claudeExecutionArgs, claudeSettingsFor } from "../src/providers.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(user: object | undefined, project: object | undefined = undefined, local: object | undefined = undefined) {
  const home = await mkdtemp(path.join(os.tmpdir(), "orch-home-")); const repo = await mkdtemp(path.join(os.tmpdir(), "orch-repo-")); dirs.push(home, repo);
  if (user) { await mkdir(path.join(home, ".claude")); await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify(user)); }
  if (project || local) await mkdir(path.join(repo, ".claude"));
  if (project) await writeFile(path.join(repo, ".claude", "settings.json"), JSON.stringify(project));
  if (local) await writeFile(path.join(repo, ".claude", "settings.local.json"), JSON.stringify(local));
  return { home, repo };
}

describe("pluginsToDisable", () => {
  it("lists the plugins the operator enabled, and not the ones already off", async () => {
    const { home, repo } = await setup({ model: "sonnet", enabledPlugins: { "ecc@ecc": true, "other@market": true, "old@market": false } });
    expect(pluginsToDisable(repo, home, {}).sort()).toEqual(["ecc@ecc", "other@market"]);
  });
  it("leaves alone a plugin the project itself enables (project or local settings)", async () => {
    const { home, repo } = await setup({ enabledPlugins: { "ecc@ecc": true, "team@market": true, "mine@market": true } }, { enabledPlugins: { "team@market": true } }, { enabledPlugins: { "mine@market": true } });
    expect(pluginsToDisable(repo, home, {})).toEqual(["ecc@ecc"]);
  });
  it("returns nothing without user settings, with unreadable settings, or when the operator keeps their plugins", async () => {
    expect(pluginsToDisable(undefined, path.join(os.tmpdir(), "orch-no-such-home"), {})).toEqual([]);
    const broken = await mkdtemp(path.join(os.tmpdir(), "orch-home-")); dirs.push(broken);
    await mkdir(path.join(broken, ".claude")); await writeFile(path.join(broken, ".claude", "settings.json"), "{ not json");
    expect(pluginsToDisable(undefined, broken, {})).toEqual([]);
    const { home, repo } = await setup({ enabledPlugins: { "ecc@ecc": true } });
    expect(pluginsToDisable(repo, home, { ORCHESTRATOR_CLAUDE_USER_PLUGINS: "1" })).toEqual([]);
  });
});

describe("claudeRunSettings", () => {
  it("switches the listed plugins off and registers the hook, in one settings object", () => {
    const settings = JSON.parse(claudeRunSettings({ disablePlugins: ["ecc@ecc"], hookScript: "/x/hook.js", nodePath: "/usr/bin/node" })!) as { enabledPlugins: Record<string, boolean>; hooks: { PreToolUse: Array<{ matcher: string }> } };
    expect(settings.enabledPlugins).toEqual({ "ecc@ecc": false });
    expect(settings.hooks.PreToolUse[0]!.matcher).toBe("Bash|PowerShell");
  });
  it("carries only what was asked for, and is undefined when there is nothing to set", () => {
    expect(Object.keys(JSON.parse(claudeRunSettings({ disablePlugins: ["a@b"] })!))).toEqual(["enabledPlugins"]);
    expect(Object.keys(JSON.parse(claudeRunSettings({ hookScript: "/x/hook.js" })!))).toEqual(["hooks"]);
    expect(claudeRunSettings({})).toBeUndefined();
    expect(claudeRunSettings({ disablePlugins: [] })).toBeUndefined();
  });
});

describe("settingSources", () => {
  it("accepts the three valid sources only", () => {
    expect(settingSources({ ORCHESTRATOR_CLAUDE_SETTING_SOURCES: "project, local" })).toBe("project,local");
    expect(settingSources({ ORCHESTRATOR_CLAUDE_SETTING_SOURCES: "user,project,local" })).toBe("user,project,local");
    expect(settingSources({ ORCHESTRATOR_CLAUDE_SETTING_SOURCES: "project,global" })).toBeUndefined();
    expect(settingSources({})).toBeUndefined();
    expect(claudeExecutionArgs("go", "implement", { ORCHESTRATOR_CLAUDE_SETTING_SOURCES: "project,local" }).join(" ")).toContain("--setting-sources project,local");
    expect(claudeExecutionArgs("go", "implement", {}).join(" ")).not.toContain("--setting-sources");
  });
});

describe("claudeSettingsFor", () => {
  it("turns the operator's plugins off for every stage and adds the hook only when asked and built", async () => {
    const { home, repo } = await setup({ enabledPlugins: { "ecc@ecc": true } });
    const env = { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv;
    // The user home is os.homedir(); the plugin list is read from the real home in production, so the logic is covered above with an explicit home.
    expect(pluginsToDisable(repo, home, env)).toEqual(["ecc@ecc"]);
    const withHook = claudeSettingsFor(repo, true, { ...env, ORCHESTRATOR_CLAUDE_USER_PLUGINS: "1" });
    const withoutHook = claudeSettingsFor(repo, false, { ...env, ORCHESTRATOR_CLAUDE_USER_PLUGINS: "1" });
    expect(withoutHook).toEqual({});
    if (withHook.settings) expect(JSON.parse(withHook.settings)).not.toHaveProperty("enabledPlugins");
    expect(claudeSettingsFor(repo, true, { ORCHESTRATOR_RTK_HOOK: "0", ORCHESTRATOR_CLAUDE_USER_PLUGINS: "1" })).toEqual({});
  });
});
