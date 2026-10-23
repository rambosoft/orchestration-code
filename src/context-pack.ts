import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand, type CommandRunner } from "./command.js";
import { SENSITIVE_PATH } from "./publish-guard.js";
import { redactSecrets } from "./redact.js";
export { redactSecrets };

// A bounded, redacted extract of a repository for read-only exploration (research and architecture, ADR 0008). It is built deterministically from the
// scope stage's search terms, so what leaves the worktree (for providers that cannot read it themselves, a third-party API) is limited, reviewable and
// never contains credential files or secret-looking content.
const SKIPPED = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git|\.next|vendor|\.runtime|data)\/|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.lock|\.min\.[a-z]+|\.map)$|\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|7z|woff2?|ttf|otf|eot|mp[34]|mov|wasm|bin|exe|dll|sqlite|db|patch)$/i;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES_READ = 600;

export type ContextPack = { text: string; files: string[]; truncated: boolean };
export type ContextPackInput = { root: string; terms: string[]; paths: string[]; maxChars?: number };
export const DEFAULT_PACK_CHARS = 14_000;

async function listFiles(root: string, runner: CommandRunner): Promise<string[]> {
  try { return (await runner("git", ["-c", "core.quotepath=off", "ls-files"], root)).split(/\r?\n/).filter(Boolean); }
  catch {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
        const relative = dir ? `${dir}/${entry.name}` : entry.name;
        if (found.length >= 5000 || SKIPPED.test(`${relative}/`) ) continue;
        if (entry.isDirectory()) await walk(relative); else if (entry.isFile()) found.push(relative);
      }
    };
    await walk("");
    return found;
  }
}

const inside = (root: string, relative: string): string | undefined => {
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : undefined;
};
const clipLine = (line: string): string => line.length > 200 ? `${line.slice(0, 200)}…` : line;

/** Sections are added in priority order and the pack stops growing at maxChars, so the file map and README always survive and snippets fill the rest. */
export async function buildContextPack(input: ContextPackInput, runner: CommandRunner = runCommand): Promise<ContextPack> {
  const root = path.resolve(input.root);
  const limit = input.maxChars ?? DEFAULT_PACK_CHARS;
  const tracked = (await listFiles(root, runner)).filter(file => !SENSITIVE_PATH.some(pattern => pattern.test(file)) && !SKIPPED.test(file));
  const sections: string[] = []; const consulted: string[] = []; let size = 0; let truncated = false;
  const add = (title: string, body: string, file?: string): void => {
    if (!body.trim()) return;
    const block = `## ${title}\n${body}\n`;
    if (size + block.length > limit) { truncated = true; return; }
    sections.push(block); size += block.length; if (file) consulted.push(file);
  };

  const byFolder = new Map<string, number>();
  for (const file of tracked) { const parts = file.split("/"); const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length > 1 ? `${parts[0]}/` : "(root)"; byFolder.set(key, (byFolder.get(key) ?? 0) + 1); }
  add("File map (folder: tracked files)", [...byFolder].sort(([a], [b]) => a.localeCompare(b)).map(([folder, count]) => `${folder}: ${count}`).join("\n").slice(0, 2500));

  const readme = tracked.find(file => /^readme(?:\.md)?$/i.test(file));
  if (readme) add(`README (${readme}, start)`, redactSecrets((await readFile(path.join(root, readme), "utf8").catch(() => "")).slice(0, 1800)), readme);
  if (tracked.includes("package.json")) {
    try { const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string> }; add("package.json (names only)", `name: ${manifest.name ?? "?"}\nscripts: ${Object.keys(manifest.scripts ?? {}).join(", ")}\ndependencies: ${Object.keys(manifest.dependencies ?? {}).slice(0, 40).join(", ")}`, "package.json"); } catch { /* not valid JSON: skip */ }
  }

  for (const wanted of input.paths.slice(0, 10)) {
    const absolute = inside(root, wanted.replace(/^\.?\//, ""));
    const relative = absolute ? path.relative(root, absolute).split(path.sep).join("/") : "";
    if (!absolute || !relative) continue;
    const folder = tracked.filter(file => file.startsWith(`${relative}/`));
    if (folder.length) { add(`Folder ${relative}/`, folder.slice(0, 40).join("\n")); continue; }
    if (!tracked.includes(relative)) continue;
    const content = await readFile(absolute, "utf8").catch(() => "");
    add(`${relative} (first lines)`, redactSecrets(content.split(/\r?\n/).slice(0, 60).map(clipLine).join("\n")).slice(0, 2400), relative);
  }

  const terms = [...new Set(input.terms.map(term => term.trim().toLowerCase()).filter(term => term.length >= 3))].slice(0, 12);
  if (terms.length) {
    const scored: Array<{ file: string; score: number; lines: string[] }> = [];
    for (const file of tracked.slice(0, 5000)) {
      if (scored.length >= MAX_FILES_READ) break;
      const pathHits = terms.filter(term => file.toLowerCase().includes(term)).length * 3;
      const size = await stat(path.join(root, file)).then(s => s.size, () => Infinity);
      if (size > MAX_FILE_BYTES) continue;
      const lines = (await readFile(path.join(root, file), "utf8").catch(() => "")).split(/\r?\n/);
      const hits = lines.reduce((sum, line) => sum + (terms.some(term => line.toLowerCase().includes(term)) ? 1 : 0), 0);
      if (hits + pathHits > 0) scored.push({ file, score: hits + pathHits, lines });
    }
    for (const { file, lines } of scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, 10)) {
      const windows: Array<[number, number]> = [];
      lines.forEach((line, index) => {
        if (!terms.some(term => line.toLowerCase().includes(term)) || windows.length >= 3) return;
        const last = windows[windows.length - 1];
        if (last && index - 3 <= last[1]) last[1] = Math.min(lines.length - 1, index + 3); else windows.push([Math.max(0, index - 3), Math.min(lines.length - 1, index + 3)]);
      });
      const body = windows.map(([from, to]) => lines.slice(from, to + 1).map((line, offset) => `${from + offset + 1}: ${clipLine(line)}`).join("\n")).join("\n...\n");
      add(`${file} (matches)`, redactSecrets(body).slice(0, 1800), file);
    }
  }
  return { text: sections.join("\n") || "(no repository context could be built)", files: consulted, truncated };
}
