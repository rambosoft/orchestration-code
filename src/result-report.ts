// The worker reports a finished run to Paperclip itself (ADR 0018), so the result no longer depends on the adapter still holding its lease when the workflow ends. It is the same report the adapter
// and the reconcile step write (the same status mapping and comment, found by the same "Temporal workflow `<id>` finished" text), so whichever reaches the task first wins and the others see it done.
// Only outcomes that change the task for a person are reported here: done, in review, needs information. A failed run is never commented on by the worker: a comment wakes the agent and can lock
// the issue (FM-054), and failures belong to the resume and reconcile path.
import type { RunResult } from "./contracts.js";
import { resultComment, statusFor, statusPatch, type ReconcileDeps } from "./reconcile.js";

export type ReportOutcome = { reported: boolean; reason: "reported" | "already_reported" | "no_status" | "bootstrap" | "not_configured" };
const rows = <T>(value: unknown, key: string): T[] => Array.isArray(value) ? value as T[] : Array.isArray((value as Record<string, unknown> | null)?.[key]) ? (value as Record<string, T[]>)[key]! : [];

/** Posts the result of `workflowId` to its issue unless it is already there. Idempotent: running it twice (an activity retry) posts once. */
export async function reportResultTo(paperclip: ReconcileDeps["paperclip"] | undefined, input: { workflowId: string; issueId: string; result: RunResult }): Promise<ReportOutcome> {
  if (!paperclip) return { reported: false, reason: "not_configured" };
  if (input.result.metadata?.taskType === "bootstrap") return { reported: false, reason: "bootstrap" };
  const status = statusFor(input.result);
  if (!status) return { reported: false, reason: "no_status" };
  const comments = rows<{ body?: string }>(await paperclip("GET", `/api/issues/${encodeURIComponent(input.issueId)}/comments?limit=100`), "comments");
  if (comments.some(comment => String(comment.body ?? "").includes(`Temporal workflow \`${input.workflowId}\` finished`))) return { reported: true, reason: "already_reported" };
  await paperclip("PATCH", `/api/issues/${encodeURIComponent(input.issueId)}`, statusPatch(status, resultComment(input.workflowId, input.result.status, input.result, "worker"), input.result));
  return { reported: true, reason: "reported" };
}
