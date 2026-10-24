import { Client, Connection } from "@temporalio/client";
import { randomUUID } from "node:crypto";
import type { RunInput, RunResult } from "./contracts.js";
import { projectWorkflow, approveSignal, bootstrapStateQuery, progressQuery } from "./workflows.js";

export async function withTemporal<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
  try { return await fn(new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" })); }
  finally { await connection.close(); }
}
/** Hard wall-clock cap for one run (default 48h) so a stuck workflow cannot live forever. */
export function executionTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.ORCHESTRATOR_WORKFLOW_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 172_800_000;
}
export function workflowId(input: Pick<RunInput, "taskId" | "taskRevision" | "attempt" | "runId">): string { return `pc-${input.taskId}-${input.taskRevision ?? "1"}-a${input.attempt ?? 1}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 180); }
/** Start the workflow, or attach to the live/completed one that already owns this workflow ID. `runId` is the Temporal execution that actually runs the task. */
export async function startOrAttach(client: Client, id: string, input: RunInput): Promise<{ runId: string; alreadyStarted: boolean }> {
  try {
    const handle = await client.workflow.start(projectWorkflow, { taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "orchestration", workflowId: id, args: [input], workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY", workflowExecutionTimeout: executionTimeoutMs() });
    return { runId: handle.firstExecutionRunId, alreadyStarted: false };
  } catch (error) {
    if (!(error instanceof Error) || !error.name.includes("WorkflowExecutionAlreadyStarted")) throw error;
    return { runId: (await client.workflow.getHandle(id).describe()).runId, alreadyStarted: true };
  }
}
export async function startRun(input: Omit<RunInput, "runId"> & { runId?: string }): Promise<{ workflowId: string; runId: string; alreadyStarted: boolean }> {
  const full = { ...input, runId: input.runId ?? randomUUID() } as RunInput;
  const id = workflowId(full);
  const started = await withTemporal(client => startOrAttach(client, id, full));
  return { workflowId: id, ...started };
}
export async function inspectRun(id: string): Promise<unknown> { return withTemporal(async c => { const h = c.workflow.getHandle(id); const d = await h.describe(); const progress = d.status.name === "RUNNING" ? await h.query(progressQuery).catch(() => undefined) : undefined; const bootstrap = d.status.name === "RUNNING" ? await h.query(bootstrapStateQuery).catch(() => undefined) : undefined; return { workflowId: id, status: d.status.name, startTime: d.startTime, closeTime: d.closeTime, progress, ...(bootstrap ? { bootstrap } : {}), result: d.status.name === "COMPLETED" ? await h.result() : undefined }; }); }
export async function cancelRun(id: string): Promise<void> { await withTemporal(async c => c.workflow.getHandle(id).cancel()); }
export async function signalApproval(id: string, approved: boolean): Promise<void> { await withTemporal(async c => c.workflow.getHandle(id).signal(approveSignal, approved)); }
export async function waitRun(id: string): Promise<RunResult> { return withTemporal(async c => c.workflow.getHandle(id).result()); }
export async function listRuns(): Promise<unknown[]> { return withTemporal(async c => { const rows: unknown[] = []; for await (const h of c.workflow.list()) rows.push({ workflowId: h.workflowId, status: h.status.name }); return rows; }); }
export async function runAndWait(input: Omit<RunInput, "runId"> & { runId?: string }): Promise<RunResult> {
  const runId = input.runId ?? randomUUID(); const full = { ...input, runId } as RunInput; const id = workflowId(full);
  return withTemporal(async c => c.workflow.execute(projectWorkflow, { taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "orchestration", workflowId: id, args: [full], workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY", workflowExecutionTimeout: executionTimeoutMs() }));
}

/** `<id>-resume1`, `<id>-resume2` ...: the next free id for resuming a workflow (a resumed run keeps the original run id and input, only the Temporal workflow id is new). */
export function nextResumeId(originalId: string, existing: string[]): string {
  const base = originalId.replace(/-resume\d+$/, "");
  const prefix = `${base}-resume`;
  const used = existing.filter(id => id.startsWith(prefix)).map(id => Number(id.slice(prefix.length))).filter(Number.isInteger);
  return `${prefix}${Math.max(0, ...used) + 1}`;
}

/**
 * Resume a finished (failed) run from where it stopped. The new workflow gets the original input and the original run id, so the activities find the preserved worktree and the
 * saved stage results (`artifacts/<task>/<run id>/<stage>-<n>.json`) and skip every stage whose input is unchanged; only the stage that failed, and what follows it, executes.
 * The workflow id keeps the issue-id prefix, so `reconcile` reports the result to Paperclip like any other run.
 */
export async function resumeRun(originalId: string): Promise<{ workflowId: string; runId: string; originalRunId: string; alreadyStarted: boolean }> {
  return withTemporal(async client => {
    const history = await client.workflow.getHandle(originalId).fetchHistory();
    const started = history.events?.find(event => event.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes;
    const payload = started?.input?.payloads?.[0];
    if (!payload?.data) throw new Error(`workflow ${originalId} has no readable start input`);
    const input = JSON.parse(Buffer.from(payload.data).toString("utf8")) as RunInput;
    const base = originalId.replace(/-resume\d+$/, "");
    const existing: string[] = [];
    for await (const row of client.workflow.list({ query: `WorkflowId STARTS_WITH "${base}"` })) existing.push(row.workflowId);
    const id = nextResumeId(originalId, existing);
    const result = await startOrAttach(client, id, input);
    return { workflowId: id, runId: result.runId, originalRunId: input.runId, alreadyStarted: result.alreadyStarted };
  });
}
