import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
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

function runUnity(args: string[], cwd: string, signal: AbortSignal | undefined, maxChars = 3000): Promise<UnityRun> {
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
export type UnityCaptureDeps = { run?: (args: string[], cwd: string, signal: AbortSignal | undefined) => Promise<UnityRun> };

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
