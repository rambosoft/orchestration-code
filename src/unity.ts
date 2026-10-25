import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { VisualConfig } from "./contracts.js";
import { childEnv } from "./env.js";
import { killOnAbort, toolCommand } from "./process-control.js";

// Unity gates (docs/engineering/research/unity-game-support.md): the Unity CLI's exit code is not trusted on its own. A test run needs a result file with tests in it,
// a build with a declared output needs that output, and every command has a timeout so a hung Editor cannot hold the worker.

type CheckLike = { executable: string; args: string[]; cwd?: string };
export type UnityRun = { code: number | null; output: string; stderr: string };

const DEFAULT_TIMEOUT_SECONDS: Record<string, number> = { test: 900, build: 1500, recompile: 300 };

/** The check's arguments with a timeout and non-interactive mode added when the manifest did not set them. */
export function withUnityDefaults(args: string[]): string[] {
  const verb = args[0] ?? "";
  const next = [...args];
  if (!next.some(arg => arg === "--timeout" || arg.startsWith("--timeout="))) next.push("--timeout", String(DEFAULT_TIMEOUT_SECONDS[verb] ?? 900));
  if (!next.includes("--non-interactive")) next.push("--non-interactive");
  return next;
}

function optionValue(args: string[], names: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    for (const name of names) {
      if (arg === name) return args[index + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

/** Where `unity test` writes its NUnit report, relative to the check's working directory. */
export function unityTestResultPath(check: CheckLike, cwd: string): string | undefined {
  if (check.executable !== "unity" || check.args[0] !== "test") return undefined;
  return path.resolve(cwd, optionValue(check.args, ["--output"]) ?? "test-results.xml");
}

function unityBuildOutputPath(check: CheckLike, cwd: string): string | undefined {
  if (check.executable !== "unity" || check.args[0] !== "build") return undefined;
  const value = optionValue(check.args, ["-o", "--output-path"]);
  return value ? path.resolve(cwd, value) : undefined;
}

/** Removes a stale report or artifact so an old result can never satisfy the gate. */
export async function clearUnityEvidence(check: CheckLike, cwd: string): Promise<void> {
  for (const file of [unityTestResultPath(check, cwd), unityBuildOutputPath(check, cwd)]) if (file) await rm(file, { recursive: true, force: true });
}

function attr(tag: string, name: string): number | undefined {
  const match = new RegExp(`\\b${name}="(\\d+)"`).exec(tag);
  return match ? Number(match[1]) : undefined;
}

/** What the NUnit report says: undefined when it is a clean run with tests, otherwise the problem. */
export function nunitProblem(xml: string): string | undefined {
  const tag = /<test-run\b[^>]*>/.exec(xml)?.[0];
  if (!tag) return "the test report has no <test-run> element";
  const total = attr(tag, "total"); const failed = attr(tag, "failed") ?? 0; const passed = attr(tag, "passed") ?? 0;
  if (total === undefined) return "the test report has no test count";
  if (total === 0) return "the test run executed 0 tests (a filter or assembly setup problem); an empty run is not a pass";
  if (failed > 0) return `${failed} of ${total} tests failed`;
  if (passed === 0) return `no test passed (${total} total)`;
  return undefined;
}

/** The problem with a finished Unity check, or undefined when the evidence supports a pass. Non-Unity checks are not examined. */
export async function unityEvidenceProblem(check: CheckLike, cwd: string, exitCode: number | null): Promise<string | undefined> {
  if (check.executable !== "unity") return undefined;
  if (exitCode !== 0) return undefined;
  const report = unityTestResultPath(check, cwd);
  if (report) {
    let xml: string;
    try { xml = await readFile(report, "utf8"); } catch { return `unity test exited 0 but wrote no report at ${path.relative(cwd, report) || report}`; }
    const problem = nunitProblem(xml);
    return problem ? `unity test report: ${problem}` : undefined;
  }
  const built = unityBuildOutputPath(check, cwd);
  if (built) {
    try { const info = await stat(built); if (info.isFile() ? info.size === 0 : (await readdir(built)).length === 0) return `unity build exited 0 but ${path.relative(cwd, built) || built} is empty`; } catch { return `unity build exited 0 but produced no output at ${path.relative(cwd, built) || built}`; }
  }
  return undefined;
}

/** A hint appended to a failed Unity check so the repair prompt says what the exit code means. */
export function unityExitHint(check: CheckLike, code: number | null): string {
  if (check.executable !== "unity") return "";
  if (code === 8) return "Unity: the run completed and tests failed.";
  if (code === 6) return "Unity: no verdict (compile error, licence problem, crash or timeout). Read the compiler lines (CS####) first.";
  if (code === 2) return "Unity: the command line was wrong (usage error).";
  return "";
}

export function runUnity(args: string[], cwd: string, signal: AbortSignal | undefined, maxChars = 3000): Promise<UnityRun> {
  return new Promise((resolve, reject) => {
    const { command, args: commandArgs } = toolCommand("unity", args);
    const child = spawn(command, commandArgs, { cwd, shell: false, windowsHide: true, env: childEnv() }); const stopKill = killOnAbort(child, signal);
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outBytes = 0; let errBytes = 0;
    child.stdout.on("data", (b: Buffer) => { if (outBytes < 100_000) { stdout.push(b); outBytes += b.length; } });
    child.stderr.on("data", (b: Buffer) => { if (errBytes < 100_000) { stderr.push(b); errBytes += b.length; } });
    child.on("error", error => { stopKill(); reject(error); });
    child.on("close", code => { stopKill(); if (signal?.aborted) return reject(new Error("cancelled: process killed")); resolve({ code, output: Buffer.concat(stdout).toString("utf8").slice(-maxChars), stderr: Buffer.concat(stderr).toString("utf8").slice(-maxChars) }); });
  });
}

export const UNITY_SHOT_DIR = path.join("Logs", "screenshots");
export type UnityCaptureDeps = { run?: (args: string[], cwd: string, signal: AbortSignal | undefined) => Promise<UnityRun>; stopEditors?: (projectRoot: string) => Promise<number[]>; waitUnlock?: (projectRoot: string) => Promise<number> };

/**
 * Screenshot evidence for a Unity project: runs the project's capture test (a PlayMode test that renders a camera to a RenderTexture and writes PNGs to Logs/screenshots)
 * and copies the images next to the other review evidence. Every problem is a warning, like the web capture.
 */
export async function captureUnityScreenshots(config: VisualConfig, options: { cwd: string; outDir: string; signal?: AbortSignal }, deps: UnityCaptureDeps = {}): Promise<{ images: string[]; warnings: string[] }> {
  const images: string[] = []; const warnings: string[] = [];
  const shotDir = path.join(options.cwd, UNITY_SHOT_DIR);
  try {
    if (!config.unityFilter) return { images, warnings: ["unity capture skipped: visual.unityFilter is not set"] };
    await mkdir(options.outDir, { recursive: true });
    await rm(shotDir, { recursive: true, force: true });
    const stopped = await (deps.stopEditors ?? stopProjectEditors)(options.cwd);
    const waited = await (deps.waitUnlock ?? waitForProjectUnlock)(options.cwd);
    if (waited >= 5000) warnings.push(`waited ${Math.round(waited / 1000)}s for the previous Unity process to release the project`);
    if (stopped.length) warnings.push(`stopped ${stopped.length} Unity process(es) that still had the project open before the capture`);
    const report = path.join(options.outDir, "unity-capture-results.xml");
    const result = await (deps.run ?? runUnity)(["test", "--mode", "PlayMode", "--filter", config.unityFilter, "--output", report, "--timeout", String(Math.max(600, Math.round(config.readyTimeoutMs / 1000))), "--non-interactive", "--no-banner"], options.cwd, options.signal);
    if (result.code !== 0) warnings.push(`unity capture run ended with exit ${result.code ?? "unknown"}${result.stderr || result.output ? `: ${(result.stderr || result.output).replace(/\s+/g, " ").slice(-300)}` : ""}`);
    const files = (await readdir(shotDir).catch(() => [] as string[])).filter(name => /\.png$/i.test(name)).sort();
    for (const name of files) {
      if (images.length >= config.maxImages) { warnings.push(`screenshot limit of ${config.maxImages} reached; later shots skipped`); break; }
      const target = path.join(options.outDir, `unity-${name}`);
      await copyFile(path.join(shotDir, name), target); images.push(target);
    }
    if (!images.length && !warnings.length) warnings.push(`unity capture produced no screenshots in ${UNITY_SHOT_DIR}`);
  } catch (error) {
    warnings.push(`unity capture failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  return { images, warnings };
}

export type UnityAgentContext = { /** The pinned checkout of Unity's official agent plugin (UNITY_AGENT_PLUGIN_DIR), passed to Claude with --plugin-dir. */ pluginDir?: string };
/** Defined for a Unity project (it has ProjectSettings/ProjectVersion.txt): the agent may run the Unity CLI and gets Unity's official skills when a plugin checkout is configured. */
export function unityAgentContext(projectRoot: string | undefined, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): UnityAgentContext | undefined {
  if (!projectRoot || !exists(path.join(projectRoot, "ProjectSettings", "ProjectVersion.txt"))) return undefined;
  const dir = env.UNITY_AGENT_PLUGIN_DIR;
  return dir && exists(dir) ? { pluginDir: dir } : {};
}

// A Unity project can only be open in one Editor. Agents driving a live Editor (the unity-cli skill does) can leave it running on the worktree, and then every gate
// and the screenshot capture fail with "instances cannot open the same project" (found in the first live game run). Before the gates run, the Editors of this worktree are stopped.
export type ProcessInfo = { pid: number; commandLine: string };
const normalizePath = (value: string): string => value.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
/** Unity Editor processes (and their import workers) whose command line opens exactly this project. */
export function editorPidsFor(processes: ProcessInfo[], projectRoot: string): number[] {
  const root = normalizePath(path.resolve(projectRoot));
  // The command line names the project in several spellings (-projectPath C:\w\x, "C:/w/x/", a path inside it); a hit needs a path boundary after the root so a sibling like x-copy is never touched.
  const names = (line: string): boolean => {
    for (let from = line.indexOf(root); from >= 0; from = line.indexOf(root, from + 1)) {
      const next = line[from + root.length];
      if (next === undefined || next === "\"" || next === " " || next === "/" || next === "'") return true;
    }
    return false;
  };
  return processes.filter(item => names(normalizePath(item.commandLine))).map(item => item.pid);
}
export type EditorProcessDeps = { list?: () => Promise<ProcessInfo[]>; kill?: (pid: number) => void };
export async function listEditorProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== "win32") return [];
  const result = await new Promise<string>(resolve => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"name = 'Unity.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { windowsHide: true });
    const chunks: Buffer[] = []; child.stdout.on("data", (b: Buffer) => chunks.push(b)); child.on("error", () => resolve("")); child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  try { const parsed = JSON.parse(result) as { ProcessId: number; CommandLine: string | null } | Array<{ ProcessId: number; CommandLine: string | null }>; return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({ pid: item.ProcessId, commandLine: item.CommandLine ?? "" })); } catch { return []; }
}
function killTree(pid: number): void { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
/** Stops the Editors that have this project open and returns their process ids. Never throws: a failure here must not hide the real gate result. */
export async function stopProjectEditors(projectRoot: string, deps: EditorProcessDeps = {}): Promise<number[]> {
  try {
    const pids = editorPidsFor(await (deps.list ?? listEditorProcesses)(), projectRoot);
    for (const pid of pids) (deps.kill ?? killTree)(pid);
    if (pids.length) await new Promise(resolve => setTimeout(resolve, 3000));
    return pids;
  } catch { return []; }
}

/** Source of every C# test file of the project (Assets/Tests), for the acceptance trace. */
export async function readUnityTestSources(projectRoot: string): Promise<string[]> {
  const texts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else if (entry.name.endsWith(".cs")) texts.push(await readFile(full, "utf8"));
    }
  };
  await walk(path.join(projectRoot, "Assets", "Tests"));
  return texts;
}

// The Unity CLI can return a moment before its Editor has exited and released Temp/UnityLockfile, and the next command then fails with "instances cannot open the same project"
// (the capture of the first review round failed this way in two live tasks while no stray process existed). Before each Unity command the lock is waited for.
export type LockDeps = { probe?: (lockfile: string) => Promise<boolean>; sleep?: (ms: number) => Promise<void>; now?: () => number };
async function lockIsFree(lockfile: string): Promise<boolean> {
  try { const handle = await open(lockfile, "r+"); await handle.close(); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
/** Waits until nobody holds the project's lockfile, at most `timeoutMs`; returns the milliseconds waited. Never throws and never blocks longer than the timeout. */
export async function waitForProjectUnlock(projectRoot: string, timeoutMs = 90_000, deps: LockDeps = {}): Promise<number> {
  const probe = deps.probe ?? lockIsFree; const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))); const now = deps.now ?? Date.now;
  const lockfile = path.join(projectRoot, "Temp", "UnityLockfile");
  const started = now();
  while (now() - started < timeoutMs) {
    if (await probe(lockfile).catch(() => true)) return now() - started;
    await sleep(2000);
  }
  return now() - started;
}

// Editor-log lines that are facts about this machine, not about the project. The Editor cannot verify the signature of the Hub's licensing client ("Code 10", Windows ERROR_BAD_ENVIRONMENT) and says
// "ignoring": the licence still works and every build and test succeeds. The Unity CLI repeats such lines under "The build succeeded, but the Editor log reported the following errors", which cluttered the
// output of every gate (and could send an agent off to "fix" licensing). They are removed from check output; `doctor` reports the condition once.
const BENIGN_EDITOR_LOG = [/LicensingClient has failed validation; ignoring/, /Access token is unavailable; failed to update/, /Code 10 while verifying Licensing Client signature/];
const EDITOR_LOG_HEADER = /^The [\w ]+ (?:succeeded|completed|passed)?,? ?but the Editor log reported the following errors:\s*$/i;
/** The output without benign Editor-log lines; the "reported the following errors" header goes with them when nothing real is left under it. */
export function stripBenignEditorNoise(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (EDITOR_LOG_HEADER.test(line.trim())) {
      let end = index + 1;
      const items: string[] = [];
      while (end < lines.length && /^\s+\S/.test(lines[end]!)) items.push(lines[end++]!);
      const real = items.filter(item => !BENIGN_EDITOR_LOG.some(pattern => pattern.test(item)));
      if (real.length) out.push(line, ...real);
      index = end - 1;
      continue;
    }
    if (!BENIGN_EDITOR_LOG.some(pattern => pattern.test(line))) out.push(line);
  }
  return out.join("\n");
}
