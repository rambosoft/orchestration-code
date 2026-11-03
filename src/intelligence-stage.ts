import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { runCommand, type CommandRunner } from "./command.js";
import type { IntelligenceConfig, QualityCommand } from "./contracts.js";
import { buildPackage, DEFAULT_PREPARATION_CHARS, renderPreparationBlock, validateFacts, writePackage } from "./intelligence.js";
import "./intelligence-adapters.js";
import { intelligenceRegistry, type IntelligenceRegistry } from "./intelligence-registry.js";

// The activity-side glue of the preparation package (B-163, B-167): runs before the plan, implement and review stages, never fails them, and adds no workflow command.
const MODEL_STAGES = new Set(["plan", "implement", "review"]);
const PATH_TOKEN = /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*\.(?:tsx?|jsx?|mjs|cjs|vue|css|json)\b/g;
const MAX_AFFECTED = 40;

export type StageIntelligence = { block: string; warnings: string[]; metadata: Record<string, unknown> };
type Options = { env?: NodeJS.ProcessEnv; runner?: CommandRunner; registry?: IntelligenceRegistry; now?: () => Date };

const lines = (output: string): string[] => output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

/** The prompt block for a model stage, or undefined when no advisory tool is on, nothing is affected yet, or anything went wrong (a problem becomes a warning, never an error). */
export async function prepareStageIntelligence(input: { stage: string; prompt: string; projectRoot: string; taskId: string; intelligence?: IntelligenceConfig }, options: Options = {}): Promise<StageIntelligence | undefined> {
  const registry = options.registry ?? intelligenceRegistry; const env = options.env ?? process.env; const runner = options.runner ?? runCommand;
  if (!MODEL_STAGES.has(input.stage) || !registry.list().some(adapter => registry.mode(adapter, input.intelligence, env) === "advisory")) return undefined;
  const started = Date.now();
  try {
    const root = path.resolve(input.projectRoot);
    const git = (...args: string[]) => runner("git", ["-c", "core.quotepath=off", ...args], root);
    const commit = (await git("rev-parse", "HEAD")).trim();
    const files = lines(await git("ls-files", "--cached", "--others", "--exclude-standard"));
    const known = new Set(files);
    const changed = [...lines(await git("diff", "--name-only", "HEAD")), ...lines(await git("ls-files", "--others", "--exclude-standard"))].filter(file => known.has(file));
    const named = (input.prompt.match(PATH_TOKEN) ?? []).map(token => token.replace(/^\.\//, "")).filter(token => known.has(token));
    const affectedFiles = [...new Set([...named, ...changed])].slice(0, MAX_AFFECTED);
    if (!affectedFiles.length) return { block: "", warnings: [], metadata: { skipped: "no affected files yet", durationMs: Date.now() - started } };
    const untracked = await Promise.all(lines(await git("ls-files", "--others", "--exclude-standard")).slice(0, 200).map(async file => { const info = await stat(path.join(root, file)).catch(() => undefined); return `${file}:${info?.size}:${info?.mtimeMs}`; }));
    const fingerprint = createHash("sha256").update([commit, await git("diff", "HEAD"), ...untracked].join("\n")).digest("hex").slice(0, 24);
    const collected = await registry.collect({ worktree: root, taskId: input.taskId, commit, affectedFiles, files, runner }, input.intelligence, { fingerprint, env });
    const checked = await validateFacts(collected.facts, root);
    const pkg = buildPackage({ taskId: input.taskId, commit, createdAt: (options.now?.() ?? new Date()).toISOString(), affectedFiles, facts: checked.valid, tools: collected.tools, warnings: collected.warnings, droppedReasons: checked.reasons });
    const block = renderPreparationBlock(pkg, input.intelligence?.budgetChars ?? DEFAULT_PREPARATION_CHARS);
    const written = block ? await writePackage(root, pkg, block, runner) : { dir: undefined, warnings: [] };
    const warnings = [...collected.warnings, ...written.warnings];
    return { block, warnings, metadata: { tools: collected.tools, affected: affectedFiles.length, facts: checked.valid.length, droppedStale: pkg.droppedStale, ...(written.dir ? { package: path.relative(root, written.dir).split(path.sep).join("/") } : {}), durationMs: Date.now() - started } };
  } catch (error) {
    return { block: "", warnings: [`preparation package skipped: ${error instanceof Error ? error.message : String(error)}`], metadata: { failed: true, durationMs: Date.now() - started } };
  }
}

/** Gate-mode tools' quality commands that the stage's own list does not already hold. */
export async function intelligenceGates(worktree: string, configured: QualityCommand[], config: IntelligenceConfig | undefined, options: Options = {}): Promise<QualityCommand[]> {
  const registry = options.registry ?? intelligenceRegistry;
  const same = (a: QualityCommand, b: QualityCommand) => a.executable === b.executable && a.args.join("\0") === b.args.join("\0");
  return (await registry.gateCommands(worktree, config, options.env)).filter(command => !configured.some(existing => same(existing, command)));
}
