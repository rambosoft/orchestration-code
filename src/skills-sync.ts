import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Pinned skill import (ADR 0033 decision 5, B-118): reads an installed plugin's skill folder read-only, takes text files only (never scripts or executables), records where it came from
// and a SHA-256, and writes a candidate for a person to edit down and approve. A later change of the source marks the entry stale in `doctor`; nothing is ever updated silently.
const TEXT = /\.(?:md|markdown|txt)$/i;
const MAX_FILES = 40; const MAX_FILE_BYTES = 200_000; const MAX_TOTAL_BYTES = 1_000_000; const MAX_DEPTH = 4;

export type SkillFile = { rel: string; text: string };
export type SkillSource = { origin: string; note?: string; plugin?: string; version?: string; path?: string; sha256?: string };
export type CatalogEntry = { id: string; title: string; areas: string[]; tasks: string[]; stages: string[]; digest: string; status: "approved" | "candidate" | "retired"; source: SkillSource };
export type CatalogFile = { version: number; skills: CatalogEntry[] };
export type InstalledSkill = { plugin: string; version: string; dir: string; relativePath: string };

export const defaultPluginsDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "plugins");

/** Text files of a skill folder in a stable order, with what was left out and why. Symbolic links, other file types, oversize files and anything past the limits are skipped. */
export async function collectSkillText(dir: string): Promise<{ files: SkillFile[]; skipped: string[] }> {
  const files: SkillFile[] = []; const skipped: string[] = []; let total = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(current)).sort()) {
      const full = path.join(current, entry); const rel = path.relative(dir, full).split(path.sep).join("/");
      const info = await lstat(full);
      if (info.isSymbolicLink()) { skipped.push(`${rel} (symbolic link)`); continue; }
      if (info.isDirectory()) { if (depth < MAX_DEPTH) await walk(full, depth + 1); else skipped.push(`${rel}/ (too deep)`); continue; }
      if (!TEXT.test(entry)) { skipped.push(`${rel} (not a text document)`); continue; }
      if (info.size > MAX_FILE_BYTES || files.length >= MAX_FILES || total + info.size > MAX_TOTAL_BYTES) { skipped.push(`${rel} (over the size or count limit)`); continue; }
      total += info.size; files.push({ rel, text: (await readFile(full, "utf8")).replace(/\r\n/g, "\n") });
    }
  };
  await walk(dir, 0);
  return { files, skipped };
}
export const hashSkill = (files: SkillFile[]): string => createHash("sha256").update(files.map(file => `${file.rel}\0${file.text}\0`).join("")).digest("hex");

/** Installed copies of skills/<name> in every Claude plugin recorded in installed_plugins.json. */
export async function findInstalledSkills(name: string, pluginsDir = defaultPluginsDir()): Promise<InstalledSkill[]> {
  let installed: { plugins?: Record<string, Array<{ installPath?: string; version?: string }>> };
  try { installed = JSON.parse(await readFile(path.join(pluginsDir, "installed_plugins.json"), "utf8")); } catch { return []; }
  const found: InstalledSkill[] = [];
  for (const [plugin, installs] of Object.entries(installed.plugins ?? {})) for (const install of installs) {
    if (!install.installPath) continue;
    const relativePath = `skills/${name}`;
    const dir = path.join(install.installPath, relativePath);
    if (await lstat(dir).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false)) found.push({ plugin, version: install.version ?? "unknown", dir, relativePath });
  }
  return found;
}

export type ImportRequest = { id: string; title?: string; area: string; tasks?: string[]; stages?: string[] };
/** The catalog with a new candidate entry and the text files to keep under skills/candidates/<id>/ for review. Refuses an id that already exists. */
export async function importCandidate(catalog: CatalogFile, skill: InstalledSkill, request: ImportRequest): Promise<{ catalog: CatalogFile; files: SkillFile[]; skipped: string[]; entry: CatalogEntry }> {
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(request.id)) throw new Error(`invalid skill id '${request.id}' (lowercase letters, digits and dashes)`);
  if (catalog.skills.some(item => item.id === request.id)) throw new Error(`the catalog already has '${request.id}'; edit it by hand or pick another id`);
  const { files, skipped } = await collectSkillText(skill.dir);
  if (!files.length) throw new Error(`no text documents in ${skill.dir}`);
  const entry: CatalogEntry = { id: request.id, title: request.title ?? request.id, areas: [request.area], tasks: request.tasks ?? ["task", "bug"], stages: request.stages ?? ["plan", "implement", "review"], digest: `skills/${request.id}.md`, status: "candidate", source: { origin: `plugin ${skill.plugin} ${skill.version}: ${skill.relativePath}`, note: "imported text, not reviewed; condense to a digest of at most 1400 characters, then set status approved", plugin: skill.plugin, version: skill.version, path: skill.relativePath, sha256: hashSkill(files) } };
  return { catalog: { ...catalog, skills: [...catalog.skills, entry] }, files, skipped, entry };
}
export async function writeCandidate(root: string, id: string, files: SkillFile[]): Promise<string> {
  const dir = path.join(root, "skills", "candidates", id);
  for (const file of files) { const target = path.join(dir, file.rel); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.text); }
  return dir;
}

/** Imported entries whose source no longer matches the recorded hash. A plugin that is not installed on this machine says nothing (it cannot be compared). */
export async function staleSkills(catalog: CatalogFile, pluginsDir = defaultPluginsDir()): Promise<string[]> {
  const stale: string[] = [];
  for (const entry of catalog.skills) {
    const { plugin, path: relativePath, sha256 } = entry.source;
    if (!plugin || !relativePath || !sha256 || entry.status === "retired") continue;
    const installed = (await findInstalledSkills(path.posix.basename(relativePath), pluginsDir)).filter(item => item.plugin === plugin);
    if (!installed.length) continue;
    const hashes = await Promise.all(installed.map(async item => hashSkill((await collectSkillText(item.dir)).files)));
    if (!hashes.includes(sha256)) stale.push(`${entry.id} (${entry.status}): the source in ${plugin} changed since it was imported; review it and re-import`);
  }
  return stale;
}
