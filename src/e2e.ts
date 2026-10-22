import { readFile, writeFile } from "node:fs/promises";
import type { PublishResult, RunResult } from "./contracts.js";

export type E2eTask = { taskId: string; title?: string; prompt: string; startAttempt?: number };
export type E2eSpec = { projectId: string; tasks: E2eTask[] };
export type StageSummary = { stage: string; provider: string; ok: boolean; seconds: number; inputTokens?: number; outputTokens?: number };
export type TaskOutcome = { taskId: string; attempt: number; workflowId: string; status: "completed" | "failed" | "rejected" | "error"; message: string; stopReason?: string; publish?: PublishResult; stages: StageSummary[]; totalSeconds: number };

const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Per-stage timing and token usage from a run result (Codex and Claude/OpenRouter usage shapes). */
export function summarizeStages(result: Pick<RunResult, "stages">): StageSummary[] {
  return result.stages.map(stage => {
    const metadata = stage.metadata as { usage?: Record<string, unknown>; codexActivity?: { usage?: Record<string, unknown> } } | undefined;
    const usage = metadata?.usage ?? metadata?.codexActivity?.usage;
    const inputTokens = num(usage?.input_tokens) ?? num(usage?.prompt_tokens);
    const outputTokens = num(usage?.output_tokens) ?? num(usage?.completion_tokens);
    return { stage: stage.stage ?? "?", provider: stage.provider, ok: stage.ok, seconds: Math.round(stage.durationMs / 1000), ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
  });
}

export function totals(outcomes: TaskOutcome[]): { seconds: number; inputTokens: number; outputTokens: number; byProvider: Record<string, { seconds: number; inputTokens: number; outputTokens: number }> } {
  const byProvider: Record<string, { seconds: number; inputTokens: number; outputTokens: number }> = {};
  for (const stage of outcomes.flatMap(outcome => outcome.stages)) {
    const entry = byProvider[stage.provider] ??= { seconds: 0, inputTokens: 0, outputTokens: 0 };
    entry.seconds += stage.seconds; entry.inputTokens += stage.inputTokens ?? 0; entry.outputTokens += stage.outputTokens ?? 0;
  }
  const all = Object.values(byProvider);
  return { seconds: all.reduce((sum, e) => sum + e.seconds, 0), inputTokens: all.reduce((sum, e) => sum + e.inputTokens, 0), outputTokens: all.reduce((sum, e) => sum + e.outputTokens, 0), byProvider };
}

type Http = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

export function bridgeHttp(base: string, token: string): Http {
  return async (method, path, body) => {
    const response = await fetch(`${base.replace(/\/$/, "")}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  };
}

/**
 * Run a chain of stacked tasks through the bridge: each task starts from the previous task's published branch.
 * A failed task stops the chain; with maxAttempts > 1 it is retried under the next attempt number (a new branch).
 */
export async function runChain(spec: E2eSpec, http: Http, options: { maxAttempts?: number; pollMs?: number; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<TaskOutcome[]> {
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const outcomes: TaskOutcome[] = [];
  let parent: { issueId: string; branch: string; headSha: string; prUrl: string } | undefined;
  for (const task of spec.tasks) {
    let outcome: TaskOutcome | undefined;
    for (let attempt = task.startAttempt ?? 1; attempt < (task.startAttempt ?? 1) + (options.maxAttempts ?? 1); attempt++) {
      const started = Date.now();
      const start = await http("POST", "/v1/runs", { taskId: task.taskId, projectId: spec.projectId, revision: "1", attempt, taskTitle: task.title ?? task.taskId, prompt: task.prompt, approval: false, blockers: [], parentPublications: parent ? [parent] : [] });
      if (start.status !== 202) { outcome = { taskId: task.taskId, attempt, workflowId: "", status: "error", message: `bridge rejected the run (${start.status}): ${JSON.stringify(start.json).slice(0, 300)}`, stages: [], totalSeconds: 0 }; break; }
      const { workflowId } = start.json as { workflowId: string };
      log(`${task.taskId} attempt ${attempt}: started ${workflowId}`);
      let state: { status?: string; progress?: { currentStage?: string }; result?: RunResult } = {};
      do { await sleep(options.pollMs ?? 15_000); state = (await http("GET", `/v1/runs/${encodeURIComponent(workflowId)}`)).json as typeof state; log(`${task.taskId}: ${state.status} ${state.progress?.currentStage ?? ""}`); } while (state.status === "RUNNING");
      const result = state.result;
      outcome = { taskId: task.taskId, attempt, workflowId, status: result?.status ?? "error", message: result?.message ?? `workflow ended as ${state.status}`, ...(result?.metadata?.review.stopReason ? { stopReason: result.metadata.review.stopReason } : {}), ...(result?.publish ? { publish: result.publish } : {}), stages: result ? summarizeStages(result) : [], totalSeconds: Math.round((Date.now() - started) / 1000) };
      if (outcome.status === "completed") break;
    }
    outcomes.push(outcome!);
    if (outcome!.status !== "completed" || !outcome!.publish) break;
    parent = { issueId: task.taskId, branch: outcome!.publish.branch, headSha: outcome!.publish.headSha, prUrl: outcome!.publish.prUrl };
  }
  return outcomes;
}

if (process.argv[1]?.endsWith("e2e.js")) {
  const [specFile, ...flags] = process.argv.slice(2);
  const token = process.env.ORCHESTRATOR_API_TOKEN;
  if (!specFile || !token) { console.error("usage: ORCHESTRATOR_API_TOKEN=... node dist/src/e2e.js <spec.json> [--max-attempts N] [--record <file>]"); process.exit(2); }
  const spec = JSON.parse(await readFile(specFile, "utf8")) as E2eSpec;
  const flag = (name: string) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
  const outcomes = await runChain(spec, bridgeHttp(process.env.ORCHESTRATOR_BRIDGE_URL ?? "http://127.0.0.1:3101", token), { maxAttempts: Number(flag("--max-attempts") ?? 1), log: line => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`) });
  const summary = { schema_version: 1, measured: new Date().toISOString(), projectId: spec.projectId, outcomes, totals: totals(outcomes) };
  console.log(JSON.stringify(summary, null, 2));
  const record = flag("--record"); if (record) await writeFile(record, JSON.stringify(summary, null, 2));
  process.exitCode = outcomes.length === spec.tasks.length && outcomes.every(outcome => outcome.status === "completed") ? 0 : 1;
}
