import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { childEnv } from "./env.js";
import { detectStackProfile } from "./stack-packs.js";
import type { StackProfileId } from "./stack-profiles.js";

// Adopting an existing repository (ADR 0032, B-107): folder browsing and admission checks that run on the host worker. A browser never sends a path to be read, only a path to be
// checked; every path is resolved through the real file system and must stay inside an allow-listed root. Nothing here reads file contents.
const run = promisify(execFile);
export const EXISTING_MODES = ["maintain", "refactor", "migrate", "audit"] as const;
export type ExistingMode = (typeof EXISTING_MODES)[number];
const SKIPPED = new Set(["node_modules", "dist", "build", "target", "__pycache__"]);

/** `ORCHESTRATOR_BROWSE_ROOTS` is a `;`-separated list; the default is the workspace folder this orchestrator sits in. */
export function browseRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (environment.ORCHESTRATOR_BROWSE_ROOTS ?? "").split(";").map(item => item.trim()).filter(Boolean);
  return configured.length ? configured.map(item => path.resolve(item)) : [path.resolve("..")];
}

const same = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return same(root, candidate) || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}
const realRoots = (roots: readonly string[]): Promise<string[]> => Promise.all(roots.map(root => realpath(root).catch(() => path.resolve(root))));

/** The real path of `folder` when it is an existing directory under one of the roots, otherwise the reason it is refused. Symlinks and `..` are resolved before the check. */
export async function resolveInsideRoots(folder: string, roots: readonly string[]): Promise<{ path: string } | { problem: string }> {
  if (!folder || folder.includes("\0")) return { problem: "no folder given" };
  let real: string;
  try { real = await realpath(path.resolve(folder)); } catch { return { problem: "the folder does not exist" }; }
  if (!(await stat(real)).isDirectory()) return { problem: "the path is not a folder" };
  return (await realRoots(roots)).some(root => inside(root, real)) ? { path: real } : { problem: `the folder is outside the allowed roots (${roots.join("; ")})` };
}

export type FolderEntry = { name: string; path: string; git: boolean };
/** Sub-folders of a folder under the roots, for the wizard's browser. Hidden folders and build output are left out; with no folder it lists the roots themselves. `parent` is set only while it is still inside a root. */
export async function listFolders(folder: string | undefined, roots: readonly string[]): Promise<{ folders: FolderEntry[]; parent?: string } | { problem: string }> {
  if (!folder) return { folders: roots.map(root => ({ name: root, path: root, git: false })) };
  const resolved = await resolveInsideRoots(folder, roots);
  if ("problem" in resolved) return resolved;
  const folders: FolderEntry[] = [];
  for (const entry of await readdir(resolved.path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
    const child = path.join(resolved.path, entry.name);
    folders.push({ name: entry.name, path: child, git: await stat(path.join(child, ".git")).then(() => true, () => false) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(resolved.path);
  return { folders, ...((await realRoots(roots)).some(root => inside(root, parent)) ? { parent } : {}) };
}

export type FolderCheck = { ok: boolean; problems: string[]; path?: string; branch?: string; remote?: string; profile?: StackProfileId; dirtyFiles?: number };
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try { return (await run("git", args, { cwd, env: childEnv(), timeout: 20_000, windowsHide: true })).stdout.trim(); } catch { return undefined; }
}

/** Admission check for an existing repository: inside the roots, the root of a git repository, a clean working tree, a remote (needed to open PRs). Returns every problem, not only the first. */
export async function inspectExistingFolder(folder: string, roots: readonly string[] = browseRoots()): Promise<FolderCheck> {
  const resolved = await resolveInsideRoots(folder, roots);
  if ("problem" in resolved) return { ok: false, problems: [resolved.problem] };
  const top = await git(resolved.path, ["rev-parse", "--show-toplevel"]);
  if (!top) return { ok: false, problems: ["the folder is not a git repository"], path: resolved.path };
  const problems: string[] = [];
  const topReal = await realpath(path.resolve(top)).catch(() => path.resolve(top));
  if (!same(topReal, resolved.path)) problems.push(`the folder is inside the repository at ${topReal}; choose its root`);
  const branch = await git(resolved.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") problems.push("the repository has no commits or a detached HEAD");
  const dirty = ((await git(resolved.path, ["status", "--porcelain"])) ?? "").split(/\r?\n/).filter(Boolean).length;
  if (dirty > 0) problems.push(`the working tree has ${dirty} uncommitted change(s); commit or stash them first`);
  const remote = await git(resolved.path, ["remote", "get-url", "origin"]);
  if (!remote) problems.push("the repository has no 'origin' remote");
  const profile = detectStackProfile(resolved.path);
  return { ok: problems.length === 0, problems, path: resolved.path, ...(branch ? { branch } : {}), ...(remote ? { remote } : {}), ...(profile ? { profile } : {}), dirtyFiles: dirty };
}
