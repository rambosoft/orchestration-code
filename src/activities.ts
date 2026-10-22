import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { StageOutputSchema, type StageInput, type StageOutput } from "./contracts.js";
import { pluginRegistry } from "./plugins.js";
import { getProvider } from "./providers.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { childEnv } from "./env.js";
import { NODE_EXECUTABLE } from "./node-path.js";
import { activitySignal, killOnAbort } from "./process-control.js";
import type { ParentPublication, RepositoryContext } from "./contracts.js";
import { resolveRemoteBranch, runCommand } from "./workspaces.js";
import { archiveOpenSpec, prepareOpenSpec as prepareOpenSpecProject, validateOpenSpec as validateOpenSpecProject } from "./openspec.js";
import type { OpenSpecPrepared, OpenSpecContext } from "./contracts.js";
export { prepareWorktree, collectWorktree, publishWorktree } from "./workspaces.js";

async function emitActivityEvent(event: Record<string, unknown>, level: "info" | "error" = "info"): Promise<void> {
  const line = JSON.stringify(event);
  if (level === "error") console.error(line); else console.log(line);
  const logFile = path.join(path.resolve(process.env.ORCHESTRATOR_DATA_DIR ?? "data"), "logs", "worker-activity-events.jsonl");
  try {
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, `${line}\n`, "utf8");
  } catch (error) {
    console.error(JSON.stringify({ event: "activity.event_log_write_failed", logFile, error: error instanceof Error ? error.message : String(error) }));
  }
}

export async function prepareOpenSpec(input: { taskId: string; runId: string; prompt: string; projectRoot: string; artifactsDir: string }): Promise<OpenSpecPrepared> {
  return prepareOpenSpecProject({ ...input, artifactsDir: path.join(input.artifactsDir, input.runId) });
}

export async function validateOpenSpec(input: { changeId: string; runId: string; projectRoot: string; artifactsDir: string }): Promise<OpenSpecContext> {
  // Validation failures are deterministic for a given change; retrying cannot help, the workflow decides whether to repair.
  try { return await validateOpenSpecProject({ ...input, artifactsDir: path.join(input.artifactsDir, input.runId) }); }
  catch (error) { throw ApplicationFailure.nonRetryable(error instanceof Error ? error.message : String(error), "OpenSpecValidationError"); }
}

export async function archiveOpenSpecChange(input: { changeId: string; runId: string; projectRoot: string; artifactsDir: string }): Promise<{ archivedPath: string; artifactRef: string }> {
  try { return await archiveOpenSpec({ ...input, artifactsDir: path.join(input.artifactsDir, input.runId) }); }
  catch (error) { throw ApplicationFailure.nonRetryable(error instanceof Error ? error.message : String(error), "OpenSpecArchiveError"); }
}

export async function checkDependencies(input: { blockerIds: string[]; parentPublications: ParentPublication[]; repository: RepositoryContext; projectRoot: string }): Promise<void> {
  if (!input.blockerIds.length) return;
  const token = process.env.PAPERCLIP_API_TOKEN;
  if (!token) throw new Error("PAPERCLIP_API_TOKEN is required on the Windows worker to recheck task blockers before branch creation");
  const base = (process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
  for (const blockerId of input.blockerIds) {
    const response = await fetch(`${base}/api/issues/${encodeURIComponent(blockerId)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`could not recheck blocker '${blockerId}' (${response.status})`);
    const blocker = await response.json() as { status?: string };
    if (blocker.status !== "done") throw new Error(`blocker '${blockerId}' is no longer ready (status ${blocker.status ?? "unknown"})`);
  }
  if (input.parentPublications.length === 1) {
    const parent = input.parentPublications[0]!;
    const current = await resolveRemoteBranch(input.projectRoot, input.repository.remote, parent.branch);
    if (current !== parent.headSha || current !== input.repository.baseSha) throw new Error(`parent branch '${parent.branch}' changed after admission; human stack recovery is required`);
  } else if (input.parentPublications.length > 1) {
    const integrated = await resolveRemoteBranch(input.projectRoot, input.repository.remote, input.repository.prBaseBranch);
    if (integrated !== input.repository.baseSha) throw new Error(`integrated base '${input.repository.prBaseBranch}' changed after admission; human stack recovery is required`);
    for (const parent of input.parentPublications) await runCommand("git", ["merge-base", "--is-ancestor", parent.headSha, integrated], input.projectRoot).catch(() => { throw new Error(`integrated base no longer contains blocker ${parent.issueId}`); });
  }
}

export function runCheck(executable: string, args: string[], cwd: string, maxOutputChars = 5000, signal: AbortSignal | undefined = activitySignal()): Promise<{ code: number | null; output: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // npm is exposed as npm.ps1/npm.cmd on Windows, neither of which spawn()
    // can execute reliably without a shell. Invoke the bundled JS CLI instead.
    const npmCli = path.join(path.dirname(NODE_EXECUTABLE), "node_modules", "npm", "bin", "npm-cli.js");
    const command = process.platform === "win32" && executable === "npm" && existsSync(npmCli) ? NODE_EXECUTABLE : executable;
    const commandArgs = command === NODE_EXECUTABLE && executable === "npm" ? [npmCli, ...args] : args;
    const child = spawn(command, commandArgs, { cwd, shell: false, windowsHide: true, env: childEnv() }); const stopKill = killOnAbort(child, signal); const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outBytes = 0; let errBytes = 0;
    child.stdout.on("data", (b: Buffer) => { if (outBytes < 100_000) { stdout.push(b); outBytes += b.length; } });
    child.stderr.on("data", (b: Buffer) => { if (errBytes < 100_000) { stderr.push(b); errBytes += b.length; } });
    child.on("error", error => { stopKill(); reject(error); }); child.on("close", code => { stopKill(); if (signal?.aborted) return reject(new Error("cancelled: process killed")); resolve({ code, output: Buffer.concat(stdout).toString("utf8").slice(0, maxOutputChars), stderr: Buffer.concat(stderr).toString("utf8").slice(0, maxOutputChars) }); });
  });
}

export function reviewPromptWithDiff(prompt: string, diff: string): string {
  return `${prompt}\n\nImplementation diff (review this code against the task requirements):\n${diff.slice(0, 40_000)}`;
}

/** Install locked npm dependencies in a fresh isolated worktree before agents or quality checks use them. */
export async function prepareProjectDependencies(
  projectRoot: string,
  run: typeof runCheck = runCheck,
): Promise<{ installed: boolean; summary: string }> {
  const root = path.resolve(projectRoot);
  try {
    await access(path.join(root, "package.json"));
    await access(path.join(root, "package-lock.json"));
  } catch {
    return { installed: false, summary: "No npm package and lockfile pair; dependency installation skipped." };
  }
  const result = await run("npm", ["ci"], root, 3000);
  if (result.code !== 0) {
    throw new Error(`npm ci failed in the isolated task worktree${result.stderr ? `: ${result.stderr}` : result.output ? `: ${result.output}` : ` (exit ${result.code ?? "unknown"})`}`);
  }
  return { installed: true, summary: "Installed npm dependencies from package-lock.json with npm ci." };
}

export type ProviderErrorCategory = "timeout" | "rate_limit" | "authentication" | "configuration" | "provider_error";
/** Authentication and configuration failures are permanent; everything else may be retried. Word boundaries keep "authored" or port 4030 from being misread as auth failures. */
export function classifyProviderError(message: string): ProviderErrorCategory {
  if (/timed out/i.test(message)) return "timeout";
  if (/\b429\b|rate[ -]limit/i.test(message)) return "rate_limit";
  if (/\b(?:401|403)\b|unauthori[sz]ed|\bauthentication\b/i.test(message)) return "authentication";
  if (/not configured|missing its configured model|unsupported provider/i.test(message)) return "configuration";
  return "provider_error";
}

/** Heartbeats keep Temporal able to deliver cancellation to a long provider run. */
export async function executeStage(input: StageInput): Promise<StageOutput> {
  let timer: NodeJS.Timeout | undefined;
  try { const context = Context.current(); timer = setInterval(() => context.heartbeat(), HEARTBEAT_INTERVAL_MS); } catch { /* direct unit invocation */ }
  try { return await executeStageInner(input); } finally { if (timer) clearInterval(timer); }
}
const HEARTBEAT_INTERVAL_MS = 10_000;

async function executeStageInner(input: StageInput): Promise<StageOutput> {
  const info = (() => { try { return Context.current().info; } catch { return undefined; } })();
  const activityStartedAt = Date.now();
  const queueWaitMs = info ? Math.max(0, activityStartedAt - info.currentAttemptScheduledTimestampMs) : undefined;
  const queueAlertMs = Number(process.env.ORCHESTRATOR_QUEUE_WAIT_ALERT_MS ?? 60_000);
  const activityContext = { workflowId: info?.workflowExecution?.workflowId, activityType: info?.activityType, attempt: info?.attempt ?? input.activityAttempt ?? 1, runId: input.runId, taskId: input.taskId, projectId: input.projectId, stage: input.stage, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) };
  await emitActivityEvent({ event: "activity.start", ...activityContext });
  if (queueWaitMs !== undefined && Number.isFinite(queueAlertMs) && queueWaitMs >= queueAlertMs) await emitActivityEvent({ event: "activity.queue_wait_alert", thresholdMs: queueAlertMs, ...activityContext }, "error");
  const errors = await pluginRegistry.check(input.plugins, { stage: input.stage, provider: input.provider });
  if (errors.length) throw ApplicationFailure.nonRetryable(errors.join("; "), "PluginConfigError");
  // Keep artifacts from retries and later task revisions separate. Temporal
  // workflow history still records the same paths returned by each stage.
  const artifactsDir = path.join(input.artifactsDir, input.runId);
  await mkdir(artifactsDir, { recursive: true });
  const qualityRefs: string[] = [];
  let qualityChecks: Array<{ executable: string; args: string[]; exitCode: number | null; durationMs: number; output: string; stderr: string }> | undefined;
  if (input.stage === "verify") {
    const checks = input.qualityCommands ?? [];
    if (checks.length === 0 && input.provider !== "fake" && !input.deterministicChecksAlreadyPassed) {
      const durationMs = Date.now() - activityStartedAt;
      await emitActivityEvent({ event: "activity.fail", ...activityContext, provider: "quality-gate", category: "missing_quality_commands", providerDurationMs: 0, activityDurationMs: durationMs, retries: Math.max(0, (info?.attempt ?? 1) - 1) }, "error");
      return { ok: false, summary: "quality gate failed: no deterministic quality commands are configured", findings: ["Configure at least one deterministic verification command."], artifactRefs: [], provider: "quality-gate", durationMs, metadata: { checks: [], passed: false, activityDurationMs: durationMs, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
    }
    const results: NonNullable<typeof qualityChecks> = [];
    for (const check of checks) {
      const checkStartedAt = Date.now();
      const result = await runCheck(check.executable, check.args, path.resolve(input.projectRoot, check.cwd ?? "."));
      results.push({ executable: check.executable, args: check.args, exitCode: result.code, durationMs: Date.now() - checkStartedAt, output: result.output, stderr: result.stderr });
      if (result.code !== 0) {
        const failed = path.join(artifactsDir, `quality-${input.attempt}.json`);
        const activityDurationMs = Date.now() - activityStartedAt;
        await writeFile(failed, JSON.stringify({ passed: false, checks: results, activityDurationMs, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) }, null, 2));
        await emitActivityEvent({ event: "activity.fail", ...activityContext, provider: "quality-gate", category: "quality_check_failed", providerDurationMs: 0, activityDurationMs, retries: Math.max(0, (info?.attempt ?? 1) - 1), failedCommand: `${check.executable} ${check.args.join(" ")}` }, "error");
        return { ok: false, summary: `quality check failed: ${check.executable} ${check.args.join(" ")}`, findings: results.map(r => [r.output, r.stderr].filter(Boolean).join("\n")), artifactRefs: [failed], provider: "quality-gate", durationMs: activityDurationMs, metadata: { checks: results, passed: false, activityDurationMs, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
      }
    }
    const qualityFile = path.join(artifactsDir, `quality-${input.attempt}.json`);
    await writeFile(qualityFile, JSON.stringify({ passed: true, checks: results }, null, 2)); qualityRefs.push(qualityFile);
    qualityChecks = results;
  }
  if (input.verificationOnly) {
    const output: StageOutput = { stage: input.stage, ok: true, summary: "Deterministic quality checks passed before focused review.", findings: [], artifactRefs: qualityRefs, provider: "quality-gate", durationMs: Date.now() - activityStartedAt, metadata: { deterministicQuality: { passed: true, checks: qualityChecks ?? [] }, verificationOnly: true, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
    const file = path.join(artifactsDir, `verify-${input.attempt}.json`);
    await writeFile(file, JSON.stringify({ ...output, runId: input.runId, taskId: input.taskId }, null, 2));
    await emitActivityEvent({ event: "activity.complete", ...activityContext, provider: output.provider, ok: true, providerDurationMs: 0, activityDurationMs: output.durationMs, retries: Math.max(0, (info?.attempt ?? 1) - 1), verificationOnly: true, ...(input.stage === "verify" ? { checkDurationsMs: (qualityChecks ?? []).map(check => check.durationMs) } : {}) });
    return { ...output, artifactRefs: [...output.artifactRefs, file] };
  }
  let activityAttempt = 1;
  try { activityAttempt = Context.current().info.attempt; } catch { /* direct unit invocation uses the first attempt */ }
  let stageInput = { ...input, activityAttempt };
  if (input.stage === "review" && input.provider !== "fake") {
    // Give every real reviewer the implementation itself, including newly
    // created files, rather than asking it to review only the task summary.
    await runCheck("git", ["add", "--intent-to-add", "--all"], input.projectRoot);
    const diff = await runCheck("git", ["diff", "--binary", "HEAD"], input.projectRoot, 40_000);
    if (diff.code !== 0) throw new Error(`could not collect implementation diff for review: ${diff.stderr || diff.output.slice(0, 500)}`);
    stageInput.prompt = reviewPromptWithDiff(input.prompt, diff.output);
  }
  // A retry after a lost response must not pay for (or redo) a stage that already succeeded with identical input.
  const inputHash = createHash("sha256").update(JSON.stringify([input.stage, input.provider, input.model ?? "", input.reasoningEffort ?? "", stageInput.prompt])).digest("hex");
  const stageFile = path.join(artifactsDir, `${input.stage}-${input.attempt}.json`);
  const previous = await readFile(stageFile, "utf8").then(text => JSON.parse(text) as { inputHash?: string }, () => undefined);
  if (previous?.inputHash === inputHash) {
    const reusable = StageOutputSchema.safeParse(previous);
    if (reusable.success && reusable.data.ok) {
      await emitActivityEvent({ event: "activity.reused", ...activityContext, provider: reusable.data.provider });
      return { ...reusable.data, stage: input.stage, metadata: { ...reusable.data.metadata, reused: true }, artifactRefs: reusable.data.artifactRefs.includes(stageFile) ? reusable.data.artifactRefs : [...reusable.data.artifactRefs, stageFile] };
    }
  }
  const providerStarted = Date.now();
  let result: StageOutput;
  try {
    result = await getProvider(input.provider).run(stageInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureFile = path.join(artifactsDir, `${input.stage}-${input.attempt}-activity-${activityAttempt}-failure.json`);
    const providerDurationMs = Date.now() - providerStarted;
    const category = classifyProviderError(message);
    await writeFile(failureFile, JSON.stringify({ runId: input.runId, taskId: input.taskId, stage: input.stage, stageAttempt: input.attempt, activityAttempt, retryCount: Math.max(0, activityAttempt - 1), provider: input.provider, model: input.model, providerTimeoutMs: input.providerTimeoutMs ?? null, providerDurationMs, activityDurationMs: Date.now() - activityStartedAt, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}), category, error: message, partialWorktree: input.projectRoot }, null, 2));
    await emitActivityEvent({ event: "activity.fail", ...activityContext, provider: input.provider, category, providerDurationMs, activityDurationMs: Date.now() - activityStartedAt, retries: Math.max(0, activityAttempt - 1), failureArtifact: failureFile }, "error");
    const detail = `${message}; failure artifact: ${failureFile}; worktree preserved: ${input.projectRoot}`;
    // Retrying bad credentials or configuration only repeats the failure (and the cost).
    throw category === "authentication" || category === "configuration" ? ApplicationFailure.nonRetryable(detail, category === "authentication" ? "ProviderAuthenticationError" : "ProviderConfigurationError") : new Error(detail);
  }
  const parsed = StageOutputSchema.safeParse(result);
  if (!parsed.success) throw ApplicationFailure.nonRetryable(`invalid provider result: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`, "InvalidProviderResult");
  const providerOutput = parsed.data;
  const out: StageOutput = input.stage === "verify" && input.provider !== "fake"
    ? { ...providerOutput, summary: `${input.deterministicChecksAlreadyPassed ? "Deterministic quality commands passed in the preceding check. " : "Deterministic quality commands passed. "}${providerOutput.summary}`, durationMs: Date.now() - activityStartedAt, metadata: { ...providerOutput.metadata, providerDurationMs: providerOutput.durationMs, activityDurationMs: Date.now() - activityStartedAt, deterministicQuality: { passed: true, checks: qualityChecks ?? [], alreadyPassed: input.deterministicChecksAlreadyPassed ?? false }, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } }
    : { ...providerOutput, durationMs: Date.now() - activityStartedAt, metadata: { ...providerOutput.metadata, providerDurationMs: providerOutput.durationMs, activityDurationMs: Date.now() - activityStartedAt, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
  const file = path.join(artifactsDir, `${input.stage}-${input.attempt}.json`);
  await writeFile(file, JSON.stringify({ ...out, stage: input.stage, runId: input.runId, taskId: input.taskId, inputHash }, null, 2), { flag: "w" });
  await emitActivityEvent({ event: "activity.complete", ...activityContext, provider: out.provider, ok: out.ok, providerDurationMs: out.metadata?.providerDurationMs ?? out.durationMs, activityDurationMs: Date.now() - activityStartedAt, retries: Math.max(0, (info?.attempt ?? 1) - 1), ...(input.stage === "verify" ? { checkDurationsMs: (qualityChecks ?? []).map(check => check.durationMs) } : {}) });
  return { ...out, stage: input.stage, artifactRefs: [...out.artifactRefs, ...qualityRefs, file] };
}
export async function timeoutProbe(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 5000)); }
