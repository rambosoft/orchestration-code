// A passing set of quality checks is a fact about a working tree: the same commands on the same files give the same verdict. The verify activity reuses a pass when nothing changed since
// (an activity retry, a resumed run, a repair round that touched nothing), instead of paying for the same suite again (6 minutes per PlayMode run at task 11 of the first game).
// Failures are never stored, and any trouble here (no git, an unreadable file) means "no reuse", never a wrong pass.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";

export type CachedCheck = { executable: string; args: string[]; exitCode: number | null; durationMs: number; output: string; stderr: string };
export type QualityPass = { key: string; fingerprints: string[]; attempt: number; checks: CachedCheck[]; warnings: string[] };
type CommandLike = { executable: string; args: string[]; cwd?: string; severity?: string };

const MAX_PASSES = 5;
const LARGE_FILE_BYTES = 100 * 1024 * 1024;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export const qualityReuseEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.ORCHESTRATOR_QUALITY_REUSE !== "0";
export const qualityKey = (checks: CommandLike[]): string => sha(JSON.stringify(checks.map(check => [check.executable, check.args, check.cwd ?? "", check.severity ?? "error"])));

export type FingerprintDeps = { listFiles?: (root: string) => Promise<string[]>; hashFile?: (file: string) => Promise<string> };
async function gitFiles(root: string): Promise<string[]> {
  return (await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)).split("\0").filter(Boolean);
}
async function hashFile(file: string): Promise<string> {
  const info = await stat(file).catch(() => undefined);
  if (!info) return "missing";
  // A very large asset is identified by size and modification time instead of being read.
  if (info.size > LARGE_FILE_BYTES) return `large:${info.size}:${Math.floor(info.mtimeMs)}`;
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256"); const stream = createReadStream(file);
    stream.on("data", chunk => hash.update(chunk)); stream.on("error", reject); stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** A hash of every file git would commit (tracked and untracked, not ignored) by path and content; undefined when it cannot be computed. */
export async function treeFingerprint(root: string, deps: FingerprintDeps = {}): Promise<string | undefined> {
  try {
    const files = [...new Set(await (deps.listFiles ?? gitFiles)(root))].sort();
    const hasher = deps.hashFile ?? hashFile;
    const lines: string[] = new Array(files.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
      for (let index = next++; index < files.length; index = next++) lines[index] = `${files[index]}\0${await hasher(path.join(root, files[index]!))}`;
    }));
    return sha(lines.join("\n"));
  } catch { return undefined; }
}

const passFile = (dir: string): string => path.join(dir, "quality-pass.json");
export async function readPasses(dir: string): Promise<QualityPass[]> {
  try {
    const parsed = JSON.parse(await readFile(passFile(dir), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is QualityPass => typeof item === "object" && item !== null && typeof (item as QualityPass).key === "string" && Array.isArray((item as QualityPass).fingerprints) && Array.isArray((item as QualityPass).checks)) : [];
  } catch { return []; }
}
export const findReusable = (passes: QualityPass[], key: string, fingerprint: string): QualityPass | undefined => [...passes].reverse().find(pass => pass.key === key && pass.fingerprints.includes(fingerprint));
export async function writePass(dir: string, pass: QualityPass): Promise<void> {
  const passes = [...(await readPasses(dir)).filter(item => !(item.key === pass.key && item.fingerprints.some(fp => pass.fingerprints.includes(fp)))), pass].slice(-MAX_PASSES);
  await writeFile(passFile(dir), JSON.stringify(passes, null, 2));
}
