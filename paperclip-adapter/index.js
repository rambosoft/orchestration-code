import { createHash } from "node:crypto";

export const type = "temporal_orchestrator";
export const label = "Temporal Orchestrator";
export const models = [{ id: "workflow", label: "Temporal workflow (stage providers selected by project manifest)" }];
export const agentConfigurationDoc = `# Temporal Orchestrator\n\nConfigure bridgeUrl, bridgeToken, and profile. The adapter selects the project from the assigned Paperclip issue and submits it to Temporal; each project must have a matching orchestrator manifest and workspace mounts. A configured projectId is an optional fallback only for legacy unscoped issues. Stage-level provider and model routes are controlled by each project's manifest. The task type comes from an issue label (type:bug, type:research, type:architecture, type:task or a bare bug/spike label), else a standalone “Type: bug” line in the task, else the agent profile; bugs are diagnosed and reproduced before the fix, research and architecture tasks only produce a report (draft PR plus comment), and a type:bootstrap task (created by the Project Bootstrap plugin) plans a whole project, waits for approval, then creates its repository, orchestrator manifest and tasks. OpenSpec is enabled by default per project; add a standalone “OpenSpec: off” or “OpenSpec: on” line in a task to override it. Provider credentials remain on the Windows Temporal worker.`;

export function resolveProjectId(issue, configuredProjectId) {
  const issueProjectId = typeof issue?.projectId === "string" ? issue.projectId.trim() : "";
  const fallbackProjectId = typeof configuredProjectId === "string" ? configuredProjectId.trim() : "";
  return issueProjectId || fallbackProjectId || undefined;
}

export function parseOpenSpecTaskMarker(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const directives = lines.map((line, index) => ({ index, match: /^\s*OpenSpec\s*:\s*(on|off)\s*$/i.exec(line) }))
    .filter(item => item.match !== null);
  const values = new Set(directives.map(item => item.match[1].toLowerCase() === "on"));
  if (values.size > 1) return { text: String(text ?? ""), error: "task contains conflicting OpenSpec on/off directives" };
  const removed = new Set(directives.map(item => item.index));
  const clean = lines.filter((_line, index) => !removed.has(index)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean, ...(directives.length ? { openSpec: values.has(true) } : {}) };
}

export function issueLabelNames(issue) {
  const rows = Array.isArray(issue?.labels) ? issue.labels : [];
  return rows.map(label => String(typeof label === "string" ? label : label?.name ?? "").trim()).filter(Boolean).slice(0, 50);
}

/** A task that started this many runs within the window is looping (a failure that wakes itself again): stop starting more and hand it to a person (ADR 0022). */
const STORM_RUNS = 6; const STORM_WINDOW_MS = 30 * 60_000;
async function recentRunCount(ctx, issueId) {
  const token = String(ctx.authToken ?? ctx.config.paperclipApiToken ?? process.env.PAPERCLIP_API_TOKEN ?? "");
  if (!token || !issueId) return 0;
  const base = String(ctx.config.paperclipApiUrl ?? "http://paperclip:3100").replace(/\/$/, "");
  const response = await fetch(`${base}/api/issues/${encodeURIComponent(issueId)}/runs`, { headers: { authorization: `Bearer ${token}` }, signal: ctx.signal });
  if (!response.ok) return 0;
  const payload = await response.json();
  const runs = Array.isArray(payload) ? payload : Array.isArray(payload?.runs) ? payload.runs : [];
  const since = Date.now() - STORM_WINDOW_MS;
  return runs.filter(run => String(run.runId ?? run.id ?? "") !== String(ctx.runId) && Date.parse(String(run.startedAt ?? run.createdAt ?? "")) >= since).length;
}

async function addIssueComment(ctx, issueId, body) {
  const token = String(ctx.authToken ?? ctx.config.paperclipApiToken ?? process.env.PAPERCLIP_API_TOKEN ?? "");
  if (!token || !issueId) {
    await ctx.onLog("stderr", "Paperclip run token or issue ID unavailable; result comment was not posted.\n");
    return false;
  }
  const base = String(ctx.config.paperclipApiUrl ?? "http://paperclip:3100").replace(/\/$/, "");
  const response = await fetch(`${base}/api/issues/${encodeURIComponent(issueId)}/comments`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-paperclip-run-id": ctx.runId }, body: JSON.stringify({ body }), signal: ctx.signal });
  if (!response.ok) throw new Error(`Paperclip comment API returned ${response.status}: ${await response.text()}`);
  return true;
}

async function deferForDependencies(ctx, issueId, blockerIds) {
  const token = String(ctx.authToken ?? ctx.config.paperclipApiToken ?? process.env.PAPERCLIP_API_TOKEN ?? "");
  if (!token) throw new Error("Paperclip run token unavailable; cannot safely return a dependency-blocked task to the queue");
  const base = String(ctx.config.paperclipApiUrl ?? "http://paperclip:3100").replace(/\/$/, "");
  const response = await fetch(`${base}/api/issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-paperclip-run-id": ctx.runId },
    body: JSON.stringify({ status: "blocked", blockedByIssueIds: blockerIds }),
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`Could not defer task behind its Paperclip dependencies (${response.status}): ${(await response.text()).slice(0, 300)}`);
}

function publicationFromComments(comments) {
  const rows = Array.isArray(comments) ? comments : Array.isArray(comments?.comments) ? comments.comments : [];
  for (const row of rows) {
    const body = String(row?.body ?? row?.text ?? "");
    const match = body.match(/<!-- orchestration-publish (\{[^\n]*\}) -->/);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      if (typeof value.branch === "string" && /^[0-9a-f]{40,64}$/i.test(value.headSha ?? "") && typeof value.prUrl === "string") return value;
    } catch { /* skip malformed historical comment */ }
  }
  return null;
}

// Paperclip comments are a useful publication index, but they can lag behind
// Temporal when the adapter loses its lease after the workflow has published.
// Reconcile against completed workflow results before admitting a dependent.
async function publicationFromTemporal(ctx, blockerId, base, token) {
  const headers = { authorization: `Bearer ${token}` };
  const response = await fetch(`${base}/v1/runs`, { headers, signal: ctx.signal });
  if (!response.ok) throw new Error(`Could not inspect Temporal publications (${response.status})`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.runs) ? payload.runs : [];
  const candidates = rows.filter(row => row?.status === "COMPLETED" && String(row.workflowId ?? "").startsWith(`pc-${blockerId}-`));
  const publications = [];
  for (const row of candidates) {
    const detailResponse = await fetch(`${base}/v1/runs/${encodeURIComponent(row.workflowId)}`, { headers, signal: ctx.signal });
    if (!detailResponse.ok) continue;
    const detail = await detailResponse.json();
    const result = detail?.result;
    const publication = result?.publish;
    if (detail?.status !== "COMPLETED" || !["completed", "needs_review"].includes(result?.status)) continue;
    if (typeof publication?.branch === "string" && /^[0-9a-f]{40,64}$/i.test(publication.headSha ?? "") && typeof publication.prUrl === "string") {
      publications.push({ publication, startedAt: String(detail.startTime ?? "") });
    }
  }
  publications.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return publications[0]?.publication ?? null;
}

/** Prefer the task's latest published review workflow when Paperclip delivers
 * a stale retry after another run already produced a PR. Otherwise resume only
 * the failed workflow explicitly linked to this continuation's source run.
 */
async function workflowForContinuation(ctx, issueId, base, token) {
  const continuation = ctx.executionContinuation;
  const reason = String(continuation?.trigger?.reason ?? "");
  const sourceRunId = continuation?.trigger?.sourceRunId;
  if (!sourceRunId || !/retry|recover|failed/i.test(reason)) return null;
  const [commentsResponse, runsResponse] = await Promise.all([
    fetch(`${base}/api/issues/${encodeURIComponent(issueId)}/comments?order=desc&limit=100`, {
      headers: { authorization: `Bearer ${token}` }, signal: ctx.signal,
    }),
    fetch(`${base}/api/issues/${encodeURIComponent(issueId)}/runs`, {
      headers: { authorization: `Bearer ${token}` }, signal: ctx.signal,
    }),
  ]);
  if (!commentsResponse.ok) throw new Error(`Could not inspect retry source comments (${commentsResponse.status})`);
  if (!runsResponse.ok) throw new Error(`Could not inspect retry source runs (${runsResponse.status})`);
  const commentPayload = await commentsResponse.json();
  const comments = Array.isArray(commentPayload) ? commentPayload : Array.isArray(commentPayload?.comments) ? commentPayload.comments : [];
  const runsPayload = await runsResponse.json();
  const runs = Array.isArray(runsPayload) ? runsPayload : Array.isArray(runsPayload?.runs) ? runsPayload.runs : [];

  // A Paperclip retry may be delivered after a sibling attempt already
  // succeeded and published. Reuse that exact workflow so review/verification
  // can continue against its branch, instead of replaying an older empty tree.
  const successfulReviews = runs
    .filter(run => run.runId !== sourceRunId && run.status === "succeeded")
    .map(run => {
      const comment = comments.find(item => String(item.createdByRunId ?? "") === String(run.runId));
      const match = String(comment?.body ?? "").match(/Temporal workflow `([^`]+)` finished with status \*\*needs_review\*\*/);
      const publication = String(comment?.body ?? "").includes("<!-- orchestration-publish ");
      return match && publication && match[1].startsWith(`pc-${issueId}-`) ? { run, workflowId: match[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.run.finishedAt ?? b.run.startedAt ?? "").localeCompare(String(a.run.finishedAt ?? a.run.startedAt ?? "")));
  if (successfulReviews.length) return { workflowId: successfulReviews[0].workflowId, reusedPublishedReview: true };

  // Paperclip can link a recovery continuation to an older retry ancestor even
  // when a newer sibling already completed a Temporal workflow. Resume the
  // newest failed Temporal workflow for this issue so its worktree and passing
  // stages are reused instead of rolling back to an empty earlier attempt.
  const failedWorkflows = runs
    .filter(run => run.status === "failed")
    .map(run => {
      const comment = comments.find(item => String(item.createdByRunId ?? "") === String(run.runId));
      const match = String(comment?.body ?? "").match(/Temporal workflow `([^`]+)` finished with status \*\*failed\*\*/);
      return match && match[1].startsWith(`pc-${issueId}-`) ? { run, workflowId: match[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.run.finishedAt ?? b.run.startedAt ?? "").localeCompare(String(a.run.finishedAt ?? a.run.startedAt ?? "")));
  if (failedWorkflows.length) return { workflowId: failedWorkflows[0].workflowId, reusedPublishedReview: false };

  const source = comments.find(comment => String(comment.createdByRunId ?? "") === String(sourceRunId));
  const match = String(source?.body ?? "").match(/Temporal workflow `([^`]+)` finished with status \*\*failed\*\*/);
  if (!match || !match[1].startsWith(`pc-${issueId}-`)) return null;
  return { workflowId: match[1], reusedPublishedReview: false };
}

export function createServerAdapter() {
  return {
    type,
    models,
    agentConfigurationDoc,
    async testEnvironment(ctx) {
      const base = String(ctx.config.bridgeUrl ?? "http://orchestrator:3101").replace(/\/$/, "");
      try {
        const bridgeToken = String(ctx.config.bridgeToken ?? process.env.ORCHESTRATOR_API_TOKEN ?? "");
        const response = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${bridgeToken}` }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) return { adapterType: type, status: "fail", checks: [{ level: "error", message: `Bridge health check returned ${response.status}`, code: "bridge_unavailable" }], testedAt: new Date().toISOString() };
        return { adapterType: type, status: "pass", checks: [{ level: "info", message: "Temporal orchestration bridge reachable", code: "bridge_ready" }], testedAt: new Date().toISOString() };
      } catch (error) {
        return { adapterType: type, status: "fail", checks: [{ level: "error", message: "Temporal orchestration bridge is unreachable", detail: String(error), code: "bridge_unavailable" }], testedAt: new Date().toISOString() };
      }
    },
    async execute(ctx) {
      const base = String(ctx.config.bridgeUrl ?? "http://orchestrator:3101").replace(/\/$/, "");
      const bridgeToken = String(ctx.config.bridgeToken ?? process.env.ORCHESTRATOR_API_TOKEN ?? "");
      const taskId = String(ctx.context.taskId ?? ctx.context.issueId ?? "");
      if (!taskId) return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Paperclip task ID missing from adapter context" };
      let taskTitle = ctx.context.taskTitle;
      let taskDescription = ctx.context.taskDescription;
      let taskPrompt = ctx.context.prompt;
      let issue = null;
      let issueLoaded = false;
      const paperclipApiUrl = String(ctx.config.paperclipApiUrl ?? "http://paperclip:3100").replace(/\/$/, "");
      const paperclipToken = String(ctx.authToken ?? ctx.config.paperclipApiToken ?? process.env.PAPERCLIP_API_TOKEN ?? "");
      let revision = ctx.context.updatedAt ?? ctx.context.taskRevision ?? null;
      if (paperclipToken) {
        try {
          // Read the current issue revision on every dispatch. Older Paperclip
          // heartbeat contexts omit updatedAt, which made every retry fall
          // back to revision "1" and attach to the same completed Temporal run.
          const issueResponse = await fetch(`${paperclipApiUrl}/api/issues/${encodeURIComponent(String(ctx.context.issueId ?? taskId))}`, {
            headers: { authorization: `Bearer ${paperclipToken}` }, signal: ctx.signal,
          });
          if (issueResponse.ok) {
            issue = await issueResponse.json();
            issueLoaded = true;
            taskTitle ??= issue.title;
            taskDescription ??= issue.description;
            revision ??= issue.updatedAt ?? issue.statusVersion ?? null;
          } else {
            await ctx.onLog("stderr", `Could not load Paperclip task details or revision (${issueResponse.status}).\n`);
          }
        } catch (error) {
          if (ctx.signal?.aborted) throw error;
          await ctx.onLog("stderr", `Could not load Paperclip task details or revision: ${String(error)}\n`);
        }
      }
      // Never silently map an unversioned dispatch to revision "1": after a
      // terminal Temporal failure that would attach to the same failed
      // Workflow ID and make Paperclip appear to retry without doing work.
      if (revision == null || String(revision).trim() === "") {
        return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Cannot safely start Temporal workflow: current Paperclip task revision is unavailable (issue API lookup failed and adapter context has no explicit revision)" };
      }
      if (!issueLoaded) return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Cannot safely dispatch: Paperclip issue details and current blocker list could not be verified" };
      const projectId = resolveProjectId(issue, ctx.config.projectId);
      if (!projectId) return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Cannot safely dispatch: the Paperclip issue has no project and the orchestrator agent has no legacy projectId fallback" };
      if (issue?.executionBlocker?.recoveryActionId) {
        return { exitCode: 1, signal: null, timedOut: false, errorMessage: `Cannot safely dispatch: Paperclip execution recovery is held for run ${issue.executionBlocker.runId ?? "unknown"} (action ${issue.executionBlocker.recoveryActionId}); a board operator must resolve the recovery record first` };
      }
      const recentRuns = await recentRunCount(ctx, String(ctx.context.issueId ?? taskId)).catch(() => 0);
      if (recentRuns >= STORM_RUNS) {
        const message = `Temporal dispatch stopped: this task started ${recentRuns} runs in the last ${STORM_WINDOW_MS / 60_000} minutes, which means a failure keeps waking it. Read the latest failure comment, fix the cause, then move the task back to todo.`;
        await addIssueComment(ctx, String(ctx.context.issueId ?? taskId), message).catch(() => false);
        await fetch(`${String(ctx.config.paperclipApiUrl ?? "http://paperclip:3100").replace(/\/$/, "")}/api/issues/${encodeURIComponent(String(ctx.context.issueId ?? taskId))}`, { method: "PATCH", headers: { authorization: `Bearer ${String(ctx.authToken ?? ctx.config.paperclipApiToken ?? process.env.PAPERCLIP_API_TOKEN ?? "")}`, "content-type": "application/json", "x-paperclip-run-id": ctx.runId }, body: JSON.stringify({ status: "in_review" }), signal: ctx.signal }).catch(() => undefined);
        await ctx.onLog("stderr", `${message}
`);
        return { exitCode: 0, signal: null, timedOut: false, summary: message };
      }
      const blockerRows = Array.isArray(issue?.blockedBy) ? issue.blockedBy : [];
      const unresolved = blockerRows.filter(blocker => String(blocker.status ?? "unknown") !== "done");
      if (unresolved.length) {
        const issueId = String(ctx.context.issueId ?? taskId);
        const blockerIds = blockerRows.map(blocker => String(blocker.id ?? blocker.identifier ?? "unknown"));
        const message = `Temporal dispatch deferred: unresolved blockers ${unresolved.map(blocker => blocker.id ?? blocker.identifier).join(", ")}. The task remains blocked until Paperclip confirms every dependency is done.`;
        await deferForDependencies(ctx, issueId, blockerIds);
        await ctx.onLog("stdout", `${message}\n`);
        // A dependency wake may race with the blocker completing. Defer cleanly
        // before requiring publication metadata that only exists after completion.
        return { exitCode: 0, signal: null, timedOut: false, summary: message };
      }
      const parentPublications = [];
      for (const blocker of blockerRows) {
        const blockerId = String(blocker.id ?? blocker.identifier ?? "");
        if (!blockerId) return { exitCode: 1, signal: null, timedOut: false, errorMessage: "A Paperclip blocker has no issue ID; refusing unsafe dispatch" };
        const commentsResponse = await fetch(`${paperclipApiUrl}/api/issues/${encodeURIComponent(blockerId)}/comments?order=desc&limit=50`, { headers: { authorization: `Bearer ${paperclipToken}` }, signal: ctx.signal });
        if (!commentsResponse.ok) return { exitCode: 1, signal: null, timedOut: false, errorMessage: `Cannot verify published branch for blocker ${blockerId} (${commentsResponse.status})` };
        const publication = await publicationFromTemporal(ctx, blockerId, base, bridgeToken) ?? publicationFromComments(await commentsResponse.json());
        if (!publication) return { exitCode: 1, signal: null, timedOut: false, errorMessage: `Blocker ${blockerId} is done but has no verified orchestration draft PR metadata` };
        parentPublications.push({ issueId: blockerId, branch: publication.branch, headSha: publication.headSha, prUrl: publication.prUrl });
      }
      const taskControl = parseOpenSpecTaskMarker([taskTitle, taskDescription, taskPrompt].filter(Boolean).join("\n\n"));
      if (taskControl.error) return { exitCode: 1, signal: null, timedOut: false, errorMessage: taskControl.error };
      const request = {
        taskId,
        projectId,
        // Prefer the task's updatedAt revision so a Paperclip recovery after a
        // terminal Temporal failure gets a fresh Workflow ID. Duplicate
        // dispatches for the same task revision still resolve to the same ID.
        revision: String(revision),
        ...(Number.isInteger(Number(ctx.context.attempt)) && Number(ctx.context.attempt) > 0
          ? { attempt: Number(ctx.context.attempt) }
          : /^retry_/i.test(String(ctx.executionContinuation?.trigger?.reason ?? "")) && ctx.executionContinuation?.trigger?.sourceRunId
            ? { attempt: 1 + Number.parseInt(createHash("sha256").update(String(ctx.executionContinuation.trigger.sourceRunId)).digest("hex").slice(0, 7), 16) }
            : {}),
        profile: String(ctx.config.profile ?? "implementation"),
        prompt: taskControl.text || `Paperclip task ${taskId}`,
        ...(taskControl.openSpec !== undefined ? { openSpec: taskControl.openSpec } : {}),
        ...(ctx.config.requireApproval != null ? { approval: Boolean(ctx.config.requireApproval) } : {}),
        ...(taskTitle ? { taskTitle: String(taskTitle) } : {}),
        // Label names only: the bridge owns the mapping from labels to a task type (src/task-types.ts), so there is a single definition of it.
        labels: issueLabelNames(issue),
        blockers: blockerRows.map(blocker => ({ id: String(blocker.id ?? blocker.identifier ?? "unknown"), status: String(blocker.status ?? "unknown") })),
        parentPublications,
      };
      const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" };
      const issueId = String(ctx.context.issueId ?? taskId);
      let previousWorkflowId;
      let reusedPublishedReview = false;
      try {
        const continuationWorkflow = await workflowForContinuation(ctx, issueId, paperclipApiUrl, paperclipToken);
        previousWorkflowId = continuationWorkflow?.workflowId;
        reusedPublishedReview = Boolean(continuationWorkflow?.reusedPublishedReview);
      }
      catch (error) { return { exitCode: 1, signal: null, timedOut: false, errorMessage: `Cannot safely inspect the failed retry source: ${String(error)}` }; }
      const start = previousWorkflowId
        ? await fetch(`${base}/v1/runs/${encodeURIComponent(previousWorkflowId)}/resume`, { method: "POST", headers, signal: ctx.signal })
        : await fetch(`${base}/v1/runs`, { method: "POST", headers, body: JSON.stringify(request), signal: ctx.signal });
      if (!start.ok) return { exitCode: 1, signal: null, timedOut: false, errorMessage: `${previousWorkflowId ? "Workflow resume" : "Workflow dispatch"} failed (${start.status}): ${await start.text()}` };
      const { workflowId } = await start.json();
      if (ctx.onDispatch) await ctx.onDispatch();
      const startMessage = previousWorkflowId
        ? reusedPublishedReview
          ? `Temporal workflow resumed: ${workflowId} (reusing the latest successful review workflow ${previousWorkflowId}; its published branch and completed stages are preserved).`
          : `Temporal workflow resumed: ${workflowId} (continuing failed workflow ${previousWorkflowId}; completed stages and its preserved worktree are reused when inputs are unchanged).`
        : `Temporal workflow started: ${workflowId}`;
      await ctx.onLog("stdout", `${startMessage}\n`);
      await addIssueComment(ctx, issueId, `${startMessage} (profile \`${request.profile}\`; stage providers are set by the project manifest).`).catch(error => ctx.onLog("stderr", `Could not post start comment: ${String(error)}\n`));
      let lastStage = "";
      let failedPolls = 0;
      const pollMs = Number(ctx.config.pollIntervalMs ?? 1000);
      const retryMs = Number(ctx.config.retryDelayMs ?? 2000);
      // Paperclip renews the controller lease of a run only while the adapter produces output. A long silent stage (a Unity project copy or import takes minutes) let the lease lapse
      // after about a minute, Paperclip cancelled the run and put the task on an execution-reconciliation hold that refuses every later wake (ADR 0021). A line every 20 seconds keeps it alive.
      const keepaliveMs = Number(ctx.config.keepaliveMs ?? 20_000);
      let lastLogAt = Date.now(); const startedAt = Date.now();
      while (!ctx.signal?.aborted) {
        let state;
        try {
          const response = await fetch(`${base}/v1/runs/${encodeURIComponent(workflowId)}`, { headers, signal: ctx.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          state = await response.json();
          failedPolls = 0;
        } catch (error) {
          if (ctx.signal?.aborted) break;
          // A bridge or network blip must not end a run that is still progressing in Temporal; give up only after a sustained outage.
          if (++failedPolls >= 60) return { exitCode: 1, signal: null, timedOut: false, errorMessage: `Workflow inspection failed ${failedPolls} times in a row: ${String(error)}` };
          await new Promise(resolve => setTimeout(resolve, retryMs));
          continue;
        }
        const stage = state.progress?.currentStage;
        if (stage && stage !== lastStage) { lastStage = stage; lastLogAt = Date.now(); await ctx.onLog("stdout", `Temporal stage started: ${stage}\n`); }
        else if (keepaliveMs > 0 && Date.now() - lastLogAt >= keepaliveMs && state.status === "RUNNING") { lastLogAt = Date.now(); await ctx.onLog("stdout", `Temporal run still in progress${stage ? `: stage ${stage}` : ""} (${Math.round((Date.now() - startedAt) / 60_000)} min)\n`); }
      if (["COMPLETED", "FAILED", "CANCELED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(state.status)) {
          const result = state.result;
          // Research and architecture runs carry a rendered report; the stage summaries of those runs are raw JSON answers and are left out.
          const stageSummaries = result?.report?.markdown ? `### ${result.report.title}\n\n${String(result.report.markdown).slice(0, 30000)}` : (result?.stages ?? []).map(item => `${item.stage}: ${item.summary}`).join("\n");
          const artifacts = result?.artifactRefs?.length ? `\nArtifacts: ${result.artifactRefs.map(ref => `\`${ref}\``).join(", ")}` : "\nNo artifacts were recorded.";
          const publication = result?.publish ? `\n\nBranch: \`${result.publish.branch}\`\nBase SHA: \`${result.publish.baseSha}\`\nHead SHA: \`${result.publish.headSha}\`\nDraft PR: ${result.publish.prUrl} (base \`${result.publish.prBaseBranch}\`)\nDone means gates passed and the draft PR was created; it does not mean merged.` : "";
          const metadata = result?.publish ? `\n<!-- orchestration-publish ${JSON.stringify(result.publish)} -->` : "";
          const failureText = String(result?.message ?? state.status);
          const needsInfo = result?.status === "needs_info";
          // A project bootstrap (ADR 0009) publishes no pull request; completing it means the repository, manifest and Paperclip tasks exist.
          const bootstrapRun = result?.metadata?.taskType === "bootstrap";
          const bootstrapped = result?.status === "completed" && Boolean(result.bootstrap);
          // A terminal workflow failure is an expected task outcome, not an adapter failure.
          // Record it as a blocked task with its evidence so Paperclip does not replace the
          // useful failure with a generic legacy-execution recovery hold.
          const terminalFailure = !bootstrapRun && (state.status !== "COMPLETED" || result?.status === "failed");
          // Gates passed and a draft PR exists, but blocking review findings remain: the PR carries them as a comment and a person decides.
          const needsReview = result?.status === "needs_review" && Boolean(result.publish?.prUrl);
          const openFindings = needsReview ? (result.metadata?.review?.unresolvedFindings ?? []).map((finding, index) => `${index + 1}. [${finding.severity}/${finding.category}] ${finding.title}`).join("\n") : "";
          const recovery = result?.status === "completed" ? "" : needsReview ? `

### Decision needed
The tests and build pass and the draft PR is published, but the automated review still has unresolved findings (also posted as a comment on the PR):
${openFindings}

Accept the PR as it is, or comment here with what to fix and re-run the task.` : needsInfo ? "\n\n### Action needed\nThe bug could not be reproduced or traced to a defect, so no code was changed. Add the missing details (steps, data, environment, expected versus actual behaviour) or reproduce it manually and describe the result, then move the task back to todo." : bootstrapRun ? "\n\n### Project not created\nSee the message above for what exists (a local folder, a GitHub repository, tasks). Remove any partial leftovers it names, fix the cause, and move this task back to todo to run it again." : `\n\n### Recovery guidance\nThis run did not complete and must not be treated as reviewed, verified, or published. Preserve the failed run and its artifacts. Diagnose the failed stage and correct its cause first. Confirm the provider process has stopped and inspect the preserved worktree before retrying. Use Paperclip's linked Retry/recovery action so the successor run is associated with this failure. If Paperclip reports \`execution_reconciliation_required\`, do not launch a duplicate or force the issue to \`todo\`: reconcile the stopped execution and preserved changes through the active recovery action. If no recovery action exists, keep the issue blocked and ask a board operator to repair/create the recovery record before retrying. ${/timed out/i.test(failureText) ? "This was a timeout; check the failure artifact's configured timeout and duration, and increase only the affected project's stage timeout if the work is progressing normally." : ""}`;
          const report = `Temporal workflow \`${workflowId}\` finished with status **${result?.status ?? state.status}**. ${failureText}${stageSummaries ? `\n\n${stageSummaries}` : ""}${publication}${artifacts}${recovery}${metadata}`;
          await ctx.onLog("stdout", `${report}\n`);
          // The worker already put this result on the task (ADR 0018): do not post it twice, a second comment wakes the agent.
          if (result?.reportedToPaperclip === true) return { exitCode: 0, signal: null, timedOut: false, summary: result?.message ?? state.status };
          const published = result?.status === "completed" && (request.profile === "research" || bootstrapped || result.publish?.prUrl && result.publish?.headSha);
          let paperclipUpdateOk = true;
          // A bug that needs more information blocks the issue with the question as a comment; that is a normal outcome, not a failed run.
          const targetStatus = published ? "done" : needsReview ? "in_review" : needsInfo || terminalFailure ? "in_review" : bootstrapRun && result?.status === "rejected" ? "cancelled" : null;
          if (targetStatus) {
            const token = String(ctx.authToken ?? ctx.config.paperclipApiToken ?? process.env.PAPERCLIP_API_TOKEN ?? "");
            if (token) {
              const paperclipApiUrl = String(ctx.config.paperclipApiUrl ?? "http://paperclip:3100").replace(/\/$/, "");
              const response = await fetch(`${paperclipApiUrl}/api/issues/${encodeURIComponent(issueId)}`, {
                method: "PATCH",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-paperclip-run-id": ctx.runId },
                body: JSON.stringify({ status: targetStatus, comment: report }),
                signal: ctx.signal,
              });
              if (!response.ok) {
                paperclipUpdateOk = false;
                const details = await response.text();
                await ctx.onLog("stderr", `Could not mark Paperclip task complete (${response.status}): ${details}\n`);
                await addIssueComment(ctx, issueId, report).catch(error => ctx.onLog("stderr", `Could not post publication result comment: ${String(error)}\n`));
              }
            } else {
              paperclipUpdateOk = false;
              await addIssueComment(ctx, issueId, report).catch(error => ctx.onLog("stderr", `Could not post result comment: ${String(error)}\n`));
            }
          } else {
            paperclipUpdateOk = await addIssueComment(ctx, issueId, report).catch(error => { ctx.onLog("stderr", `Could not post result comment: ${String(error)}\n`); return false; });
          }
          return { exitCode: targetStatus && paperclipUpdateOk ? 0 : 1, signal: null, timedOut: false, summary: result?.message ?? state.status, ...(!paperclipUpdateOk ? { errorMessage: "Workflow result could not be recorded in Paperclip; task requires recovery" } : {}) };
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      // Paperclip aborts a legacy adapter when its own controller lease lapses (for example when the Paperclip server was unreachable for a minute).
      // That says nothing about the task: leave the workflow running so the work is not thrown away, and let it be reconciled afterwards.
      const abortReason = String(ctx.signal?.reason?.message ?? ctx.signal?.reason ?? "");
      if (/lease lost/i.test(abortReason)) {
        await ctx.onLog("stderr", `Paperclip controller lease lost; leaving Temporal workflow ${workflowId} running. Inspect it with GET /v1/runs/${workflowId} (issue ${issueId}).\n`);
        return { exitCode: null, signal: "SIGTERM", timedOut: false, errorMessage: `Paperclip controller lease lost; the Temporal workflow ${workflowId} was left running` };
      }
      await fetch(`${base}/v1/runs/${encodeURIComponent(workflowId)}/cancel`, { method: "POST", headers, signal: AbortSignal.timeout(3000) }).catch(() => {});
      return { exitCode: null, signal: "SIGTERM", timedOut: false, errorMessage: "Paperclip execution cancelled; Temporal cancellation requested" };
    },
  };
}
