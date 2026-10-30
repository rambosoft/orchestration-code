import type { RunResult } from "./contracts.js";
import { classifyFailure, isResumable, MAX_AUTO_RESUMES, type FailureClass } from "./failure-class.js";

// Reconcile (FM-037): when the machine sleeps, shuts down or loses the network, Temporal keeps the workflow alive and finishes it, but the Paperclip adapter that
// would have reported the result is gone, and Paperclip marks the task blocked ("requires reconciliation"). This reads what Temporal finished and reports it to
// Paperclip the way the adapter would have: the result as a comment (with the publication marker the next task's dependency check needs) and the status.
// It is idempotent (a result already reported is skipped) and never touches a run that is still going.
export type RunRow = { workflowId: string; status: string };
export type PaperclipRunRow = { status?: string; startedAt?: string; execution?: { phase?: string; cause?: string }; errorCode?: string };
export type RunDetail = { status: string; closeTime?: string; result?: RunResult };
export type IssueRow = {
  id: string;
  identifier?: string;
  title?: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  blockedBy?: Array<{ id?: string; status?: string }>;
  /** Paperclip has an execution whose outcome requires an operator; never auto-resume behind this hold. */
  executionBlocker?: { recoveryActionId?: string; runId?: string; cause?: string } | null;
};
export type ReconcileDeps = {
  paperclip: <T>(method: "GET" | "POST" | "PATCH", route: string, body?: unknown) => Promise<T>;
  listRuns: () => Promise<RunRow[]>;
  inspect: (workflowId: string) => Promise<RunDetail>;
  /** Starts a resumed workflow for a failed one (saved stage results are reused) and returns its id. Needed for `autoResume`. */
  resume?: (workflowId: string) => Promise<string>;
};
export type Finding = { issue: string; workflowId?: string; workflowStatus?: string; action: "reported" | "would_report" | "running" | "already_reported" | "failed_run" | "no_run" | "auto_resumed" | "would_resume" | "retried_dependency_wake" | "would_retry_dependency_wake" | "dependency_ready_missing_publication" | "dependency_ready_recovery_required" | "recovery_required" | "stale_failure_suppressed"; status?: string; detail: string };

/** A failed run is resumed on its own only when the failure is transient or caused by the machine, at most once, and only while it is recent. */
export const AUTO_RESUME_WINDOW_MINUTES = 360;
export type ResumeDecision = { resume: boolean; reason: string; failure: FailureClass };
export function autoResumeDecision(workflowId: string, result: RunResult, closeTime: string | undefined, now: Date, windowMinutes = AUTO_RESUME_WINDOW_MINUTES): ResumeDecision {
  const lastStage = result.stages.at(-1);
  const failure = classifyFailure({ message: result.message, ...(result.metadata?.review?.stopReason ? { stopReason: result.metadata.review.stopReason } : {}), findings: lastStage ? [lastStage.summary, ...lastStage.findings] : [] });
  if (result.status !== "failed") return { resume: false, reason: "the run did not fail", failure };
  if (!isResumable(failure)) return { resume: false, reason: `${failure.kind} failure: ${failure.reason}`, failure };
  const resumes = Number(/-resume(\d+)$/.exec(workflowId)?.[1] ?? 0);
  if (resumes >= MAX_AUTO_RESUMES) return { resume: false, reason: `this run was already resumed ${resumes} time(s); a person should look at it`, failure };
  if (closeTime && now.getTime() - new Date(closeTime).getTime() > windowMinutes * 60_000) return { resume: false, reason: `it ended more than ${windowMinutes} minutes ago; resume it by hand if it is still wanted`, failure };
  return { resume: true, reason: `${failure.kind} failure: ${failure.reason}`, failure };
}

/** Statuses a lost adapter leaves behind. */
export const CANDIDATE_STATUSES = ["blocked", "in_progress", "in_review"];

export function latestRun(rows: RunRow[], issueId: string): RunRow | undefined {
  const mine = rows.filter(row => row.workflowId.startsWith(`pc-${issueId}-`));
  return mine.find(row => row.status === "RUNNING") ?? [...mine].sort((a, b) => b.workflowId.localeCompare(a.workflowId))[0];
}

/** The Paperclip status the adapter would set for a finished run, or undefined when the result alone does not decide it. */
export function statusFor(result: RunResult | undefined): string | undefined {
  if (!result) return undefined;
  const isBootstrap = result.metadata?.taskType === "bootstrap";
  if (result.status === "completed" && ((result.publish?.prUrl && result.publish.headSha) || result.bootstrap)) return "done";
  if (result.status === "needs_review" && result.publish?.prUrl) return "in_review";
  if (result.status === "needs_info") return "in_review";
  if (result.status === "rejected" && isBootstrap) return "cancelled";
  return undefined;
}

export function resultComment(workflowId: string, status: string, result: RunResult | undefined, source: "reconcile" | "worker" = "reconcile"): string {
  const body = result?.report?.markdown ? `### ${result.report.title}\n\n${String(result.report.markdown).slice(0, 30_000)}` : (result?.stages ?? []).map(stage => `${stage.stage}: ${String(stage.summary).slice(0, 400)}`).join("\n");
  const publish = result?.publish;
  const publication = publish ? `\n\nBranch: \`${publish.branch}\`\nHead SHA: \`${publish.headSha}\`\nDraft PR: ${publish.prUrl} (base \`${publish.prBaseBranch}\`)\nDone means gates passed and the draft PR was created; it does not mean merged.` : "";
  const open = result?.status === "needs_review" ? (result.metadata?.review.unresolvedFindings ?? []).map((finding, index) => `${index + 1}. [${finding.severity}/${finding.category}] ${finding.title}`).join("\n") : "";
  const decision = open ? `\n\n### Decision needed\nThe tests and build pass and the draft PR is published, but the automated review still has unresolved findings (also posted as a comment on the PR):\n${open}` : "";
  const marker = publish ? `\n<!-- orchestration-publish ${JSON.stringify(publish)} -->` : "";
  return `Temporal workflow \`${workflowId}\` finished with status **${result?.status ?? status}**. ${result?.message ?? status}${body ? `\n\n${body}` : ""}${publication}${decision}\n\n${source === "worker" ? "_Reported by the orchestrator worker when the workflow finished._" : "_Reported by the orchestrator's reconcile step: Paperclip had lost its connection to this run (for example the machine was off), but the workflow finished._"}${marker}`;
}

/**
 * Paperclip normally wakes a blocked task when its last blocker reaches done. If that wake
 * races with a follow-up run on the blocker, the adapter correctly refuses dispatch, but the
 * wake itself is terminal. Reasserting the unchanged first-class blocker set asks Paperclip to
 * re-evaluate readiness and emit its idempotent dependency wake again. Never clear blockers or
 * move the task to todo here: Paperclip remains the authority on whether it is runnable.
 */
async function retryReadyDependencyWake(deps: ReconcileDeps, issue: IssueRow, apply: boolean): Promise<Finding | undefined> {
  if (issue.status !== "blocked" || !issue.assigneeAgentId || issue.assigneeUserId) return undefined;
  const current = await deps.paperclip<IssueRow>("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
  if (current.status !== "blocked" || !current.assigneeAgentId || current.assigneeUserId) return undefined;
  const blockerIds = (current.blockedBy ?? []).map(blocker => blocker.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  const blockers = current.blockedBy ?? [];
  if (!blockerIds.length || blockerIds.length !== blockers.length || blockers.some(blocker => blocker.status !== "done")) return undefined;
  const name = current.identifier ?? current.id;
  const paperclipRuns = rows<{ status?: string; execution?: { phase?: string; cause?: string }; errorCode?: string }>(
    await deps.paperclip("GET", `/api/issues/${encodeURIComponent(current.id)}/runs`), "runs",
  );
  const heldRun = paperclipRuns.find(run => run.execution?.phase === "recovery_needed" || run.execution?.cause === "legacy_execution_requires_reconciliation");
  if (heldRun) return { issue: name, action: "dependency_ready_recovery_required", status: "blocked", detail: "Paperclip has an unresolved execution-reconciliation hold; preserving the task and waiting for its supported recovery action instead of emitting repeated wake requests" };
  for (const blockerId of blockerIds) {
    const comments = rows<{ body?: string }>(await deps.paperclip("GET", `/api/issues/${encodeURIComponent(blockerId)}/comments?order=desc&limit=50`), "comments");
    if (!comments.some(comment => hasPublicationMarker(String(comment.body ?? "")))) {
      return { issue: name, action: "dependency_ready_missing_publication", status: "blocked", detail: `all blockers are done, but ${blockerId} has no verified orchestration publication; refusing to wake a task whose dependency base cannot be assembled` };
    }
  }
  const detail = `all ${blockerIds.length} first-class blocker(s) are done; reasserting the unchanged blocker edges so Paperclip can retry its dependency wake`;
  if (!apply) return { issue: name, action: "would_retry_dependency_wake", status: "blocked", detail };
  await deps.paperclip("PATCH", `/api/issues/${encodeURIComponent(current.id)}`, { status: "blocked", blockedByIssueIds: blockerIds });
  return { issue: name, action: "retried_dependency_wake", status: "blocked", detail };
}

function hasPublicationMarker(body: string): boolean {
  const match = body.match(/<!-- orchestration-publish (\{[^\n]*\}) -->/);
  if (!match) return false;
  try {
    const publication = JSON.parse(match[1]!) as { branch?: unknown; headSha?: unknown; prUrl?: unknown };
    return typeof publication.branch === "string" && /^[0-9a-f]{40,64}$/i.test(String(publication.headSha ?? "")) && typeof publication.prUrl === "string" && new URL(publication.prUrl).protocol === "https:";
  } catch { return false; }
}

const rows = <T>(value: unknown, key: string): T[] => Array.isArray(value) ? value as T[] : Array.isArray((value as Record<string, unknown> | null)?.[key]) ? (value as Record<string, T[]>)[key]! : [];

/** Only runs that ended within `days` days are considered, so old history is never rewritten. */
export const DEFAULT_WINDOW_DAYS = 3;

export async function reconcile(deps: ReconcileDeps, options: { apply: boolean; days?: number; now?: Date; /** Only this task (identifier such as LOC-65, or id). */ only?: string; /** Resume a run that failed for a transient or machine reason (src/failure-class.ts), once, instead of only reporting it. */ autoResume?: boolean }): Promise<Finding[]> {
  const cutoff = (options.now ?? new Date()).getTime() - (options.days ?? DEFAULT_WINDOW_DAYS) * 86_400_000;
  const findings: Finding[] = [];
  const runs = await deps.listRuns();
  for (const company of await deps.paperclip<Array<{ id: string }>>("GET", "/api/companies")) {
    const issues = rows<IssueRow>(await deps.paperclip("GET", `/api/companies/${company.id}/issues?limit=500`), "issues").filter(issue => CANDIDATE_STATUSES.includes(issue.status));
    for (const issue of issues) {
      const name = issue.identifier ?? issue.id;
      if (options.only && options.only !== issue.id && options.only.toUpperCase() !== String(issue.identifier).toUpperCase()) continue;
      const run = latestRun(runs, issue.id);
      // Paperclip's dependency wake can race a follow-up run on the blocker. The adapter then
      // safely withholds dispatch, but without this backstop a failed wake leaves a ready task
      // blocked forever. Only retry when no Temporal run owns this task; normal run reconciliation
      // remains responsible for any started workflow.
      if (!run && issue.status === "blocked") {
        const retry = await retryReadyDependencyWake(deps, issue, options.apply);
        if (retry) { findings.push(retry); continue; }
      }
      if (!run) continue;
      if (run.status === "RUNNING") { findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: run.status, action: "running", detail: "the workflow is still running; Temporal keeps it going and the next reconcile will report it" }); continue; }
      const detail = await deps.inspect(run.workflowId);
      // closeTime is an ISO string over HTTP and a Date when the Temporal client is called directly.
      if (detail.closeTime && new Date(detail.closeTime).getTime() < cutoff) continue;
      if (detail.status === "COMPLETED" && detail.result?.status === "failed" && issue.executionBlocker) {
        findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "recovery_required", status: issue.status, detail: `Paperclip recovery hold ${issue.executionBlocker.recoveryActionId ?? "(id unavailable)"} for run ${issue.executionBlocker.runId ?? "(run unavailable)"} must be resolved before retry or reporting this stale failure` });
        continue;
      }
      if (detail.status === "COMPLETED" && detail.result?.status === "failed" && issue.status === "in_review") {
        findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "stale_failure_suppressed", status: issue.status, detail: "the task is already awaiting review; suppressing automatic resume and duplicate failure comments" });
        continue;
      }
      // A failure that is not about the code (a timeout, a locked project, a long path) is resumed from where it stopped. Nothing is posted to the task: a comment wakes the agent and
      // can lock the issue (FM-054); the resumed run reports its own result like any other.
      // Do not race a Paperclip recovery hold (or restart work that is already awaiting review).
      // A stale Temporal failure can outlive a later successful attempt; Paperclip's blocker and
      // review state are authoritative and require explicit reconciliation before another run.
      if (options.autoResume && deps.resume && detail.status === "COMPLETED" && detail.result?.status === "failed"
        && !issue.executionBlocker && issue.status !== "in_review") {
        // A Paperclip run can finish successfully after this Temporal workflow failed (for
        // example, a later recovery run publishes a PR). The older workflow may still be
        // present in history; never resurrect it over that newer result.
        const paperclipRuns = rows<PaperclipRunRow>(await deps.paperclip("GET", `/api/issues/${encodeURIComponent(issue.id)}/runs`), "runs");
        const newerSuccess = paperclipRuns.find(candidate => candidate.status === "succeeded" && candidate.startedAt
          && detail.closeTime && new Date(candidate.startedAt).getTime() > new Date(detail.closeTime).getTime());
        if (newerSuccess) {
          findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "stale_failure_suppressed", status: issue.status, detail: `a newer Paperclip run (${newerSuccess.startedAt}) already succeeded; suppressing automatic resume of this older failure` });
          continue;
        }
        const decision = autoResumeDecision(run.workflowId, detail.result, detail.closeTime, options.now ?? new Date());
        if (decision.resume) {
          if (!options.apply) { findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "would_resume", detail: decision.reason }); continue; }
          try {
            const resumed = await deps.resume(run.workflowId);
            findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "auto_resumed", detail: `resumed as ${resumed}: ${decision.reason}` });
            continue;
          } catch (error) {
            findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "failed_run", detail: `automatic resume failed (${error instanceof Error ? error.message.slice(0, 200) : String(error)}); resume it by hand with npm run resume-run` });
            continue;
          }
        }
      }
      const comments = rows<{ body?: string }>(await deps.paperclip("GET", `/api/issues/${issue.id}/comments?limit=100`), "comments");
      if (comments.some(comment => String(comment.body ?? "").includes(`Temporal workflow \`${run.workflowId}\` finished`))) { findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "already_reported", detail: "the result was already reported to the task" }); continue; }
      if (detail.status !== "COMPLETED" || !detail.result) {
        findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "failed_run", detail: `the workflow ended as ${detail.status} without a result; retry the task from Paperclip (a new attempt starts a new workflow)` });
        continue;
      }
      const status = statusFor(detail.result);
      const note = `${detail.result.status}: ${detail.result.message.slice(0, 160)}`;
      if (!options.apply) { findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "would_report", ...(status ? { status } : {}), detail: `${note}${status ? ` -> ${status}` : " (comment only)"}` }); continue; }
      const comment = resultComment(run.workflowId, detail.status, detail.result);
      if (status) await deps.paperclip("PATCH", `/api/issues/${issue.id}`, { status, comment });
      else await deps.paperclip("POST", `/api/issues/${issue.id}/comments`, { body: comment });
      findings.push({ issue: name, workflowId: run.workflowId, workflowStatus: detail.status, action: "reported", ...(status ? { status } : {}), detail: `${note}${status ? ` -> ${status}` : " (comment only)"}` });
    }
  }
  return findings;
}

export function formatFindings(findings: Finding[], apply: boolean): string {
  if (!findings.length) return "nothing to reconcile: no finished workflow or stranded ready dependency wake was found";
  return [...findings.map(finding => `${finding.action.padEnd(16)} ${finding.issue.padEnd(8)} ${finding.detail}`), ...(apply ? [] : ["(dry run: nothing was changed; run with --apply to report these results)"])].join("\n");
}
