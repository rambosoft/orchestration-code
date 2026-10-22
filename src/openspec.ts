import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { OpenSpecContext, OpenSpecPrepared } from "./contracts.js";
import { makeOpenSpecChangeId } from "./openspec-policy.js";
export { makeOpenSpecChangeId, openSpecProposalPrompt, parseOpenSpecTaskPrompt, resolveOpenSpecEnabled, shouldRunOpenSpec } from "./openspec-policy.js";

export const OPEN_SPEC_VERSION = "1.14.3";
import { childEnv } from "./env.js";
const require = createRequire(import.meta.url);
const packageEntry = require.resolve("@fission-ai/openspec");
export const openSpecCliPath = path.resolve(path.dirname(packageEntry), "..", "bin", "openspec.js");

type CliResult = { stdout: string; stderr: string };
export type OpenSpecCommandRunner = (args: string[], cwd: string) => Promise<CliResult>;

export const runOpenSpecCommand: OpenSpecCommandRunner = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [openSpecCliPath, ...args], {
    cwd,
    shell: false,
    windowsHide: true,
    env: { ...childEnv(), CI: "1", OPEN_SPEC_INTERACTIVE: "0", OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1" },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
  child.stdout.on("data", (chunk: Buffer) => { if (outputBytes < 500_000) { stdout.push(chunk); outputBytes += chunk.length; } });
  child.stderr.on("data", (chunk: Buffer) => { if (Buffer.concat(stderr).length < 32_000) stderr.push(chunk); });
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", code => {
    clearTimeout(timer);
    const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
    if (timedOut) return reject(new Error(`OpenSpec command timed out after 120000ms: openspec ${args.join(" ")}`));
    if (code !== 0) return reject(new Error(`OpenSpec command failed (exit ${code}): openspec ${args.join(" ")}\n${(result.stderr || result.stdout).slice(-3000)}`));
    resolve(result);
  });
});

function parseJsonOutput<T>(result: CliResult, command: string): T {
  try { return JSON.parse(result.stdout) as T; }
  catch { throw new Error(`OpenSpec ${command} returned invalid JSON: ${result.stdout.slice(0, 1000)}`); }
}

function assertSupportedNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19)) throw new Error(`OpenSpec ${OPEN_SPEC_VERSION} requires Node.js 20.19.0 or newer; worker is running ${process.versions.node}`);
}

export async function prepareOpenSpec(input: { taskId: string; runId: string; prompt: string; projectRoot: string; artifactsDir: string }, runner: OpenSpecCommandRunner = runOpenSpecCommand): Promise<OpenSpecPrepared> {
  assertSupportedNode();
  const root = path.resolve(input.projectRoot);
  const versionResult = await runner(["--version"], root);
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/m.exec(versionResult.stdout.trim());
  const version = match?.[1];
  if (!version) throw new Error(`could not determine OpenSpec CLI version from: ${versionResult.stdout.slice(0, 200)}`);
  if (version !== OPEN_SPEC_VERSION) throw new Error(`OpenSpec CLI version mismatch: orchestration requires ${OPEN_SPEC_VERSION}, found ${version}`);

  const configPath = path.join(root, "openspec", "config.yaml");
  const codexSkillPath = path.join(root, ".agents", "skills", "openspec-propose", "SKILL.md");
  let needsInit = false;
  try { await access(configPath); } catch { needsInit = true; }
  try { await access(codexSkillPath); } catch { needsInit = true; }
  if (needsInit) await runner(["init", "--tools", "codex", "--no-animation"], root);

  const changeId = makeOpenSpecChangeId(input.taskId, input.runId);
  const changeRoot = path.join(root, "openspec", "changes", changeId);
  try { await access(path.join(changeRoot, ".openspec.yaml")); }
  catch { await runner(["new", "change", changeId, "--goal", input.prompt.slice(0, 1000)], root); }
  await mkdir(input.artifactsDir, { recursive: true });
  const artifactRef = path.join(input.artifactsDir, "openspec-prepared.json");
  await writeFile(artifactRef, JSON.stringify({ changeId, version, projectRoot: root }, null, 2), "utf8");
  return { changeId, version, artifactRef };
}

type OpenSpecStatus = { changeName?: string; isComplete?: boolean; isPlanningComplete?: boolean; artifacts?: Array<{ id: string; status: string }> };
type ValidationReport = { items?: Array<{ valid?: boolean; issues?: Array<{ level?: string; message?: string }> }>; summary?: { totals?: { failed?: number } } };

async function walkMarkdownFiles(root: string, folder: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(file);
    }
  }
  await visit(folder);
  return found.map(file => path.relative(root, file).split(path.sep).join("/"));
}

function modifiedCapabilityPaths(proposal: string): string[] {
  const lines = proposal.split(/\r?\n/);
  const heading = lines.findIndex(line => /^### Modified Capabilities\s*$/.test(line));
  if (heading < 0) return [];
  const section: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^###\s+/.test(line)) break;
    section.push(line);
  }
  return [...section.join("\n").matchAll(/^\s*[-*]\s*`([^`]+)`/gm)].map(match => match[1]!).filter(value => !value.split(/[\\/]/).includes(".."));
}

function ensureInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`OpenSpec artifact path escapes project root: ${target}`);
}

export async function validateOpenSpec(input: { changeId: string; projectRoot: string; artifactsDir: string }, runner: OpenSpecCommandRunner = runOpenSpecCommand): Promise<OpenSpecContext> {
  const root = path.resolve(input.projectRoot);
  const changeRoot = path.resolve(root, "openspec", "changes", input.changeId);
  ensureInside(root, changeRoot);
  const statusResult = await runner(["status", "--change", input.changeId, "--json"], root);
  const status = parseJsonOutput<OpenSpecStatus>(statusResult, "status");
  if (status.changeName !== input.changeId || status.isComplete !== true) throw new Error(`OpenSpec proposal '${input.changeId}' is incomplete; status reports ${status.artifacts?.map(item => `${item.id}:${item.status}`).join(", ") ?? "no artifact details"}`);

  const metadataPath = path.join(changeRoot, ".openspec.yaml");
  const metadata = await readFile(metadataPath, "utf8");
  const skipSpecs = /^skip_specs:\s*true\s*$/mi.test(metadata);
  const changedFiles = await walkMarkdownFiles(root, changeRoot);
  const proposalPath = `openspec/changes/${input.changeId}/proposal.md`;
  const tasksPath = `openspec/changes/${input.changeId}/tasks.md`;
  if (!changedFiles.includes(proposalPath) || !changedFiles.includes(tasksPath)) throw new Error(`OpenSpec proposal '${input.changeId}' must contain proposal.md and tasks.md`);
  const deltaFiles = changedFiles.filter(file => file.startsWith(`openspec/changes/${input.changeId}/specs/`));
  if (!skipSpecs && deltaFiles.length === 0) throw new Error(`OpenSpec proposal '${input.changeId}' has no specification delta; set skip_specs only for a change that truly does not alter behavior`);

  const validationResult = await runner(["validate", input.changeId, "--strict", "--no-interactive", "--json"], root);
  const validation = parseJsonOutput<ValidationReport>(validationResult, "validate");
  const invalid = validation.items?.filter(item => item.valid === false) ?? [];
  if ((validation.summary?.totals?.failed ?? invalid.length) > 0 || invalid.length > 0) {
    const issues = invalid.flatMap(item => item.issues ?? []).map(issue => issue.message).join("; ");
    throw new Error(`OpenSpec validation failed for '${input.changeId}'${issues ? `: ${issues}` : ""}`);
  }

  const proposal = await readFile(path.join(root, proposalPath), "utf8");
  const contextFiles = new Map<string, string>();
  for (const relative of changedFiles) contextFiles.set(relative, await readFile(path.join(root, relative), "utf8"));
  for (const capability of modifiedCapabilityPaths(proposal)) {
    const relative = path.posix.join("openspec", "specs", capability.replace(/\\/g, "/"), "spec.md");
    const target = path.resolve(root, ...relative.split("/"));
    ensureInside(root, target);
    try { contextFiles.set(relative, await readFile(target, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const context = [...contextFiles].map(([file, content]) => `### ${file}\n\n${content.trim()}`).join("\n\n");
  await mkdir(input.artifactsDir, { recursive: true });
  const artifactRef = path.join(input.artifactsDir, `openspec-${input.changeId}-context.md`);
  await writeFile(artifactRef, context, "utf8");
  return { context, artifactRef, version: OPEN_SPEC_VERSION };
}

type OpenSpecList = { changes?: Array<{ name?: string; status?: string; archived?: boolean; path?: string }> };
type ArchiveResult = { archive?: { change?: string; archivedAs?: string; path?: string } };

export async function archiveOpenSpec(input: { changeId: string; projectRoot: string; artifactsDir: string }, runner: OpenSpecCommandRunner = runOpenSpecCommand): Promise<{ archivedPath: string; artifactRef: string }> {
  const root = path.resolve(input.projectRoot);
  const listResult = await runner(["list", "--archived", "--json"], root);
  const archivedList = parseJsonOutput<OpenSpecList>(listResult, "list --archived");
  const alreadyArchived = archivedList.changes?.find(change => change.name === input.changeId);
  let archivedPath = alreadyArchived?.path;
  if (!alreadyArchived) {
    const statusResult = await runner(["status", "--change", input.changeId, "--json"], root);
    const status = parseJsonOutput<OpenSpecStatus>(statusResult, "status");
    if (status.changeName !== input.changeId || status.isComplete !== true) throw new Error(`cannot archive incomplete OpenSpec change '${input.changeId}'`);
    const activeList = parseJsonOutput<OpenSpecList>(await runner(["list", "--json"], root), "list");
    const activeChange = activeList.changes?.find(change => change.name === input.changeId);
    if (!activeChange || activeChange.status !== "complete") throw new Error(`OpenSpec task checklist for '${input.changeId}' is not complete`);
    const result = parseJsonOutput<ArchiveResult>(await runner(["archive", input.changeId, "--yes", "--json"], root), "archive");
    if (result.archive?.change !== input.changeId || !result.archive.path) throw new Error(`OpenSpec archive returned no confirmed archive path for '${input.changeId}'`);
    archivedPath = result.archive.path;
  }
  await runner(["validate", "--specs", "--strict", "--no-interactive", "--json"], root);
  await mkdir(input.artifactsDir, { recursive: true });
  const artifactRef = path.join(input.artifactsDir, `openspec-${input.changeId}-archive.json`);
  await writeFile(artifactRef, JSON.stringify({ changeId: input.changeId, archivedPath }, null, 2), "utf8");
  return { archivedPath: archivedPath!, artifactRef };
}
