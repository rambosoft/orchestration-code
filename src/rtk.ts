import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginRequirement, StageName } from "./contracts.js";

export type RtkStatus = { active: boolean; version?: string; reason?: string };
type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

const runCommand: CommandRunner = (command, args, cwd) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const timer = setTimeout(() => child.kill(), 5_000);
  child.stdout.on("data", (chunk: Buffer) => { if (Buffer.concat(stdout).length < 4_000) stdout.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { if (Buffer.concat(stderr).length < 4_000) stderr.push(chunk); });
  child.on("error", (error) => {
    clearTimeout(timer);
    resolve({ code: null, stdout: "", stderr: error.message });
  });
  child.on("close", code => {
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(stdout).toString("utf8").trim(), stderr: Buffer.concat(stderr).toString("utf8").trim() });
  });
});

export async function isRtkInstalled(): Promise<boolean> {
  return (await runCommand("rtk", ["--version"], process.cwd())).code === 0;
}

function requirementForStage(plugins: PluginRequirement[], stage: StageName): PluginRequirement | undefined {
  return plugins.find(plugin => {
    if (plugin.id !== "rtk" || !plugin.enabled) return false;
    const stages = plugin.config?.stages;
    return stages === undefined || (Array.isArray(stages) && stages.includes(stage));
  });
}

export async function resolveRtkStatus(input: {
  plugins: PluginRequirement[];
  stage: StageName;
  provider: string;
  projectRoot: string;
}, runner: CommandRunner = runCommand): Promise<RtkStatus> {
  const requirement = requirementForStage(input.plugins, input.stage);
  if (!requirement) return { active: false, reason: "disabled-by-project" };
  const unavailable = async (reason: string): Promise<RtkStatus> => {
    if (requirement.required) throw new Error(`RTK is required by project '${input.projectRoot}' but ${reason}`);
    return { active: false, reason };
  };
  if (input.stage !== "implement") return { active: false, reason: "unsupported-stage-or-provider" };
  if (input.provider !== "codex") return unavailable(`provider '${input.provider}' is unsupported; RTK requires Codex`);
  const versionResult = await runner("rtk", ["--version"], input.projectRoot);
  if (versionResult.code !== 0) return unavailable("the RTK CLI is not available on the worker PATH");

  let hookConfig: unknown;
  try {
    hookConfig = JSON.parse(await readFile(path.join(input.projectRoot, ".codex", "hooks.json"), "utf8"));
  } catch {
    return unavailable("the project has no valid .codex/hooks.json; install the project-scoped hook with 'rtk init --codex'");
  }
  const root = hookConfig && typeof hookConfig === "object" ? hookConfig as { hooks?: { PreToolUse?: unknown } } : undefined;
  const preToolUse = Array.isArray(root?.hooks?.PreToolUse) ? root.hooks.PreToolUse : [];
  const hasRtkBashHook = preToolUse.some(group => {
    if (!group || typeof group !== "object") return false;
    const entry = group as { matcher?: unknown; hooks?: unknown };
    if (entry.matcher !== "Bash" || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(hook => {
      if (!hook || typeof hook !== "object") return false;
      const command = (hook as { command?: unknown }).command;
      return typeof command === "string" && /(?:^|[\\/"' ])rtk(?:\.exe)?\s+hook\s+codex(?:$|["' ])/i.test(command);
    });
  });
  if (!hasRtkBashHook) {
    return unavailable("the project Codex hooks do not register 'rtk hook codex'");
  }
  return { active: true, version: versionResult.stdout || "unknown" };
}
