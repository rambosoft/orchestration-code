// What the reviewer reads. The first game's reviews saw the first 60 000 characters of `git diff --binary`, sorted by path, so build output under `.utmp/` (44% object files, 17% PNG, 4.7% source) filled the
// window and the C# never arrived. The digest lists every changed file, shows the reviewable ones in priority order (source, tests, config, docs) inside a budget, summarises scenes and prefabs, counts what is
// not reviewable (generated, binary, lock files, .meta) instead of printing it, and on a follow-up round shows only the files that changed since the reviewer last saw them. Classification is by
// file name and the stacks found in the repository (src/stack-traits.ts), so it works for any language the table knows.
import { createHash } from "node:crypto";
import { isDocFile, isGeneratedPath, isNoisyPath, isTestFile, type StackInfo } from "./stack-traits.js";

export type FileChange = { path: string; added: number; removed: number; binary: boolean };
export type FileKind = "source" | "test" | "config" | "doc" | "asset" | "other" | "generated" | "binary" | "lock" | "meta" | "noise";
export type DigestBudget = { total: number; perFile: Record<"source" | "test" | "config" | "doc" | "other", number> };
export const DEFAULT_DIGEST_BUDGET: DigestBudget = { total: 60_000, perFile: { source: 14_000, test: 10_000, config: 4_000, doc: 3_000, other: 3_000 } };

/** Parses `git diff --numstat` lines ("12\t3\tpath", "-\t-\tbinary.png"). Renames ("a => b") keep the new name. */
export function parseNumstat(text: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const name = match[3]!.replace(/^(.*)\{.* => (.*)\}(.*)$/, "$1$2$3").replace(/^.* => /, "");
    changes.push({ path: name, added: match[1] === "-" ? 0 : Number(match[1]), removed: match[2] === "-" ? 0 : Number(match[2]), binary: match[1] === "-" });
  }
  return changes;
}

const SOURCE = /\.(cs|ts|tsx|js|jsx|mjs|cjs|java|kt|kts|scala|groovy|py|go|rs|cpp|cc|c|h|hpp|swift|m|dart|shader|hlsl|cginc|compute|glsl|vue|svelte|rb|php|sql|sh|ps1|gradle)$/i;
const CONFIG = /\.(json|ya?ml|toml|xml|ini|properties|asmdef|asmref|csproj|uxml|uss|cfg|conf|env\.example)$/i;
const ASSET = /\.(unity|prefab|asset|mat|anim|controller|playable|overrideController|physicMaterial|lighting|flare|cubemap|mask|renderTexture|spriteatlas|inputactions)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|bmp|tga|psd|ico|ttf|otf|woff2?|wav|mp3|ogg|mp4|mov|fbx|obj|blend|so|dll|exe|o|a|aab|apk|jar|zip|gz|7z|pdf|keystore)$/i;

export function classifyFile(change: FileChange, stack: StackInfo): FileKind {
  const file = change.path;
  if (isGeneratedPath(stack, file)) return "generated";
  if (/\.meta$/i.test(file)) return "meta";
  if (isNoisyPath(file)) return /lock|\.sum$/i.test(file) ? "lock" : "noise";
  if (change.binary || BINARY.test(file)) return "binary";
  if (ASSET.test(file)) return "asset";
  if (isTestFile(file) && SOURCE.test(file)) return "test";
  if (SOURCE.test(file)) return "source";
  if (CONFIG.test(file)) return "config";
  if (isDocFile(file)) return "doc";
  return "other";
}
const RANK: Record<FileKind, number> = { source: 0, test: 1, config: 2, doc: 3, other: 4, asset: 5, generated: 9, binary: 9, lock: 9, meta: 9, noise: 9 };

/** The per-file diff without git's header noise (index line, mode lines), cut at a line boundary with a note saying how much was left out. */
export function trimFileDiff(diff: string, limit: number): { text: string; cut: boolean } {
  const lines = diff.split(/\r?\n/).filter(line => !/^(diff --git|index [0-9a-f]+\.\.|similarity index|rename (from|to) )/.test(line));
  const body = lines.join("\n").trim();
  if (body.length <= limit) return { text: body, cut: false };
  const kept = body.slice(0, limit); const lastBreak = kept.lastIndexOf("\n");
  const head = lastBreak > limit * 0.6 ? kept.slice(0, lastBreak) : kept;
  const left = body.slice(head.length).split("\n").length - 1;
  return { text: `${head}\n[... ${left} more lines of this file's diff left out: read the file]`, cut: true };
}

export type DigestInput = {
  changes: FileChange[];
  stack: StackInfo;
  /** The diff of one file. Called only for files that are shown. */
  readDiff: (file: string) => Promise<string>;
  /** Hashes of the per-file diffs the reviewer saw in the previous round: unchanged files are listed, not repeated. */
  previous?: Record<string, string>;
  budget?: DigestBudget;
};
export type Digest = { text: string; hashes: Record<string, string>; shown: string[]; omitted: string[] };

const hash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
const counts = (change: FileChange): string => `+${change.added} -${change.removed}`;

export async function buildDigest(input: DigestInput): Promise<Digest> {
  const budget = input.budget ?? DEFAULT_DIGEST_BUDGET;
  const classified = input.changes.map(change => ({ change, kind: classifyFile(change, input.stack) }));
  const reviewable = classified.filter(item => RANK[item.kind] < 9);
  const skipped = classified.filter(item => RANK[item.kind] === 9);
  // Small files first inside a rank, so as many files as possible are shown whole.
  const ordered = [...reviewable].sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.change.added + a.change.removed) - (b.change.added + b.change.removed) || a.change.path.localeCompare(b.change.path));
  const blocks: string[] = []; const shown: string[] = []; const overBudget: string[] = []; const unchanged: string[] = []; const summarised: string[] = [];
  const hashes: Record<string, string> = {};
  let used = 0;
  for (const { change, kind } of ordered) {
    if (kind === "asset") { summarised.push(`${change.path} ${counts(change)} (generated YAML scene/asset data: summary only; open the file if it matters)`); continue; }
    const raw = await input.readDiff(change.path);
    const fileHash = hash(raw); hashes[change.path] = fileHash;
    if (input.previous && input.previous[change.path] === fileHash) { unchanged.push(`${change.path} ${counts(change)}`); continue; }
    const limit = budget.perFile[kind as keyof DigestBudget["perFile"]];
    const trimmed = trimFileDiff(raw, limit);
    const block = `### ${change.path} (${kind}, ${counts(change)})\n${trimmed.text}`;
    if (used + block.length > budget.total) { overBudget.push(`${change.path} ${counts(change)}`); continue; }
    used += block.length; blocks.push(block); shown.push(change.path);
  }

  const kinds = new Map<FileKind, { files: number; added: number }>();
  for (const item of skipped) { const entry = kinds.get(item.kind) ?? { files: 0, added: 0 }; entry.files++; entry.added += item.change.added; kinds.set(item.kind, entry); }
  const notReviewable = [...kinds].map(([kind, entry]) => `${entry.files} ${kind}`).join(", ");
  const generated = kinds.get("generated");
  const totalAdded = input.changes.reduce((sum, change) => sum + change.added, 0); const totalRemoved = input.changes.reduce((sum, change) => sum + change.removed, 0);
  const header = [
    `Review scope: ${input.changes.length} changed file(s) (+${totalAdded} -${totalRemoved}); ${shown.length} shown below, in priority order (source, tests, config, docs).`,
    ...(notReviewable ? [`Not reviewable and left out: ${notReviewable} (generated output, binaries, lock files, .meta, minified or build folders).`] : []),
    ...(generated ? [`${generated.files} generated build file(s) are part of this change (+${generated.added} lines). They should not be: report that as a finding.`] : []),
    ...(summarised.length ? [`Summary only:\n${summarised.map(item => `- ${item}`).join("\n")}`] : []),
    ...(unchanged.length ? [`Unchanged since the previous review round (not repeated):\n${unchanged.map(item => `- ${item}`).join("\n")}`] : []),
    ...(overBudget.length ? [`Not shown because the size budget is used up (read them yourself with git diff):\n${overBudget.map(item => `- ${item}`).join("\n")}`] : []),
  ].join("\n");
  return { text: `${header}\n\n${blocks.join("\n\n")}`.trim(), hashes, shown, omitted: [...overBudget, ...skipped.map(item => item.change.path)] };
}
