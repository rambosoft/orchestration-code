// Task size estimate (task-size gate): how many files and areas a task touches decides small, normal or large, against per-tier limits. Pure and workflow-safe (no clock, no I/O); callers supply the file list,
// measured from a diff or read from the task text (filesNamedIn). An empty list is "unknown": the estimate stays normal rather than guessing.
import type { SizeHint, Tier } from "./lanes.js";
import type { ProjectManifest } from "./contracts.js";

export type SizeLimits = { smallMaxFiles: number; largeMinFiles: number; maxAreas: number };
/** Production is the operator's 3 to 10 files and 1 to 2 areas; mvp and prototype values are a judgement call, tunable per project. */
export const DEFAULT_SIZE_LIMITS: Record<Tier, SizeLimits> = {
  throwaway: { smallMaxFiles: 3, largeMinFiles: 40, maxAreas: 6 },
  prototype: { smallMaxFiles: 3, largeMinFiles: 40, maxAreas: 6 },
  mvp: { smallMaxFiles: 2, largeMinFiles: 12, maxAreas: 3 },
  production: { smallMaxFiles: 2, largeMinFiles: 10, maxAreas: 2 },
};
/** The limits for a project: its tier's defaults (absent tier: production) with the manifest's `sizing` numbers laid over them. */
export function sizeLimitsFor(project: Pick<ProjectManifest, "tier" | "sizing">): SizeLimits {
  const base = DEFAULT_SIZE_LIMITS[project.tier ?? "production"], z = project.sizing;
  return { smallMaxFiles: z?.smallMaxFiles ?? base.smallMaxFiles, largeMinFiles: z?.largeMinFiles ?? base.largeMinFiles, maxAreas: z?.maxAreas ?? base.maxAreas };
}
export type SizeEstimate = { hint: SizeHint; files: number; areas: number; basis: "measured" | "text" | "unknown"; reasons: string[] };

const norm = (file: string): string => file.replace(/\\/g, "/").replace(/^\.\//, "");
const SOURCE_ROOTS = new Set(["src", "app"]);

/** The area of a file: the first directory under `src/` or `app/`, the package under `packages/`, else the first segment; files at the repository root share the area ".". */
export function areaOf(file: string): string {
  const parts = norm(file).split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) return ".";
  if (SOURCE_ROOTS.has(dirs[0]!) || dirs[0] === "packages") return dirs.slice(0, 2).join("/");
  return dirs[0]!;
}

export function estimateSize(input: { files: string[]; basis?: "measured" | "text" }, limits: SizeLimits): SizeEstimate {
  const files = [...new Set(input.files.map(norm).filter(Boolean))];
  if (files.length === 0) return { hint: "normal", files: 0, areas: 0, basis: "unknown", reasons: [] };
  const areas = new Set(files.map(areaOf)).size;
  const reasons: string[] = [];
  if (files.length >= limits.largeMinFiles) reasons.push(`${files.length} files (large from ${limits.largeMinFiles})`);
  if (areas > limits.maxAreas) reasons.push(`${areas} areas (limit ${limits.maxAreas})`);
  const hint: SizeHint = reasons.length > 0 ? "large" : files.length <= limits.smallMaxFiles && areas === 1 ? "small" : "normal";
  return { hint, files: files.length, areas, basis: input.basis ?? "text", reasons };
}

/** A split proposal for a task that is too large: the files grouped by area, each group cut into parts of at most `largeMinFiles - 1` files. Every file appears exactly once; titles name the area and part number. */
export function proposeSplit(files: string[], limits: SizeLimits): Array<{ title: string; files: string[] }> {
  const groups = new Map<string, string[]>();
  for (const file of new Set(files.map(norm).filter(Boolean))) groups.set(areaOf(file), [...(groups.get(areaOf(file)) ?? []), file]);
  const size = Math.max(1, limits.largeMinFiles - 1);
  return [...groups].flatMap(([area, group]) => Array.from({ length: Math.ceil(group.length / size) }, (_, part) => ({ title: `${area} part ${part + 1}`, files: group.slice(part * size, (part + 1) * size) })));
}

const NAMED_FILE = /(?<![\w./:@~-])(?:[\w.-]+[\\/])*[\w-][\w.-]*\.(?:tsx|ts|jsx|js|mjs|cjs|json|css|scss|html|vue|py|cs|go|rs|java|kt|swift)\b/g;
/** Framework names written in prose ("Node.js", "Vue.js") look like files but are not; a path such as lib/vue.js is still a file. */
const FRAMEWORK_NAME = /^(?:node|vue|next|nuxt|react|express)\.js$/i;
/** Relative paths with a known source extension named in task text, normalized to forward slashes and de-duplicated; URLs and absolute paths are skipped. */
export function filesNamedIn(text: string): string[] {
  return [...new Set((text.match(NAMED_FILE) ?? []).filter(name => !FRAMEWORK_NAME.test(name)).map(norm))];
}
