// A failed run must not look like a success on the board. Paperclip labels a run `succeeded` unless the adapter returns a failing exit code, and a failing exit code puts the orchestrator's agent into
// error status and can storm (B-097), so the adapter keeps returning 0 and the issue rests in review. The truth is carried by a label on the issue instead: `run-failed` is set when a run fails and
// cleared when a later run reports done or a review state. The label is a hint: any error is swallowed, a report never fails because of it.
import type { ReconcileDeps } from "./reconcile.js";

export const RUN_FAILED_LABEL = "run-failed";
const RUN_FAILED_COLOR = "#dc2626";
type Paperclip = ReconcileDeps["paperclip"];
type Label = { id?: string; name?: string };
const rows = <T>(value: unknown, key: string): T[] => Array.isArray(value) ? value as T[] : Array.isArray((value as Record<string, unknown> | null)?.[key]) ? (value as Record<string, T[]>)[key]! : [];

/** Sets (`failed`) or clears the `run-failed` label of an issue. Idempotent: no write when the issue already is as asked. Never throws. */
export async function syncRunFailedLabel(paperclip: Paperclip | undefined, issueId: string, failed: boolean): Promise<void> {
  if (!paperclip) return;
  try {
    const issue = await paperclip("GET", `/api/issues/${encodeURIComponent(issueId)}`) as { companyId?: string; labelIds?: string[]; labels?: Label[] } | undefined;
    if (!issue?.companyId) return;
    const labels = rows<Label>(await paperclip("GET", `/api/companies/${issue.companyId}/labels`), "labels");
    let label = labels.find(item => item.name === RUN_FAILED_LABEL);
    if (!label && failed) label = await paperclip("POST", `/api/companies/${issue.companyId}/labels`, { name: RUN_FAILED_LABEL, color: RUN_FAILED_COLOR }) as Label | undefined;
    if (!label?.id) return;
    const current = issue.labelIds ?? (issue.labels ?? []).flatMap(item => item.id ? [item.id] : []);
    const has = current.includes(label.id);
    if (has === failed) return;
    await paperclip("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, { labelIds: failed ? [...current, label.id] : current.filter(id => id !== label.id) });
  } catch { /* a label is a hint */ }
}
