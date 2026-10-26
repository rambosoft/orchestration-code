import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { reproductionCommandProblem, TEST_PATH, type ReproVerification } from "./bug.js";
import { buildContextPack as buildPack, type ContextPack } from "./context-pack.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { StageOutputSchema, type QualityCommand, type StageInput, type StageOutput } from "./contracts.js";
import { pluginRegistry } from "./plugins.js";
import { parseUnityEditorVersion } from "./stack-profiles.js";
import { acceptanceProblem, coverageTable, sliceProblem } from "./acceptance.js";
import { unityPreflight } from "./preflight.js";
import { budgetStatus, runUsage } from "./usage.js";
import { prefilterEnabled, prefilterFindings, prefilterProblem } from "./review-prefilter.js";
import { findReusable, qualityKey, qualityReuseEnabled, readPasses, treeFingerprint, writePass } from "./quality-cache.js";
import { clearUnityEvidence, readUnityTestFiles, stopProjectEditors, stripBenignEditorNoise, waitForProjectUnlock, unityEvidenceProblem, unityExitHint, withUnityDefaults } from "./unity.js";
import { getProvider } from "./providers.js";
import { applyReviewAssessment } from "./review.js";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { childEnv } from "./env.js";
import { activitySignal, heartbeating, killOnAbort, toolCommand } from "./process-control.js";
import { captureScreenshots, visualReviewSection } from "./visual.js";
import type { ParentPublication, RepositoryContext } from "./contracts.js";
import { buildIntegrationBase, resolveRemoteBranch, runCommand } from "./workspaces.js";
import { timedActivity } from "./timing.js";
import { archiveOpenSpec, prepareOpenSpec as prepareOpenSpecProject, validateOpenSpec as validateOpenSpecProject } from "./openspec.js";
import type { OpenSpecPrepared, OpenSpecContext } from "./contracts.js";
import { prepareWorktree as prepareWorktreeImpl, collectWorktree as collectWorktreeImpl, publishWorktree as publishWorktreeImpl } from "./workspaces.js";

async function emitActivityEvent(event: Record<string, unknown>, level: "info" | "error" = "info"): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  if (level === "error") console.error(line); else console.log(line);
  const logFile = path.join(path.resolve(process.env.ORCHESTRATOR_DATA_DIR ?? "data"), "logs", "worker-activity-events.jsonl");
  try {
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, `${line}\n`, "utf8");
  } catch (error) {
    console.error(JSON.stringify({ event: "activity.event_log_write_failed", logFile, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function prepareOpenSpecImpl(input: { taskId: string; runId: string; prompt: string; projectRoot: string; artifactsDir: string }): Promise<OpenSpecPrepared> {
  return prepareOpenSpecProject({ ...input, artifactsDir: path.join(input.artifactsDir, input.runId) });
}

async function validateOpenSpecImpl(input: { changeId: string; runId: string; projectRoot: string; artifactsDir: string }): Promise<OpenSpecContext> {
  // Validation failures are deterministic for a given change; retrying cannot help, the workflow decides whether to repair.
  try { return await validateOpenSpecProject({ ...input, artifactsDir: path.join(input.artifactsDir, input.runId) }); }
  catch (error) { throw ApplicationFailure.nonRetryable(error instanceof Error ? error.message : String(error), "OpenSpecValidationError"); }
}

async function archiveOpenSpecChangeImpl(input: { changeId: string; runId: string; projectRoot: string; artifactsDir: string }): Promise<{ archivedPath: string; artifactRef: string }> {
  try { return await archiveOpenSpec({ ...input, artifactsDir: path.join(input.artifactsDir, input.runId) }); }
  catch (error) { throw ApplicationFailure.nonRetryable(error instanceof Error ? error.message : String(error), "OpenSpecArchiveError"); }
}

/**
 * Rechecks the blockers just before the branch is created. Returns the base to build on only when the worker had to assemble it (several blockers and no configured
 * integration branch, ADR 0011); the workflow then uses it instead of the placeholder admitted by the bridge. In every other case it returns nothing, as it always did.
 */
async function checkDependenciesImpl(input: { blockerIds: string[]; parentPublications: ParentPublication[]; repository: RepositoryContext; projectRoot: string }): Promise<{ baseSha: string; prBaseBranch: string } | undefined> {
  if (!input.blockerIds.length) return undefined;
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
  } else if (input.parentPublications.length > 1 && input.repository.integrateParents) {
    const built = await buildIntegrationBase({ projectRoot: input.projectRoot, remote: input.repository.remote, branch: input.repository.branch, parents: input.parentPublications });
    return { baseSha: built.baseSha, prBaseBranch: built.branch };
  } else if (input.parentPublications.length > 1) {
    const integrated = await resolveRemoteBranch(input.projectRoot, input.repository.remote, input.repository.prBaseBranch);
    if (integrated !== input.repository.baseSha) throw new Error(`integrated base '${input.repository.prBaseBranch}' changed after admission; human stack recovery is required`);
    for (const parent of input.parentPublications) await runCommand("git", ["merge-base", "--is-ancestor", parent.headSha, integrated], input.projectRoot).catch(() => { throw new Error(`integrated base no longer contains blocker ${parent.issueId}`); });
  }
  return undefined;
}

export function runCheck(executable: string, args: string[], cwd: string, maxOutputChars = 5000, signal: AbortSignal | undefined = activitySignal()): Promise<{ code: number | null; output: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { command, args: commandArgs } = toolCommand(executable, args);
    const child = spawn(command, commandArgs, { cwd, shell: false, windowsHide: true, env: childEnv() }); const stopKill = killOnAbort(child, signal); const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outBytes = 0; let errBytes = 0;
    child.stdout.on("data", (b: Buffer) => { if (outBytes < 100_000) { stdout.push(b); outBytes += b.length; } });
    child.stderr.on("data", (b: Buffer) => { if (errBytes < 100_000) { stderr.push(b); errBytes += b.length; } });
    child.on("error", error => { stopKill(); reject(error); }); child.on("close", code => { stopKill(); if (signal?.aborted) return reject(new Error("cancelled: process killed")); resolve({ code, output: Buffer.concat(stdout).toString("utf8").slice(0, maxOutputChars), stderr: Buffer.concat(stderr).toString("utf8").slice(0, maxOutputChars) }); });
  });
}

export const REVIEW_DIFF_LIMIT = 60_000;
/** The reviewer always sees the list of changed files; a truncated diff says so and tells the reviewer to read the rest itself. */
export function reviewPromptWithDiff(prompt: string, diff: string, changedFiles = ""): string {
  const truncated = diff.length > REVIEW_DIFF_LIMIT;
  return `${prompt}${changedFiles ? `\n\nChanged files:\n${changedFiles}` : ""}\n\nImplementation diff (review this code against the task requirements):\n${diff.slice(0, REVIEW_DIFF_LIMIT)}${truncated ? `\n[diff truncated at ${REVIEW_DIFF_LIMIT} characters: inspect the remaining changes yourself with git diff and by reading the files before you decide]` : ""}`;
}

/** A Unity project has ProjectSettings/ProjectVersion.txt and an Assets folder. The stack profile is detected from the worktree so the workflow input stays unchanged. */
async function detectUnityProject(root: string): Promise<{ editorVersion: string } | undefined> {
  try {
    await access(path.join(root, "Assets"));
    const editorVersion = parseUnityEditorVersion(await readFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "utf8"));
    if (!editorVersion) throw new Error("ProjectSettings/ProjectVersion.txt has no m_EditorVersion line");
    return { editorVersion };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Unity: one batch import pass through the Unity CLI so the Library, packages and compile state are warm before agents and gates run. Fails closed on licence, version or compile problems. */
async function prepareUnityProject(root: string, editorVersion: string, run: typeof runCheck): Promise<string> {
  const configured = Number(process.env.UNITY_IMPORT_TIMEOUT_SECONDS);
  const timeoutSeconds = Number.isFinite(configured) && configured >= 60 ? Math.min(configured, 840) : 840;
  const result = await run("unity", ["run", root, "--timeout", String(timeoutSeconds), "--no-banner", "--non-interactive"], root, 3000);
  if (result.code !== 0) {
    throw new Error(`Unity import of the isolated task worktree failed (editor ${editorVersion}, exit ${result.code ?? "unknown"})${result.stderr ? `: ${result.stderr}` : result.output ? `: ${result.output}` : ""}`);
  }
  return `Imported the Unity project (editor ${editorVersion}) with the Unity CLI.`;
}

/** Prepare a fresh isolated worktree before agents or quality checks use it: Unity import for a Unity project, then locked npm dependencies when the project has them. */
async function prepareProjectDependenciesImpl(
  projectRoot: string,
  run: typeof runCheck = runCheck,
  preflight: typeof unityPreflight = unityPreflight,
): Promise<{ installed: boolean; summary: string }> {
  const root = path.resolve(projectRoot);
  const unity = await detectUnityProject(root);
  // Environment problems (a long path, a full disk, an Editor or lock left on the worktree) are fixed or named here, before the import spends minutes on them.
  const checked = unity ? await preflight(root) : undefined;
  if (checked?.problems.length) throw ApplicationFailure.nonRetryable(`Unity preflight failed: ${checked.problems.join("; ")}`, "UnityPreflightError");
  const prepared = unity ? await prepareUnityProject(root, unity.editorVersion, run) : undefined;
  const unitySummary = prepared && checked?.fixed.length ? `${prepared} Preflight fixed: ${checked.fixed.join(", ")}.` : prepared;
  try {
    await access(path.join(root, "package.json"));
    await access(path.join(root, "package-lock.json"));
  } catch {
    return { installed: unity !== undefined, summary: unitySummary ?? "No npm package and lockfile pair; dependency installation skipped." };
  }
  const result = await run("npm", ["ci"], root, 3000);
  if (result.code !== 0) {
    throw new Error(`npm ci failed in the isolated task worktree${result.stderr ? `: ${result.stderr}` : result.output ? `: ${result.output}` : ` (exit ${result.code ?? "unknown"})`}`);
  }
  return { installed: true, summary: `${unitySummary ? `${unitySummary} ` : ""}Installed npm dependencies from package-lock.json with npm ci.` };
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
  const qualityWarnings: string[] = []; const visualWarnings: string[] = []; const visualImages: string[] = [];
  if (input.stage === "verify") {
    const checks = input.qualityCommands ?? [];
    if (checks.length === 0 && input.provider !== "fake" && !input.deterministicChecksAlreadyPassed) {
      const durationMs = Date.now() - activityStartedAt;
      await emitActivityEvent({ event: "activity.fail", ...activityContext, provider: "quality-gate", category: "missing_quality_commands", providerDurationMs: 0, activityDurationMs: durationMs, retries: Math.max(0, (info?.attempt ?? 1) - 1) }, "error");
      return { ok: false, summary: "quality gate failed: no deterministic quality commands are configured", findings: ["Configure at least one deterministic verification command."], artifactRefs: [], provider: "quality-gate", durationMs, metadata: { checks: [], passed: false, activityDurationMs: durationMs, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
    }
    const results: NonNullable<typeof qualityChecks> = [];
    // The same commands on the same files gave a pass before (an activity retry, a resumed run, a repair round that changed nothing): the verdict is reused instead of running the suite again. Failures are never reused.
    const reuseKey = qualityKey(checks);
    const fingerprintBefore = checks.length && qualityReuseEnabled() ? await treeFingerprint(input.projectRoot) : undefined;
    const reusable = fingerprintBefore ? findReusable(await readPasses(artifactsDir), reuseKey, fingerprintBefore) : undefined;
    if (reusable) { results.push(...reusable.checks.map(check => ({ ...check, durationMs: 0 }))); qualityWarnings.push(...reusable.warnings, `reused the passing result of verify attempt ${reusable.attempt}: the commands and every file of the working tree are unchanged`); }
    // An Editor the agent left open on this worktree makes every Unity command fail with "instances cannot open the same project".
    if (!reusable && checks.some(check => check.executable === "unity")) { const stopped = await stopProjectEditors(input.projectRoot); if (stopped.length) qualityWarnings.push(`stopped ${stopped.length} Unity process(es) that still had the project open before the checks`); }
    for (const check of reusable ? [] : checks) {
      const checkStartedAt = Date.now();
      const checkCwd = path.resolve(input.projectRoot, check.cwd ?? ".");
      const isUnity = check.executable === "unity";
      if (isUnity) { await waitForProjectUnlock(checkCwd); await clearUnityEvidence(check, checkCwd); }
      let result = await runCheck(check.executable, isUnity ? withUnityDefaults(check.args) : check.args, checkCwd, isUnity ? 20_000 : undefined);
      if (isUnity) {
        // Editor-log lines that describe this machine (the licensing client signature check) are not findings about the project: drop them before anything reads or stores the output.
        result = { ...result, output: stripBenignEditorNoise(result.output), stderr: stripBenignEditorNoise(result.stderr) };
        // The CLI's exit code alone is not a verdict: a green run needs its report or output, and a red one gets a hint on what the code means.
        const evidence = await unityEvidenceProblem(check, checkCwd, result.code);
        const note = [evidence, unityExitHint(check, evidence ? 1 : result.code)].filter(Boolean).join(" ");
        if (evidence || note) result = { code: evidence ? 1 : result.code, output: result.output, stderr: [result.stderr, note].filter(Boolean).join("\n") };
      }
      results.push({ executable: check.executable, args: check.args, exitCode: result.code, durationMs: Date.now() - checkStartedAt, output: result.output, stderr: result.stderr });
      if (result.code !== 0 && check.severity === "warn") {
        qualityWarnings.push(`${check.executable} ${check.args.join(" ")} reported problems (exit ${result.code ?? "unknown"}), non-blocking by configuration: ${[result.output, result.stderr].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 300)}`);
      } else if (result.code !== 0) {
        const failed = path.join(artifactsDir, `quality-${input.attempt}.json`);
        const activityDurationMs = Date.now() - activityStartedAt;
        await writeFile(failed, JSON.stringify({ passed: false, checks: results, activityDurationMs, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) }, null, 2));
        await emitActivityEvent({ event: "activity.fail", ...activityContext, provider: "quality-gate", category: "quality_check_failed", providerDurationMs: 0, activityDurationMs, retries: Math.max(0, (info?.attempt ?? 1) - 1), failedCommand: `${check.executable} ${check.args.join(" ")}` }, "error");
        return { ok: false, summary: `quality check failed: ${check.executable} ${check.args.join(" ")}`, findings: results.map(r => [r.output, r.stderr].filter(Boolean).join("\n")), artifactRefs: [failed], provider: "quality-gate", durationMs: activityDurationMs, metadata: { checks: results, passed: false, activityDurationMs, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
      }
    }
    if (!reusable && fingerprintBefore) {
      // The checks may create files (Unity writes .meta files), so the tree after the run counts too: the next verify of an untouched tree then matches.
      const fingerprintAfter = await treeFingerprint(input.projectRoot);
      await writePass(artifactsDir, { key: reuseKey, fingerprints: [...new Set([fingerprintBefore, ...(fingerprintAfter ? [fingerprintAfter] : [])])], attempt: input.attempt, checks: results, warnings: qualityWarnings.filter(warning => warning.includes("non-blocking by configuration")) }).catch(() => undefined);
    }
    // Game tasks number their acceptance criteria (T3-AC1); each one needs a test that says "Covers: T3-AC1" or an open "Deferred:" note. The tests passing proves nothing about a criterion nobody tested.
    if (checks.some(check => check.executable === "unity")) {
      const testFiles = await readUnityTestFiles(input.projectRoot);
      const missing = [acceptanceProblem(input.prompt, testFiles.map(file => file.text)), sliceProblem(input.prompt, testFiles)].filter(Boolean).join("\n\n") || undefined;
      if (missing) {
        const failed = path.join(artifactsDir, `quality-${input.attempt}.json`);
        const activityDurationMs = Date.now() - activityStartedAt;
        results.push({ executable: "acceptance-trace", args: [], exitCode: 1, durationMs: 0, output: missing, stderr: "" });
        await writeFile(failed, JSON.stringify({ passed: false, checks: results, activityDurationMs }, null, 2));
        await emitActivityEvent({ event: "activity.fail", ...activityContext, provider: "quality-gate", category: "quality_check_failed", providerDurationMs: 0, activityDurationMs, retries: Math.max(0, (info?.attempt ?? 1) - 1), failedCommand: "acceptance-trace" }, "error");
        return { ok: false, summary: "quality check failed: acceptance-trace", findings: results.map(r => [r.output, r.stderr].filter(Boolean).join("\n")), artifactRefs: [failed], provider: "quality-gate", durationMs: activityDurationMs, metadata: { checks: results, passed: false, activityDurationMs, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
      }
    }
    // Leftover TODOs, stubs and skipped tests in the lines this change adds are found by pattern here, not by a paid review (src/review-prefilter.ts); a hit goes through the gate-repair pass.
    if (checks.length && prefilterEnabled()) {
      await runCheck("git", ["add", "--intent-to-add", "--all"], input.projectRoot);
      const added = await runCheck("git", ["diff", "--no-color", "-U0", "HEAD"], input.projectRoot, 1_000_000);
      const flagged = added.code === 0 ? prefilterProblem(prefilterFindings(added.output)) : undefined;
      if (flagged) {
        const failed = path.join(artifactsDir, `quality-${input.attempt}.json`);
        const activityDurationMs = Date.now() - activityStartedAt;
        results.push({ executable: "review-prefilter", args: [], exitCode: 1, durationMs: 0, output: flagged, stderr: "" });
        await writeFile(failed, JSON.stringify({ passed: false, checks: results, activityDurationMs }, null, 2));
        await emitActivityEvent({ event: "activity.fail", ...activityContext, provider: "quality-gate", category: "quality_check_failed", providerDurationMs: 0, activityDurationMs, retries: Math.max(0, (info?.attempt ?? 1) - 1), failedCommand: "review-prefilter" }, "error");
        return { ok: false, summary: "quality check failed: review-prefilter", findings: results.map(r => [r.output, r.stderr].filter(Boolean).join("\n")), artifactRefs: [failed], provider: "quality-gate", durationMs: activityDurationMs, metadata: { checks: results, passed: false, activityDurationMs, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
      }
    }
    const qualityFile = path.join(artifactsDir, `quality-${input.attempt}.json`);
    await writeFile(qualityFile, JSON.stringify({ passed: true, checks: results }, null, 2)); qualityRefs.push(qualityFile);
    qualityChecks = results;
  }
  if (input.verificationOnly) {
    const output: StageOutput = { stage: input.stage, ok: true, summary: "Deterministic quality checks passed before focused review.", findings: [], artifactRefs: qualityRefs, provider: "quality-gate", durationMs: Date.now() - activityStartedAt, metadata: { deterministicQuality: { passed: true, checks: qualityChecks ?? [] }, ...(qualityWarnings.length ? { warnings: qualityWarnings } : {}), verificationOnly: true, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
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
    const diff = await runCheck("git", ["diff", "--binary", "HEAD"], input.projectRoot, REVIEW_DIFF_LIMIT + 1);
    const changed = await runCheck("git", ["diff", "--stat", "--stat-width=140", "HEAD"], input.projectRoot, 6_000);
    if (diff.code !== 0) throw new Error(`could not collect implementation diff for review: ${diff.stderr || diff.output.slice(0, 500)}`);
    stageInput.prompt = reviewPromptWithDiff(input.prompt, diff.output, changed.code === 0 ? changed.output : "");
    // Numbered criteria (game tasks): tell the reviewer which test covers each, so it judges the proof instead of hunting for it.
    const criteria = [...new Set(input.prompt.match(/\bT\d+-AC\d+\b/g) ?? [])];
    const coverage = criteria.length ? coverageTable(criteria, await readUnityTestFiles(input.projectRoot)) : undefined;
    if (coverage) stageInput.prompt += `\n\n${coverage}`;
  }
  if (input.stage === "review" && input.visual?.enabled) {
    // Screenshots are evidence for the reviewer. Problems only warn unless the project requires visual verification.
    const shots = await captureScreenshots(input.visual, { cwd: input.projectRoot, outDir: path.join(artifactsDir, `visual-${input.attempt}`), signal: activitySignal() });
    visualWarnings.push(...shots.warnings); visualImages.push(...shots.images);
    if (shots.images.length) { stageInput.prompt += visualReviewSection(shots.images); stageInput.images = shots.images; }
    else if (input.visual.required) throw ApplicationFailure.nonRetryable(`visual verification is required but no screenshots were captured: ${shots.warnings.join("; ")}`, "VisualVerificationError");
  }
  const withVisual = (metadata: StageOutput["metadata"]): StageOutput["metadata"] => ({ ...metadata, ...(visualWarnings.length ? { warnings: visualWarnings } : {}), ...(visualImages.length ? { screenshots: visualImages } : {}) });
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
  // A task's token budget (manifest `budget`) is checked before every model call, from the usage the earlier stages of this run recorded: a warning near the limit, a hard stop at it.
  if (input.budget && input.provider !== "fake") {
    const spent = budgetStatus((await runUsage(artifactsDir)).units, input.budget);
    if (spent.state === "exceeded") throw ApplicationFailure.nonRetryable(spent.message!, "TokenBudgetExceeded");
    if (spent.state === "warn") visualWarnings.push(spent.message!);
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
  // CLI reviewers (codex, claude) return prose or JSON text; without this the verdict was never enforced and blocking findings passed the gate.
  const providerOutput = input.stage === "review" ? applyReviewAssessment(parsed.data) : parsed.data;
  const out: StageOutput = input.stage === "verify" && input.provider !== "fake"
    ? { ...providerOutput, summary: `${input.deterministicChecksAlreadyPassed ? "Deterministic quality commands passed in the preceding check. " : "Deterministic quality commands passed. "}${providerOutput.summary}`, durationMs: Date.now() - activityStartedAt, metadata: { ...providerOutput.metadata, providerDurationMs: providerOutput.durationMs, activityDurationMs: Date.now() - activityStartedAt, deterministicQuality: { passed: true, checks: qualityChecks ?? [], alreadyPassed: input.deterministicChecksAlreadyPassed ?? false }, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } }
    : { ...providerOutput, durationMs: Date.now() - activityStartedAt, metadata: { ...providerOutput.metadata, providerDurationMs: providerOutput.durationMs, activityDurationMs: Date.now() - activityStartedAt, ...(queueWaitMs !== undefined ? { queueWaitMs } : {}) } };
  const file = path.join(artifactsDir, `${input.stage}-${input.attempt}.json`);
  await writeFile(file, JSON.stringify({ ...out, metadata: withVisual(out.metadata), stage: input.stage, runId: input.runId, taskId: input.taskId, inputHash }, null, 2), { flag: "w" });
  const costUsd = out.metadata?.total_cost_usd;
  await emitActivityEvent({ event: "activity.complete", ...activityContext, provider: out.provider, ok: out.ok, providerDurationMs: out.metadata?.providerDurationMs ?? out.durationMs, activityDurationMs: Date.now() - activityStartedAt, ...(typeof costUsd === "number" ? { costUsd } : {}), retries: Math.max(0, (info?.attempt ?? 1) - 1), ...(input.stage === "verify" ? { checkDurationsMs: (qualityChecks ?? []).map(check => check.durationMs) } : {}) });
  return { ...out, metadata: withVisual(out.metadata), stage: input.stage, artifactRefs: [...out.artifactRefs, ...qualityRefs, ...visualImages, file] };
}
async function timeoutProbeImpl(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 5000)); }

// Every activity heartbeats (see heartbeating): the workflow sets a heartbeatTimeout on all of them.
// The slow ones also log an `activity.timed` event (B-056), so `npm run timing` can show where a task's time went outside the model stages.
export const prepareWorktree = heartbeating(timedActivity("prepareWorktree", prepareWorktreeImpl, emitActivityEvent));
export const collectWorktree = heartbeating(timedActivity("collectWorktree", collectWorktreeImpl, emitActivityEvent));
export const publishWorktree = heartbeating(timedActivity("publishWorktree", publishWorktreeImpl, emitActivityEvent));
export const prepareOpenSpec = heartbeating(timedActivity("prepareOpenSpec", prepareOpenSpecImpl, emitActivityEvent));
export const validateOpenSpec = heartbeating(timedActivity("validateOpenSpec", validateOpenSpecImpl, emitActivityEvent));
export const archiveOpenSpecChange = heartbeating(timedActivity("archiveOpenSpecChange", archiveOpenSpecChangeImpl, emitActivityEvent));
export const checkDependencies = heartbeating(timedActivity("checkDependencies", checkDependenciesImpl, emitActivityEvent));
export const prepareProjectDependencies = heartbeating(timedActivity("prepareProjectDependencies", prepareProjectDependenciesImpl, emitActivityEvent));
export const timeoutProbe = heartbeating(timeoutProbeImpl);

/** Write the analysis document into the task worktree so it is part of the published change. */
async function writeAnalysisDocumentImpl(input: { worktree: string; docsDir: string; taskId: string; markdown: string }): Promise<string> {
  const root = path.resolve(input.worktree);
  const dir = path.resolve(root, input.docsDir);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error(`analysis docsDir '${input.docsDir}' must stay inside the task worktree`);
  const file = path.join(dir, `${input.taskId.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, input.markdown, "utf8");
  return file;
}
export const writeAnalysisDocument = heartbeating(writeAnalysisDocumentImpl);

/** Write a report (research, architecture) into the worktree so publishing commits it. The name is derived from the task id. */
async function writeDocumentImpl(input: { worktree: string; dir: string; name: string; markdown: string }): Promise<string> {
  const root = path.resolve(input.worktree);
  const dir = path.resolve(root, input.dir);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error(`document directory '${input.dir}' must stay inside the task worktree`);
  const file = path.join(dir, `${input.name.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, input.markdown, "utf8");
  return file;
}
export const writeDocument = heartbeating(writeDocumentImpl);

/** The bounded, redacted repository extract an exploration is answered from (ADR 0008). */
async function buildContextPackImpl(input: { worktree: string; terms: string[]; paths: string[]; maxChars?: number }): Promise<ContextPack> {
  return buildPack({ root: input.worktree, terms: input.terms, paths: input.paths, ...(input.maxChars ? { maxChars: input.maxChars } : {}) });
}
export const buildContextPack = heartbeating(timedActivity("buildContextPack", buildContextPackImpl, emitActivityEvent));

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

/** Paths in `git status --porcelain -z` output; a rename or copy entry is followed by its source path, which is skipped. */
export function changedPaths(porcelain: string): Array<{ file: string; untracked: boolean }> {
  const parts = porcelain.split("\0"); const changed: Array<{ file: string; untracked: boolean }> = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index]!;
    if (entry.length < 4) continue;
    changed.push({ file: entry.slice(3), untracked: entry.startsWith("??") });
    if (/^[RC]/.test(entry) || entry[1] === "R" || entry[1] === "C") index++;
  }
  return changed;
}

/**
 * Do not trust the model's claim that the bug is reproduced: undo any change outside the tests, re-run its command and require a failure that carries
 * the signature it announced. A test that passes, or fails for another reason (setup, syntax), proves nothing about the reported defect.
 */
async function verifyReproductionImpl(input: { worktree: string; command: Pick<QualityCommand, "executable" | "args" | "cwd">; expectedFailure: string; testFiles: string[] }): Promise<ReproVerification> {
  const problem = reproductionCommandProblem(input.command);
  if (problem) return { reproduced: false, exitCode: null, evidence: `the reproduction command is not allowed: ${problem}` };
  const root = path.resolve(input.worktree);
  const declared = new Set(input.testFiles.map(file => file.replace(/\\/g, "/").replace(/^\.\//, "")));
  const status = await runCheck("git", ["status", "--porcelain", "-z", "--untracked-files=all"], root, 200_000);
  const reverted: string[] = [];
  for (const { file, untracked } of changedPaths(status.output)) {
    const normalized = file.replace(/\\/g, "/");
    if (TEST_PATH.test(normalized) || declared.has(normalized)) continue;
    const target = path.resolve(root, file);
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    if (untracked) await rm(target, { force: true, recursive: true }); else await runCheck("git", ["checkout", "HEAD", "--", file], root);
    reverted.push(normalized);
  }
  const cwd = path.resolve(root, input.command.cwd ?? ".");
  const result = await runCheck(input.command.executable, input.command.args, cwd, 40_000);
  // Test runners colour their output; escape codes inside "AssertionError: ..." would defeat the signature match.
  const output = stripAnsi([result.output, result.stderr].filter(Boolean).join("\n"));
  const flat = output.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(input.expectedFailure.replace(/\s+/g, " ").trim().toLowerCase());
  // Show the failure itself: around the signature when present, otherwise the end of the output (runners print failures last).
  const excerpt = at >= 0 ? flat.slice(Math.max(0, at - 150), at + 550) : flat.slice(-700);
  const base = reverted.length ? { revertedFiles: reverted } : {};
  if (result.code === 0) return { reproduced: false, exitCode: 0, evidence: `the reproduction test passed, so it does not show the defect${reverted.length ? ` (changes outside the tests were undone: ${reverted.join(", ")})` : ""}`, ...base };
  const squash = (value: string) => value.replace(/\s+/g, " ").toLowerCase();
  if (!squash(output).includes(squash(input.expectedFailure))) return { reproduced: false, exitCode: result.code, evidence: `the command failed, but not with the announced signature "${input.expectedFailure.slice(0, 120)}", so it may fail for an unrelated reason: ${excerpt}`, ...base };
  return { reproduced: true, exitCode: result.code, evidence: excerpt, ...base };
}
export const verifyReproduction = heartbeating(timedActivity("verifyReproduction", verifyReproductionImpl, emitActivityEvent));

/** Post a comment on the draft PR (open review findings for a human to accept or send back). */
async function commentOnPullRequestImpl(input: { worktree: string; prUrl: string; body: string }): Promise<void> {
  if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(input.prUrl)) throw new Error(`refusing to comment on '${input.prUrl}': not a pull request URL`);
  await runCommand("gh", ["pr", "comment", input.prUrl, "--body", input.body.slice(0, 9000)], input.worktree);
}
export const commentOnPullRequest = heartbeating(commentOnPullRequestImpl);

// Project bootstrap steps (ADR 0009) live in their own module; the worker registers every export of this file.
export { prepareBootstrapSandbox, scaffoldProject, materializeIssues } from "./bootstrap-activities.js";
