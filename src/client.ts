import { Client, Connection } from "@temporalio/client";
import { randomUUID } from "node:crypto";
import type { RunInput, RunResult } from "./contracts.js";
import { projectWorkflow, approveSignal, progressQuery } from "./workflows.js";

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
export async function startRun(input: Omit<RunInput, "runId"> & { runId?: string }): Promise<{ workflowId: string; runId: string }> {
  const runId = input.runId ?? randomUUID(); const full = { ...input, runId } as RunInput;
  const id = workflowId(full);
  await withTemporal(async (client) => {
    try { await client.workflow.start(projectWorkflow, { taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "orchestration", workflowId: id, args: [full], workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY", workflowExecutionTimeout: executionTimeoutMs() }); }
    catch (error) { if (!(error instanceof Error) || !error.name.includes("WorkflowExecutionAlreadyStarted")) throw error; }
  });
  return { workflowId: id, runId };
}
export async function inspectRun(id: string): Promise<unknown> { return withTemporal(async c => { const h = c.workflow.getHandle(id); const d = await h.describe(); const progress = d.status.name === "RUNNING" ? await h.query(progressQuery).catch(() => undefined) : undefined; return { workflowId: id, status: d.status.name, startTime: d.startTime, closeTime: d.closeTime, progress, result: d.status.name === "COMPLETED" ? await h.result() : undefined }; }); }
export async function cancelRun(id: string): Promise<void> { await withTemporal(async c => c.workflow.getHandle(id).cancel()); }
export async function signalApproval(id: string, approved: boolean): Promise<void> { await withTemporal(async c => c.workflow.getHandle(id).signal(approveSignal, approved)); }
export async function waitRun(id: string): Promise<RunResult> { return withTemporal(async c => c.workflow.getHandle(id).result()); }
export async function listRuns(): Promise<unknown[]> { return withTemporal(async c => { const rows: unknown[] = []; for await (const h of c.workflow.list()) rows.push({ workflowId: h.workflowId, status: h.status.name }); return rows; }); }
export async function runAndWait(input: Omit<RunInput, "runId"> & { runId?: string }): Promise<RunResult> {
  const runId = input.runId ?? randomUUID(); const full = { ...input, runId } as RunInput; const id = workflowId(full);
  return withTemporal(async c => c.workflow.execute(projectWorkflow, { taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "orchestration", workflowId: id, args: [full], workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY", workflowExecutionTimeout: executionTimeoutMs() }));
}
