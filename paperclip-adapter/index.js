import { createHash } from "node:crypto";

export const type = "temporal_orchestrator";
export const label = "Temporal Orchestrator";
export const models = [{ id: "workflow", label: "Temporal workflow (stage providers selected by project manifest)" }];
export const agentConfigurationDoc = `# Temporal Orchestrator\n\nConfigure bridgeUrl, bridgeToken, and profile. The adapter selects the project from the assigned Paperclip issue and submits it to Temporal; each project must have a matching orchestrator manifest and workspace mounts. A configured projectId is an optional fallback only for legacy unscoped issues. Stage-level provider and model routes are controlled by each project's manifest. The task type comes from an issue label (type:bug, type:research, type:architecture, type:task or a bare bug/spike label), else a standalone “Type: bug” line in the task, else the agent profile; bugs are diagnosed and reproduced before the fix, research and architecture tasks only produce a report (draft PR plus comment). OpenSpec is enabled by default per project; add a standalone “OpenSpec: off” or “OpenSpec: on” line in a task to override it. Provider credentials remain on the Windows Temporal worker.`;

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
      const blockerRows = Array.isArray(issue?.blockedBy) ? issue.blockedBy : [];
      const parentPublications = [];
      for (const blocker of blockerRows) {
        const blockerId = String(blocker.id ?? blocker.identifier ?? "");
        if (!blockerId) return { exitCode: 1, signal: null, timedOut: false, errorMessage: "A Paperclip blocker has no issue ID; refusing unsafe dispatch" };
        const commentsResponse = await fetch(`${paperclipApiUrl}/api/issues/${encodeURIComponent(blockerId)}/comments?order=desc&limit=50`, { headers: { authorization: `Bearer ${paperclipToken}` }, signal: ctx.signal });
        if (!commentsResponse.ok) return { exitCode: 1, signal: null, timedOut: false, errorMessage: `Cannot verify published branch for blocker ${blockerId} (${commentsResponse.status})` };
        const publication = publicationFromComments(await commentsResponse.json());
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
      const unresolved = request.blockers.filter(blocker => blocker.status !== "done");
      if (unresolved.length) {
        const message = `Temporal dispatch withheld: unresolved blockers ${unresolved.map(blocker => blocker.id).join(", ")}.`;
        await ctx.onLog("stderr", `${message}\n`);
        await addIssueComment(ctx, String(ctx.context.issueId ?? taskId), message).catch(error => ctx.onLog("stderr", `Could not post blocker comment: ${String(error)}\n`));
        return { exitCode: 1, signal: null, timedOut: false, errorMessage: message };
      }
      const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" };
      const start = await fetch(`${base}/v1/runs`, { method: "POST", headers, body: JSON.stringify(request), signal: ctx.signal });
      if (!start.ok) return { exitCode: 1, signal: null, timedOut: false, errorMessage: `Workflow dispatch failed (${start.status}): ${await start.text()}` };
      const { workflowId } = await start.json();
      if (ctx.onDispatch) await ctx.onDispatch();
      await ctx.onLog("stdout", `Temporal workflow started: ${workflowId}\n`);
      const issueId = String(ctx.context.issueId ?? taskId);
      await addIssueComment(ctx, issueId, `Temporal workflow started: \`${workflowId}\` (profile \`${request.profile}\`; stage providers are set by the project manifest).`).catch(error => ctx.onLog("stderr", `Could not post start comment: ${String(error)}\n`));
      let lastStage = "";
      let failedPolls = 0;
      const pollMs = Number(ctx.config.pollIntervalMs ?? 1000);
      const retryMs = Number(ctx.config.retryDelayMs ?? 2000);
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
        if (stage && stage !== lastStage) { lastStage = stage; await ctx.onLog("stdout", `Temporal stage started: ${stage}\n`); }
      if (["COMPLETED", "FAILED", "CANCELED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(state.status)) {
          const result = state.result;
          // Research and architecture runs carry a rendered report; the stage summaries of those runs are raw JSON answers and are left out.
          const stageSummaries = result?.report?.markdown ? `### ${result.report.title}\n\n${String(result.report.markdown).slice(0, 30000)}` : (result?.stages ?? []).map(item => `${item.stage}: ${item.summary}`).join("\n");
          const artifacts = result?.artifactRefs?.length ? `\nArtifacts: ${result.artifactRefs.map(ref => `\`${ref}\``).join(", ")}` : "\nNo artifacts were recorded.";
          const publication = result?.publish ? `\n\nBranch: \`${result.publish.branch}\`\nBase SHA: \`${result.publish.baseSha}\`\nHead SHA: \`${result.publish.headSha}\`\nDraft PR: ${result.publish.prUrl} (base \`${result.publish.prBaseBranch}\`)\nDone means gates passed and the draft PR was created; it does not mean merged.` : "";
          const metadata = result?.publish ? `\n<!-- orchestration-publish ${JSON.stringify(result.publish)} -->` : "";
          const failureText = String(result?.message ?? state.status);
          const needsInfo = result?.status === "needs_info";
          const recovery = result?.status === "completed" ? "" : needsInfo ? "\n\n### Action needed\nThe bug could not be reproduced or traced to a defect, so no code was changed. Add the missing details (steps, data, environment, expected versus actual behaviour) or reproduce it manually and describe the result, then move the task back to todo." :`\n\n### Recovery guidance\nThis run did not complete and must not be treated as reviewed, verified, or published. Preserve the failed run and its artifacts. Diagnose the failed stage and correct its cause first. Confirm the provider process has stopped and inspect the preserved worktree before retrying. Use Paperclip's linked Retry/recovery action so the successor run is associated with this failure. If Paperclip reports \`execution_reconciliation_required\`, do not launch a duplicate or force the issue to \`todo\`: reconcile the stopped execution and preserved changes through the active recovery action. If no recovery action exists, keep the issue blocked and ask a board operator to repair/create the recovery record before retrying. ${/timed out/i.test(failureText) ? "This was a timeout; check the failure artifact's configured timeout and duration, and increase only the affected project's stage timeout if the work is progressing normally." : ""}`;
          const report = `Temporal workflow \`${workflowId}\` finished with status **${result?.status ?? state.status}**. ${failureText}${stageSummaries ? `\n\n${stageSummaries}` : ""}${publication}${artifacts}${recovery}${metadata}`;
          await ctx.onLog("stdout", `${report}\n`);
          const published = result?.status === "completed" && (request.profile === "research" || result.publish?.prUrl && result.publish?.headSha);
          let paperclipUpdateOk = true;
          // A bug that needs more information blocks the issue with the question as a comment; that is a normal outcome, not a failed run.
          const targetStatus = published ? "done" : needsInfo ? "blocked" : null;
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
            await addIssueComment(ctx, issueId, report).catch(error => ctx.onLog("stderr", `Could not post result comment: ${String(error)}\n`));
          }
          return { exitCode: targetStatus && paperclipUpdateOk ? 0 : 1, signal: null, timedOut: false, summary: result?.message ?? state.status, ...(!paperclipUpdateOk ? { errorMessage: "Workflow passed but Paperclip status/comment update failed; task requires recovery" } : {}) };
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
