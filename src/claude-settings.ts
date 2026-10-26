// Per-run settings for the Claude CLI that the orchestrator starts. Two things are decided here and passed with `--settings` (highest priority, this run only; nothing is written to the operator's
// configuration or to the repository):
//  - the operator's own plugins are switched off. A Claude session starts with the skills, agents, hooks and MCP servers of every plugin enabled in the user's settings, and for the first game
//    that was about 15 000 of the 51 000 tokens a bare session starts with, re-read on every turn of every stage. Unattended runs do not need an operator's personal plugins; the Unity agent
//    plugin is passed with --plugin-dir and is not affected, and a plugin the project itself enables stays on.
//  - the RTK hook for build, test and version-control commands (src/rtk-claude-hook.ts), on the stages that run commands.
// ORCHESTRATOR_CLAUDE_USER_PLUGINS=1 keeps the operator's plugins; ORCHESTRATOR_CLAUDE_SETTING_SOURCES=project,local additionally ignores the rest of the user settings (smaller still, but
// the default model then comes from the account, not from the user settings).
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHookSettings } from "./rtk-claude-hook.js";

function enabledPlugins(file: string): Record<string, unknown> {
  try { const parsed = JSON.parse(readFileSync(file, "utf8")) as { enabledPlugins?: unknown }; return parsed.enabledPlugins && typeof parsed.enabledPlugins === "object" ? parsed.enabledPlugins as Record<string, unknown> : {}; }
  catch { return {}; }
}

/** Plugin ids the operator enabled in the user settings and the project does not enable itself: the ones to switch off for an orchestrated run. */
export function pluginsToDisable(projectRoot: string | undefined, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.ORCHESTRATOR_CLAUDE_USER_PLUGINS === "1") return [];
  const user = Object.entries(enabledPlugins(path.join(home, ".claude", "settings.json"))).filter(([, on]) => on !== false).map(([id]) => id);
  if (!projectRoot) return user;
  const project = new Set([...Object.entries(enabledPlugins(path.join(projectRoot, ".claude", "settings.json"))), ...Object.entries(enabledPlugins(path.join(projectRoot, ".claude", "settings.local.json")))].filter(([, on]) => on === true).map(([id]) => id));
  return user.filter(id => !project.has(id));
}

/** The `--settings` JSON for one run, or undefined when there is nothing to set. */
export function claudeRunSettings(options: { disablePlugins?: string[]; hookScript?: string; nodePath?: string }): string | undefined {
  const settings: Record<string, unknown> = {};
  if (options.disablePlugins?.length) settings.enabledPlugins = Object.fromEntries(options.disablePlugins.map(id => [id, false]));
  if (options.hookScript) settings.hooks = (JSON.parse(claudeHookSettings(options.hookScript, options.nodePath)) as { hooks: unknown }).hooks;
  return Object.keys(settings).length ? JSON.stringify(settings) : undefined;
}

/** `--setting-sources` value when the operator asked for it with ORCHESTRATOR_CLAUDE_SETTING_SOURCES (only user, project and local are valid). */
export function settingSources(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.ORCHESTRATOR_CLAUDE_SETTING_SOURCES?.trim();
  return value && value.split(",").every(part => ["user", "project", "local"].includes(part.trim())) ? value.split(",").map(part => part.trim()).join(",") : undefined;
}
