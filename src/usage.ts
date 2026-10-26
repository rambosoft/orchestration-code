// Token accounting. The first game showed where tokens go: about 51 M cache-read tokens against 0.36 M output across 14 tasks, so the cost is the context an agent re-reads, and it grows with the repository.
// Providers report usage in three shapes; this normalises them, adds them up per run from the stage artifacts the activities already write, and turns a per-task budget into a warning and a hard stop.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
export const emptyUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Claude: input_tokens + cache_* ; Codex: input_tokens includes cached_input_tokens ; OpenRouter: prompt_tokens includes cached_tokens. Undefined when the payload has no recognisable counts. */
export function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  if ("cache_read_input_tokens" in u || "cache_creation_input_tokens" in u) return { input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) };
  if ("cached_input_tokens" in u) { const cached = num(u.cached_input_tokens); return { input: Math.max(0, num(u.input_tokens) - cached), cacheRead: cached, cacheWrite: 0, output: num(u.output_tokens) }; }
  if ("prompt_tokens" in u) {
    const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>; const cached = num(details.cached_tokens);
    return { input: Math.max(0, num(u.prompt_tokens) - cached), cacheRead: cached, cacheWrite: num(details.cache_write_tokens), output: num(u.completion_tokens) };
  }
  if ("input_tokens" in u || "output_tokens" in u) return { input: num(u.input_tokens), cacheRead: 0, cacheWrite: 0, output: num(u.output_tokens) };
  return undefined;
}

export const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output });
/**
 * One number to budget against: tokens weighted by their relative price in input-token equivalents (cache write 1.25x, cache read 0.1x, output 5x, following the usual list-price ratios).
 * It is a proxy for cost, not a bill; the raw counts are always shown next to it.
 */
export const costUnits = (usage: Usage): number => Math.round(usage.input + 1.25 * usage.cacheWrite + 0.1 * usage.cacheRead + 5 * usage.output);
export const cacheHitRatio = (usage: Usage): number => { const prompt = usage.input + usage.cacheRead + usage.cacheWrite; return prompt ? usage.cacheRead / prompt : 0; };

export type RunUsage = { total: Usage; units: number; stages: number; byStage: Record<string, Usage & { count: number }> };
/** Adds up the usage recorded in the stage results of one run folder (artifacts/<task>/<run>/<stage>-<n>.json). Failure and quality files carry none and are ignored. */
export async function runUsage(dir: string): Promise<RunUsage> {
  let total = emptyUsage(); let stages = 0; const byStage: RunUsage["byStage"] = {};
  let names: string[] = [];
  try { names = (await readdir(dir)).filter(name => /^[a-z_]+-\d+\.json$/.test(name)); } catch { return { total, units: 0, stages: 0, byStage }; }
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, name), "utf8")) as { metadata?: { usage?: unknown; telemetry?: { usage?: unknown } } };
      const usage = normalizeUsage(parsed.metadata?.usage ?? parsed.metadata?.telemetry?.usage);
      if (!usage) continue;
      total = addUsage(total, usage); stages++;
      const stage = name.replace(/-\d+\.json$/, "");
      byStage[stage] = { ...addUsage(byStage[stage] ?? emptyUsage(), usage), count: (byStage[stage]?.count ?? 0) + 1 };
    } catch { /* an unreadable file is not usage */ }
  }
  return { total, units: costUnits(total), stages, byStage };
}

export type Budget = { maxCostUnits: number; warnAt: number };
export type BudgetStatus = { state: "ok" | "warn" | "exceeded"; message?: string };
export const budgetStatus = (units: number, budget: Budget | undefined): BudgetStatus => {
  if (!budget) return { state: "ok" };
  if (units >= budget.maxCostUnits) return { state: "exceeded", message: `TokenBudgetExceeded: this run used ${units.toLocaleString("en-US")} cost units of its ${budget.maxCostUnits.toLocaleString("en-US")} budget (input-token equivalents). Raise the budget (resume-run --budget N) or split the task.` };
  if (units >= budget.maxCostUnits * budget.warnAt) return { state: "warn", message: `token budget: ${units.toLocaleString("en-US")} of ${budget.maxCostUnits.toLocaleString("en-US")} cost units used (${Math.round(units / budget.maxCostUnits * 100)}%)` };
  return { state: "ok" };
};

export type UsageRow = { task: string; run: string; units: number; total: Usage; cacheHit: number; stages: number; at: number };
/** One row per run folder under the artifacts root, newest last; `since` (ISO date) drops older runs. */
export async function usageReport(root: string, options: { since?: string } = {}): Promise<UsageRow[]> {
  const since = options.since ? new Date(options.since).getTime() : 0;
  const rows: UsageRow[] = [];
  let tasks: string[] = [];
  try { tasks = await readdir(root); } catch { return rows; }
  for (const task of tasks) {
    let runs: import("node:fs").Dirent[] = [];
    try { runs = (await readdir(path.join(root, task), { withFileTypes: true })).filter(entry => entry.isDirectory()); } catch { continue; }
    for (const run of runs) {
      const dir = path.join(root, task, run.name);
      const usage = await runUsage(dir);
      if (!usage.stages) continue;
      const files = await readdir(dir).catch(() => [] as string[]);
      const at = Math.max(0, ...(await Promise.all(files.map(file => stat(path.join(dir, file)).then(info => info.mtimeMs, () => 0)))));
      if (at < since) continue;
      rows.push({ task: task.slice(0, 8), run: run.name.slice(0, 8), units: usage.units, total: usage.total, cacheHit: cacheHitRatio(usage.total), stages: usage.stages, at });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

const k = (value: number): string => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
export function formatUsageReport(rows: UsageRow[]): string {
  if (!rows.length) return "no recorded token usage";
  const total = rows.reduce((sum, row) => addUsage(sum, row.total), emptyUsage());
  const lines = rows.map(row => `${row.task}  ${row.run}  units ${k(row.units).padStart(6)}  in ${k(row.total.input).padStart(6)}  cache-read ${k(row.total.cacheRead).padStart(6)}  cache-write ${k(row.total.cacheWrite).padStart(6)}  out ${k(row.total.output).padStart(6)}  cache hit ${Math.round(row.cacheHit * 100)}%  stages ${row.stages}`);
  return [...lines, `${"total".padEnd(18)}units ${k(costUnits(total)).padStart(6)}  in ${k(total.input).padStart(6)}  cache-read ${k(total.cacheRead).padStart(6)}  cache-write ${k(total.cacheWrite).padStart(6)}  out ${k(total.output).padStart(6)}  cache hit ${Math.round(cacheHitRatio(total) * 100)}%  (${rows.length} runs)`].join("\n");
}
