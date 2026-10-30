import { proxyActivities, defineSignal, defineQuery, setHandler, condition, isCancellation, patched, sleep, workflowInfo } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import { MAX_PAUSE_TOTAL_MS, pauseFrom, pauseWaitMs, type PauseKind } from "./pause-policy.js";
import { classifyFailure } from "./failure-class.js";
import { digestContract } from "./contract-text.js";
import type { OpenSpecPrepared, OpenSpecContext, ProviderRoute, ReviewFinding, RunInput, RunResult, StageInput, StageName, StageOutput } from "./contracts.js";
import { profiles, type WorkflowProfile } from "./profiles.js";
import { LANE_PROFILES, escalationReasons, lanePlan } from "./lanes.js";
import { openSpecProposalPrompt, openSpecChecklistReconcilePrompt, openSpecRepairPrompt, shouldRunOpenSpec } from "./openspec-policy.js";
import { SIMPLICITY_POLICY, SIMPLICITY_REVIEW_POLICY } from "./simplicity.js";
import { deterministicBrief, deterministicDigest, deterministicPlan } from "./fallbacks.js";
import { declaredUnmetAcceptance, isBlockingFinding, isExternalBlocker, openFindingsComment, requireSubstantiatedBlockers, reviewRepairPrompt } from "./review.js";
import { analysisBlock, analysisConstraints, analysisPrompt as makeAnalysisPrompt, formatAnalysisMarkdown, repairAnalysisPrompt, salvageAnalysis, validateAnalysis, type Analysis } from "./analysis.js";
import { DEFAULT_UI_UX_CONFIG, uiUxGuidance } from "./uiux.js";
import { taskTypes } from "./task-types.js";
import { diagnosePrompt, diagnosisBlock, diagnosisConstraints, formatDiagnosisMarkdown, hintFromDiagnosis, hintFromReproduction, needsInfoMessage, regressionGate, repairDiagnosisPrompt, repairReproductionPrompt, reproducePrompt, salvageDiagnosis, validateDiagnosis, validateReproduction, type BugOutcome, type Diagnosis, type ReproVerification, type Reproduction } from "./bug.js";
import { testStrategy } from "./test-strategy.js";
import { deterministicGameDesign, gameDesignPrompt, isGame, isUnityGame, repairGameDesignPrompt, unityStackDecision, validateGameDesign, type GameDesign } from "./game.js";
import { blueprintPrompt, buildIssuePlan, charterPrompt, deterministicBlueprint, deterministicCharter, deterministicStack, planLimits, repairBlueprintPrompt, repairCharterPrompt, repairStackPrompt, salvageBlueprint, stackPrompt, validateBlueprint, validateCharter, validateStack, type Blueprint, type BootstrapState, type Charter, type StackDecision } from "./bootstrap.js";
import { renderPlanSummary } from "./bootstrap-docs.js";
import { usableTemplate } from "./bootstrap-templates.js";
import { deterministicScope, explorePrompt, formatReportMarkdown, rawReport, repairReportPrompt, repairScopePrompt, scopePrompt, validateReport, validateScope, type Report, type ReportKind, type Scope } from "./research.js";
import { assertTokenBudget, BRIEF_HARD_CEILING, BRIEF_SCHEMA_HINT, changeOnlyContext, PLAN_SCHEMA_HINT, repairStructuredPrompt, specSizeWarnings, type OpenSpecDigest, briefPrompt as makeBriefPrompt, canonicalizeBrief, compressBriefPrompt, compressPlanPrompt, estimateTokens, extractHardConstraints, extractTaskConstraints, ExecutionBriefSchema, formatBrief, HANDOFF_BUDGETS, openSpecOptimizationPrompt, repairOpenSpecDigestPrompt, parseStructured, PlanSchema, planningPrompt as makePlanningPrompt, validateBrief, validateBriefCompression, validateOpenSpecDigest, validatePlanCompression, type ExecutionBrief, type Plan } from "./handoffs.js";

const { executeStage } = proxyActivities<typeof activities>({ startToCloseTimeout: "6 hours", heartbeatTimeout: "90 seconds", cancellationType: "WAIT_CANCELLATION_COMPLETED", retry: { initialInterval: "1 second", maximumInterval: "15 seconds", maximumAttempts: 2 } });
const { prepareWorktree, collectWorktree, publishWorktree, checkDependencies, prepareProjectDependencies, writeAnalysisDocument, writeDocument, buildContextPack, verifyReproduction, commentOnPullRequest, assessChanges } = proxyActivities<typeof activities>({ startToCloseTimeout: "16 minutes", heartbeatTimeout: "90 seconds", retry: { initialInterval: "1 second", maximumInterval: "15 seconds", maximumAttempts: 2 } });
const { prepareOpenSpec, validateOpenSpec, archiveOpenSpecChange } = proxyActivities<typeof activities>({ startToCloseTimeout: "16 minutes", heartbeatTimeout: "90 seconds", retry: { initialInterval: "1 second", maximumInterval: "15 seconds", maximumAttempts: 2 } });
// Bootstrap steps (ADR 0009): one attempt each, because a retry of a half-finished scaffold or issue creation would duplicate work; the activities report precisely what exists.
const { prepareBootstrapSandbox, scaffoldProject, materializeIssues } = proxyActivities<typeof activities>({ startToCloseTimeout: "60 minutes", heartbeatTimeout: "90 seconds", retry: { maximumAttempts: 1 } });
// Reporting the finished run to Paperclip (ADR 0018): idempotent, so it may retry for a long time without posting twice.
const { reportResult } = proxyActivities<typeof activities>({ startToCloseTimeout: "2 minutes", retry: { initialInterval: "5 seconds", maximumInterval: "1 minute", maximumAttempts: 8 } });
// The connection check while a network pause waits: one quick attempt, no retries (the workflow loop is the retry).
const { probeConnectivity } = proxyActivities<typeof activities>({ startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } });
const { timeoutProbe } = proxyActivities<typeof activities>({ startToCloseTimeout: "1 second", retry: { initialInterval: "100 milliseconds", maximumInterval: "100 milliseconds", maximumAttempts: 2 } });
export const approveSignal = defineSignal<[boolean]>("approval");
export const progressQuery = defineQuery<{ currentStage: string | null; completedStages: string[]; /** Set while a stage waits for a usage limit to reset or the connection to return. */ paused?: { kind: PauseKind; stage: string; waitMs: number; count: number; reason: string } }>("progress");
export const bootstrapStateQuery = defineQuery<BootstrapState>("bootstrap");

export function stageRoute(input: RunInput, stage: StageName) {
  const fallback: ProviderRoute = { provider: input.provider ?? "fake" };
  return input.providerRouting?.[stage] ?? fallback;
}
/** OpenSpec runs on the manifest's "openspec" route; without one it keeps using Codex, whatever the project default provider is. */
export function openSpecRoute(input: Pick<RunInput, "providerRouting">): ProviderRoute {
  return input.providerRouting?.openspec ?? { provider: "codex" };
}
export function failureDetails(error: unknown, maxLength = 1800): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current.message) messages.push(current.message);
    current = current.cause;
  }
  return (messages.join(" <- ") || "unknown error").slice(0, maxLength);
}

function stageCompletionTokens(output: StageOutput): number | undefined {
	const metadata = output.metadata as { usage?: { completion_tokens?: unknown; output_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } }; codexActivity?: { usage?: { completion_tokens?: unknown; output_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } } } } | undefined;
  const usage = metadata?.usage ?? metadata?.codexActivity?.usage;
  const count = usage?.completion_tokens ?? usage?.output_tokens;
	const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
	return typeof count === "number" && Number.isFinite(count)
		? Math.max(0, count - (typeof reasoning === "number" && Number.isFinite(reasoning) ? reasoning : 0))
		: undefined;
}

export function openSpecContextPrompt(taskPrompt: string, context: string): string {
  return `${taskPrompt}\n\nVALIDATED OPENSPEC CONTEXT — follow these requirements and the implementation checklist exactly. Do not weaken or omit acceptance criteria. During implementation and repair, use the $openspec-apply-change workflow and mark checklist items complete only after their code and validation are complete. Do not archive the change or sync specs yourself; the orchestrator archives it after the quality gates pass.\n\n${context}`;
}

export function plannedTaskPrompt(taskPrompt: string, planningSummary: string): string {
  return planningSummary.trim() ? `${taskPrompt}\n\nPLANNING STAGE OUTPUT — treat this as the implementation plan, preserving all OpenSpec requirements above:\n${planningSummary}` : taskPrompt;
}

export function effectiveMaxReviewRounds(input: Pick<RunInput, "maxReviewRounds" | "maxRepairAttempts">): number {
  if (input.maxReviewRounds !== undefined) return Math.max(1, Math.min(4, Math.trunc(input.maxReviewRounds)));
  if (input.maxRepairAttempts !== undefined) return Math.max(1, Math.min(4, Math.trunc(input.maxRepairAttempts) + 1));
  return 2;
}

export function blockingFindings(output: StageOutput): ReviewFinding[] {
  if (output.review) return output.review.findings.filter(isBlockingFinding);
  return output.ok ? [] : output.findings.map(title => ({ severity: "high", category: "functional", title: title.slice(0, 180), evidence: title, fixableInCode: true }));
}

export function externalBlockers(output: StageOutput): ReviewFinding[] {
  return output.review?.findings.filter(isExternalBlocker) ?? [];
}

/** The implementer's last message is read by the reviewer in every round, so its shape is fixed and short: facts, not narrative. The work itself is never shortened. */
export const REPORT_STYLE = `FINAL MESSAGE (read by the reviewer; keep it short): at most 12 bullet lines, no code listings, no restating of the task. Sections in this order: Changed (file: what, one line each); Verified (each command you ran and its result counts); Decisions (only what a reviewer could not infer); UNMET_ACCEPTANCE: none, or one bullet per item you could not meet and why.`;
/** A summary longer than this is cut when it is shown to the reviewer; the head holds the changes, the tail the unmet items, so both ends are kept. */
export const REVIEW_SUMMARY_LIMIT = 2500;
const cutSummary = (summary: string): string => summary.length <= REVIEW_SUMMARY_LIMIT ? summary : `${summary.slice(0, Math.floor(REVIEW_SUMMARY_LIMIT * 0.6))}\n[... ${summary.length - REVIEW_SUMMARY_LIMIT} characters left out ...]\n${summary.slice(-Math.floor(REVIEW_SUMMARY_LIMIT * 0.4))}`;
export function implementationPrompt(taskPrompt: string, repairFindings?: ReviewFinding[], qualityCommands: StageInput["qualityCommands"] = [], uiUxContext = "", analysisDecisions = "", contractContext = ""): string {
  const configuredChecks = qualityCommands.length
    ? `\nThe orchestration will run these configured deterministic checks as a publication gate after implementation/review${repairFindings?.length ? "; after repair it runs them before the follow-up review" : ""}:\n${qualityCommands.map(check => `- ${check.executable} ${check.args.join(" ")}${check.cwd ? ` (cwd: ${check.cwd})` : ""}`).join("\n")}`
    : "\nNo deterministic checks are configured; report this as a blocking delivery risk.";
  const deliveryContract = `Implement the brief and satisfy every acceptance_check. Follow existing project patterns; make the smallest complete change. Deliver production-ready work: clean code that reads like its surroundings, and meaningful tests (regression coverage plus the edge cases and boundaries of the behaviour). Run the checks yourself before you finish: the project's full test suite and its build or typecheck (for example npm test and npm run build). Fix every failure; never leave a test broken, skipped, weakened or deleted, and never rely on the orchestration's gates to find problems for you. If you cannot run a check in this environment, say so plainly with the exact reason and do not claim it passed. Inspect the diff and report changed files and test results accurately. Do not decide on your own that a requirement is unnecessary or infeasible and ship a weaker variant: if you could not satisfy an acceptance check, say which one and why. End your answer with one line, "UNMET_ACCEPTANCE: none", or "UNMET_ACCEPTANCE:" followed by one line per unmet check; unmet checks are sent back for rework. The orchestration runs configured quality gates again afterwards.

${SIMPLICITY_POLICY}${configuredChecks}\n\n${testStrategy(qualityCommands)}

${REPORT_STYLE}`;
  const guidance = [uiUxContext, analysisDecisions, digestContract(contractContext)].filter(Boolean).map(part => `\n\n${part}`).join("");
  if (!repairFindings?.length) return `${taskPrompt}${guidance}\n\n${deliveryContract}`;
  const repairList = repairFindings.map((finding, index) => `${index + 1}. [${finding.severity}/${finding.category}] ${finding.title}\n   Evidence: ${finding.evidence}${finding.acceptanceCriterion ? `\n   Acceptance criterion: ${finding.acceptanceCriterion}` : ""}${finding.scenario ? `\n   Scenario: ${finding.scenario}` : ""}`).join("\n");
  return `${taskPrompt}${guidance}\n\n${deliveryContract}\n\nREPAIR: One bounded repair pass remains. Resolve each blocker below with the smallest complete fix; add or update a regression test. Run focused tests; the orchestration runs its quality gate before follow-up review. Report each resolution and any unresolved blocker with evidence.\n${repairList}`;
}

export function reviewPrompt(taskPrompt: string, stageResults: StageOutput[], reviewNumber: number, repeatFailure = false, verificationPending = false, uiUxContext = "", analysisDecisions = "", contractContext = ""): string {
  let reviewChecklist = taskPrompt;
  try {
    const brief = JSON.parse(taskPrompt) as Partial<ExecutionBrief>;
    if (Array.isArray(brief.acceptance_checks)) {
      reviewChecklist = [
        "Acceptance checks:", ...brief.acceptance_checks.map(item => `- ${item}`),
      ].join("\n");
    }
  } catch { /* compatibility for callers that supply a plain checklist */ }
  const implementations = stageResults.filter(result => result.stage === "implement");
  const summaries = implementations.map((result, index) => `Implementation ${index + 1}: ${cutSummary(result.summary)}`).join("\n\n");
  const priorReview = [...stageResults].reverse().find(result => result.stage === "review");
  const previousFindings = priorReview?.review?.findings.length
    ? priorReview.review.findings.filter(f => (f.severity === "critical" || f.severity === "high") && f.fixableInCode).map(f => `- [${f.severity}/${f.category}] ${f.title}: ${f.evidence}${f.acceptanceCriterion ? ` (criterion: ${f.acceptanceCriterion})` : ""}`).join("\n")
    : priorReview?.findings.length ? priorReview.findings.map(finding => `- ${finding}`).join("\n")
    : "No prior actionable review findings.";
  const verification = [...stageResults].reverse().find(result => result.stage === "verify");
  const verificationChecks = Array.isArray(verification?.metadata?.checks)
    ? (verification.metadata.checks as Array<{ executable?: unknown; args?: unknown; exitCode?: unknown; output?: unknown; stderr?: unknown }>)
      .map((check, index) => {
        const command = [String(check.executable ?? ""), ...(Array.isArray(check.args) ? check.args.map(String) : [])].filter(Boolean).join(" ");
        const evidence = [check.output, check.stderr].filter(value => typeof value === "string" && value.length).map(value => String(value).slice(-1200)).join("\n");
        return `${index + 1}. ${command || "deterministic check"} (exit ${String(check.exitCode ?? "unknown")})${evidence ? `\n${evidence}` : ""}`;
      }).join("\n")
    : "";
  const verificationSummary = verification
    ? `\nDeterministic check result before this review: ${verification.ok ? "PASS" : "FAIL"}. ${verification.summary}${verificationChecks ? `\nCheck evidence:\n${verificationChecks.slice(0, 9000)}` : ""}\n`
    : "";
  const reviewMode = reviewNumber <= 1
    ? `FIRST REVIEW — check this checklist against the full diff and relevant tests. Also check correctness, regressions, security, accessibility/responsive behavior, and test coverage. Report EVERY blocking problem you can substantiate in this single pass, not only the most salient one: a follow-up round only re-checks your list, so a problem left out now can no longer block. Report substantiated findings only.${verificationSummary}\n${reviewChecklist}`
    : `FOLLOW-UP REVIEW ${reviewNumber} — verify only prior blockers, the acceptance checks, and regressions introduced by repair. Do not restart broad review or repeat fixed findings. A new blocking finding is allowed only for a defect the repair introduced, shown by a concrete scenario; asking for code or tests to be stricter, more thorough or differently structured is not a defect. If all fixes are correct, return pass.\n\nPrior blocking findings:\n${previousFindings}${verificationSummary}\n${reviewChecklist}`;
  const checkStatus = verificationPending ? "Deterministic checks are running concurrently with this review. Do not infer their result, treat their pending status as a defect, or claim that they passed or failed." : "Deterministic checks are authoritative; report their supplied result without overriding it.";
  const uiChecks = uiUxContext ? "\nUI checks: responsive reflow, keyboard access, semantics, contrast, reduced motion, and relevant loading/empty/error states." : "";
  const analysisReviewText = analysisDecisions ? `\n\n${analysisDecisions}\nReview against these analysis decisions: report a blocking finding if the implementation contradicts a chosen parameter or lacks a test for a validation property.` : "";
  const contractReviewText = contractContext ? `\n\n${digestContract(contractContext)}\nReview against the contract: report a blocking finding only when the diff adds scope that the contract's non-goals or boundaries exclude, or breaks a drift rule, and the acceptance checks do not require it. Give the concrete scenario.` : "";
  const prompt = `${repeatFailure ? "[INJECT_REVIEW_FAILURE]\n" : ""}${reviewMode}${uiChecks}${analysisReviewText}${contractReviewText}\n\n${summaries ? `Implementation summary:\n${summaries}` : "No implementation summary is available."}\n\n${SIMPLICITY_REVIEW_POLICY}

Return exactly one JSON object: {"verdict":"pass"|"needs_changes","findings":[{"severity":"critical"|"high"|"medium"|"low"|"info","category":"functional"|"acceptance"|"regression"|"security"|"accessibility"|"tests"|"environment"|"approval"|"polish"|"other","title":"short issue","evidence":"specific evidence","acceptanceCriterion":"optional","scenario":"a concrete input or state and the wrong result it produces","fixableInCode":true|false}],"notes":[same objects]}. Only critical/high code-fixable issues belong in findings; environment/approval blockers use fixableInCode=false. Evidence standard: every critical/high finding must carry a scenario (for a test finding: a real defect the test would let through). If you cannot state one, it is a note, not a finding; remarks that code or tests could be stricter, more thorough or differently structured are notes. Do not execute commands. ${checkStatus}`;
  return prompt;
}

/**
 * The workflow entry. A run started with `reportToPaperclip` reports its own result to the Paperclip issue as its last step, so the task is updated even when the adapter has lost its lease
 * (ADR 0018). Without the flag (every run recorded before this existed) it is exactly the pipeline below.
 */
export async function projectWorkflow(input: RunInput): Promise<RunResult> {
  const result = await runProject(input);
  if (!input.reportToPaperclip) return result;
  try {
    const outcome = await reportResult({ workflowId: workflowInfo().workflowId, issueId: input.taskId, result });
    return outcome.reported ? { ...result, reportedToPaperclip: true } : result;
  } catch (error) {
    if (isCancellation(error)) throw error;
    return result; // the adapter or the reconcile step reports it instead
  }
}

async function runProject(input: RunInput): Promise<RunResult> {
  const taskType = input.taskType ? taskTypes[input.taskType] : undefined;
  const investigating = taskType?.flow === "investigation";
  const profile = profiles[taskType?.profile ?? input.profile];
  if (!profile) return { runId: input.runId, status: "failed", stages: [], artifactRefs: [], message: `unknown profile '${input.profile}'` };
  const uiUxContext = profile.stages.includes("implement") ? uiUxGuidance({ prompt: input.prompt, frameworks: input.uiUxFrameworks, config: input.uiUx ?? DEFAULT_UI_UX_CONFIG }) : "";
  // The project contract (ADR 0011) is data on the input, so runs started before it existed replay unchanged. It reaches the plan, implement and review prompts of code tasks.
  const contractContext = profile.stages.includes("implement") ? input.projectContract ?? "" : "";
  if (input.injectActivityTimeout) {
    try { await timeoutProbe(); } catch (error) { if (isCancellation(error)) throw error; return { runId: input.runId, status: "failed", stages: [], artifactRefs: [], message: `Activity timed out after bounded retries: ${failureDetails(error)}` }; }
  }
  const stages: StageOutput[] = []; const artifactRefs: string[] = []; let approved = !input.approval; let rejected = false;
  let currentStage: string | null = null; const completedStages: string[] = [];
  let pausedState: { kind: PauseKind; stage: string; waitMs: number; count: number; reason: string } | undefined;
  setHandler(progressQuery, () => ({ currentStage, completedStages: [...completedStages], ...(pausedState ? { paused: pausedState } : {}) }));
  let workspace = input.projectRoot;
  if (profile.stages.includes("implement") && stageRoute(input, "implement").provider !== "fake" && !input.repository) return { runId: input.runId, status: "failed", stages, artifactRefs, message: "GitHub publication is required for code workflows; configure a clean GitHub repository, target branch, and remote before dispatch." };
  if (profile.stages.includes("implement") && profile.stages.includes("verify") && stageRoute(input, "implement").provider !== "fake" && (input.qualityCommands ?? []).length === 0 && patched("require-quality-commands")) return { runId: input.runId, status: "failed", stages, artifactRefs, message: "No deterministic quality commands are configured for this project and profile, so nothing could verify the implementation. Add qualityCommands (for example npm test) to the project manifest before running code tasks." };
  if (investigating && stageRoute(input, "explore").provider !== "fake" && !input.repository) return { runId: input.runId, status: "failed", stages, artifactRefs, message: "Research and architecture reports are published as a draft PR document; configure a clean GitHub repository, target branch, and remote before dispatch." };
  // The repository the task is built and published on. It is the admitted one unless the worker assembled the base from several blockers (ADR 0011); runs recorded before that
  // existed got no result from the check, so they keep the admitted base on replay.
  let repository = input.repository;
  if ((profile.stages.includes("implement") || investigating) && input.repository) {
    try {
      const assembled = await checkDependencies({ blockerIds: input.blockerIds ?? [], parentPublications: input.parentPublications ?? [], repository: input.repository, projectRoot: input.projectRoot });
      repository = assembled ? { ...input.repository, baseSha: assembled.baseSha, prBaseBranch: assembled.prBaseBranch } : input.repository;
      workspace = await prepareWorktree({ runId: input.runId, projectRoot: input.projectRoot, baseSha: repository.baseSha, branch: repository.branch, requiredSourcePaths: repository.requiredSourcePaths });
      currentStage = "dependencies";
      await prepareProjectDependencies(workspace);
      completedStages.push("dependencies");
    } catch (error) {
      return { runId: input.runId, status: "failed", stages, artifactRefs, message: `admission recheck failed before branch creation: ${failureDetails(error)}` };
    }
  }
  setHandler(approveSignal, (value) => { approved = value; rejected = !value; });
  const maxRounds = effectiveMaxReviewRounds(input); let repairCount = 0; let gateRepairCount = 0; let reviewCount = 0; let findingsFixed = 0; let stopReason: string | undefined;
  const nonBlockingNotes: ReviewFinding[] = []; const unresolvedFindings: ReviewFinding[] = [];
  const warnings: Array<{ stage: string; message: string }> = [];
  const reviewRuns: NonNullable<RunResult["metadata"]>["review"]["reviewRuns"] = [];
  const recordReview = (output: StageOutput, round: number) => {
    const blockingCount = blockingFindings(output).length;
    reviewRuns.push({ round, provider: output.provider, durationMs: output.durationMs, verdict: output.review?.verdict ?? (output.ok ? "pass" : "unstructured"), blockingFindingCount: blockingCount, nonBlockingNoteCount: output.review?.notes.length ?? 0, ...(output.metadata?.usage !== undefined ? { usage: output.metadata.usage } : {}) });
  };
  let openSpecInfo: NonNullable<RunResult["metadata"]>["openSpec"];
  let gateCommands = input.qualityCommands ?? [];
  let openFindings: ReviewFinding[] = [];
  let investigationConstraints: string[] = [];
  const resultMetadata = () => ({ ...(taskType ? { taskType: taskType.id } : {}), review: { maxReviewRounds: maxRounds, reviewCount, repairCount, findingsFixed, reviewRuns: [...reviewRuns], nonBlockingNotes: [...nonBlockingNotes], unresolvedFindings: [...unresolvedFindings], ...(stopReason ? { stopReason } : {}) }, ...(openSpecInfo ? { openSpec: openSpecInfo } : {}), ...(warnings.length ? { warnings: [...warnings] } : {}) });
  // Warnings travel in the final message because the Paperclip adapter already posts that message into the issue.
  const withWarnings = (message: string): string => warnings.length ? `${message} (${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${warnings.map(warning => `${warning.stage}: ${warning.message}`).join(" | ").slice(0, 1200)})` : message;
  const finish = (status: RunResult["status"], message: string): RunResult => ({ runId: input.runId, status, stages, artifactRefs, message, metadata: resultMetadata() });
  let workflowPrompt = input.prompt;
  let openSpecContext = "";
  let optimizedOpenSpec = "";
  let planningTaskGoal = "";
  let analysis: Analysis | undefined;
  let analysisDecisions = "";
  let analysisNote: string | undefined;
  let plan: Plan | undefined;
  let executionBrief: ExecutionBrief | undefined;
  let openSpecChangeId: string | undefined;
  let deterministicVerification: StageOutput | undefined;
  const openSpecRouteOptions = (({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort }))(openSpecRoute(input));
  const limitedProviders = new Set<string>();
  const execute = async (stage: StageName, options: { prompt?: string; provider?: string; model?: string; reasoningEffort?: StageInput["reasoningEffort"]; providerTimeoutMs?: number; verificationOnly?: boolean; deterministicChecksAlreadyPassed?: boolean; qualityCommands?: StageInput["qualityCommands"]; openSpecChangeId?: string } = {}): Promise<StageOutput> => {
    const route = stageRoute(input, stage === "brief" || stage === "spec_optimize" ? "plan" : stage); const stageAttempt = stages.filter(item => item.stage === stage).length + 1;
    const defaultPrompt = stage === "implement" ? implementationPrompt(executionBrief ? formatBrief(executionBrief) : "", undefined, gateCommands, uiUxContext, analysisDecisions, contractContext) : stage === "plan" ? makePlanningPrompt(planningTaskGoal || workflowPrompt, optimizedOpenSpec, uiUxContext, analysisDecisions, contractContext) : stage === "brief" ? (plan ? makeBriefPrompt(workflowPrompt, openSpecContext, plan) : "") : workflowPrompt;
    const args: StageInput = { runId: input.runId, taskId: input.taskId, projectId: input.projectId, profile: input.profile, stage, prompt: options.prompt ?? defaultPrompt, attempt: stageAttempt, provider: options.provider ?? route.provider, model: options.model ?? route.model, reasoningEffort: options.reasoningEffort ?? route.reasoningEffort, providerTimeoutMs: options.providerTimeoutMs ?? input.providerTimeouts?.[stage] ?? (stage === "openspec" ? 720_000 : undefined), projectRoot: workspace, artifactsDir: input.artifactsDir, plugins: input.plugins ?? [], qualityCommands: options.qualityCommands ?? gateCommands, verificationOnly: options.verificationOnly, deterministicChecksAlreadyPassed: options.deterministicChecksAlreadyPassed, openSpecChangeId: options.openSpecChangeId };
    if (stage === "review" && input.visual) args.visual = input.visual;
    if (input.budget) args.budget = input.budget;
    // A usage limit or a lost connection waits on a timer and runs the same stage again without spending its retry attempts (ADR 0016); a pause that outlasts MAX_PAUSE_TOTAL_MS surfaces as a failure.
    // patched(): runs recorded before this change saw such a failure as an ordinary activity error.
    let output: StageOutput;
    // A usage limit on a route with fallbacks moves the stage to the next route instead of waiting (ADR 0019); a caller that chose its own provider keeps it.
    const fallbacks = options.provider ? [] : [...(route.fallback ?? [])];
    // A provider that already hit its limit in this run is not tried again first by the next stage.
    while (fallbacks.length > 0 && limitedProviders.has(args.provider)) { const skip = fallbacks.shift()!; Object.assign(args, { provider: skip.provider, model: skip.model, reasoningEffort: skip.reasoningEffort }); }
    for (let pauses = 0, waitedMs = 0; ; pauses++) {
      try { output = await executeStage(args); break; }
      catch (error) {
        const pause = isCancellation(error) ? undefined : pauseFrom(error);
        if (!pause || !patched("provider-pause")) throw error;
        const next = pause.kind === "quota" && fallbacks.length > 0 && patched("provider-fallback") ? fallbacks.shift() : undefined;
        if (next) {
          warnings.push({ stage, message: `${args.provider} hit a usage limit (${pause.reason.slice(0, 160)}); this stage continues on ${next.provider}${next.model ? `:${next.model}` : ""}` });
          limitedProviders.add(args.provider);
          Object.assign(args, { provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort });
          pauses--; continue;
        }
        let wait = pauseWaitMs(pause.kind, pause.waitMs, pauses);
        if (waitedMs + wait > MAX_PAUSE_TOTAL_MS) throw new Error(`provider ${pause.kind} pause exceeded ${Math.round(MAX_PAUSE_TOTAL_MS / 3_600_000)} hours in stage ${stage}: ${pause.reason}`);
        pausedState = { kind: pause.kind, stage, waitMs: wait, count: pauses + 1, reason: pause.reason };
        try {
          await sleep(wait); waitedMs += wait;
          // After a lost connection, wait until the network answers before spending a model call again.
          while (pause.kind === "network" && !(await probeConnectivity().then(result => result.online, () => false))) {
            wait = pauseWaitMs("network", undefined, ++pauses);
            if (waitedMs + wait > MAX_PAUSE_TOTAL_MS) throw new Error(`provider network pause exceeded ${Math.round(MAX_PAUSE_TOTAL_MS / 3_600_000)} hours in stage ${stage}: ${pause.reason}`);
            pausedState = { kind: "network", stage, waitMs: wait, count: pauses + 1, reason: pause.reason };
            await sleep(wait); waitedMs += wait;
          }
        } finally { pausedState = undefined; }
      }
    }
    // Warnings reported by an activity (non-blocking quality commands, screenshot capture problems) reach the final message once.
    const reported = output.metadata?.warnings;
    if (Array.isArray(reported)) for (const message of reported) if (typeof message === "string" && !warnings.some(item => item.stage === stage && item.message === message)) warnings.push({ stage, message });
    stages.push(output); artifactRefs.push(...output.artifactRefs); return output;
  };
  // One recovery policy for every stage whose answer must be structured: validate, give the stage up to `repairs` repair attempts that carry the
  // validator's diagnostics, then use the deterministic fallback when there is one, and only otherwise fail with the last diagnostic. Infrastructure
  // failures (the activity itself failing after its bounded retries) are not repaired here; they propagate.
  const structuredStage = async <T>(spec: { stage: StageName; prompt: string; parse: (output: StageOutput) => T; repairPrompt: (previous: StageOutput, diagnostic: string, attempt: number) => string; repairs?: number; fallback?: () => T }): Promise<{ value: T; output: StageOutput; degraded?: string }> => {
    let output = await execute(spec.stage, { prompt: spec.prompt });
    let lastError: unknown = output.ok ? undefined : new Error(`${spec.stage} stage reported a failure: ${output.summary.slice(0, 300)}`);
    if (output.ok) {
      try { return { value: spec.parse(output), output }; }
      catch (error) { if (isCancellation(error)) throw error; lastError = error; }
    }
    for (let attempt = 1; attempt <= (spec.repairs ?? 1); attempt++) {
      output = await execute(spec.stage, { prompt: spec.repairPrompt(output, failureDetails(lastError, 3000), attempt) });
      if (!output.ok) { lastError = new Error(`${spec.stage} repair reported a failure: ${output.summary.slice(0, 300)}`); continue; }
      try { return { value: spec.parse(output), output }; }
      catch (error) { if (isCancellation(error)) throw error; lastError = error; }
    }
    if (spec.fallback) {
      const degraded = failureDetails(lastError, 600);
      output.metadata = { ...output.metadata, degraded, fallback: "deterministic" };
      warnings.push({ stage: spec.stage, message: `a deterministic fallback replaced the model answer after it failed validation: ${degraded.slice(0, 300)}` });
      return { value: spec.fallback(), output, degraded };
    }
    throw lastError;
  };
  // A deterministic check that fails because of the code gets one bounded repair pass: the check's own output goes to an implement stage, then the checks run again. Failures caused by the
  // machine (a licence, a locked project, a long path) are not repaired here; a code change cannot fix them, and the run is resumed after the cause is healed instead. patched(): runs recorded
  // before this existed ended at the failed check.
  const GATE_REPAIR_LIMIT = 1;
  const repairGate = async (failed: StageOutput): Promise<StageOutput> => {
    if (failed.ok || gateRepairCount >= GATE_REPAIR_LIMIT || !executionBrief) return failed;
    const evidence = [failed.summary, ...failed.findings].join("\n");
    if (classifyFailure({ message: evidence, stopReason: "verify_quality_gate_failed" }).kind !== "gate" || !patched("gate-repair")) return failed;
    gateRepairCount++;
    const finding: ReviewFinding = { severity: "high", category: "tests", title: `Deterministic gate failed: ${failed.summary.slice(0, 200)}`, evidence: evidence.slice(0, 6000), fixableInCode: true };
    warnings.push({ stage: "verify", message: `a deterministic check failed (${failed.summary.slice(0, 160)}); one repair pass ran before the checks were repeated` });
    try { await execute("implement", { prompt: implementationPrompt(formatBrief(executionBrief), [finding], gateCommands, uiUxContext, analysisDecisions, contractContext) }); }
    catch (error) { if (isCancellation(error)) throw error; return failed; }
    return await execute("verify", { provider: "fake", verificationOnly: true });
  };
  if (shouldRunOpenSpec(input.openSpec, profile.stages)) {
    if (!input.repository || workspace === input.projectRoot) return finish("failed", "OpenSpec requires an isolated Git worktree; configure a repository for this implementation task.");
    currentStage = "openspec";
    try {
      const prepared: OpenSpecPrepared = await prepareOpenSpec({ taskId: input.taskId, runId: input.runId, prompt: input.prompt, projectRoot: workspace, artifactsDir: input.artifactsDir });
      openSpecChangeId = prepared.changeId;
      artifactRefs.push(prepared.artifactRef);
      const output = await execute("openspec", { ...openSpecRouteOptions, providerTimeoutMs: input.providerTimeouts?.openspec ?? 720_000, openSpecChangeId, prompt: openSpecProposalPrompt({ taskPrompt: input.prompt, changeId: prepared.changeId }) });
      if (!output.ok) { stopReason = "openspec_proposal_failed"; return finish("failed", "OpenSpec proposal stage did not complete successfully."); }
      const validateInput = { changeId: prepared.changeId, runId: input.runId, projectRoot: workspace, artifactsDir: input.artifactsDir };
      let validated: OpenSpecContext;
      try { validated = await validateOpenSpec(validateInput); }
      catch (validationError) {
        // Models often get the delta format wrong; give the proposal stage one bounded repair pass with the validator's diagnostics.
        if (isCancellation(validationError) || !patched("openspec-validation-repair")) throw validationError;
        const repaired = await execute("openspec", { ...openSpecRouteOptions, providerTimeoutMs: input.providerTimeouts?.openspec ?? 720_000, openSpecChangeId, prompt: openSpecRepairPrompt({ taskPrompt: input.prompt, changeId: prepared.changeId, diagnostics: failureDetails(validationError, 6000) }) });
        if (!repaired.ok) { stopReason = "openspec_repair_failed"; return finish("failed", "OpenSpec validation repair did not complete successfully."); }
        validated = await validateOpenSpec(validateInput);
      }
      artifactRefs.push(validated.artifactRef);
      openSpecContext = changeOnlyContext(validated.context);
      for (const message of [...(validated.warnings ?? []), ...specSizeWarnings(openSpecContext)]) warnings.push({ stage: "openspec", message });
      openSpecInfo = { changeId: prepared.changeId, version: validated.version, contextArtifact: validated.artifactRef };
      output.metadata = { ...output.metadata, openSpec: { changeId: prepared.changeId, version: validated.version, validated: true, contextArtifact: validated.artifactRef } };
      completedStages.push("openspec");
      currentStage = "spec_optimize";
      const digestResult = await structuredStage<OpenSpecDigest | null>({
        stage: "spec_optimize",
        prompt: openSpecOptimizationPrompt(openSpecContext),
        parse: output => validateOpenSpecDigest(output.summary, openSpecContext, stageCompletionTokens(output)),
        repairPrompt: (previous, diagnostic) => repairOpenSpecDigestPrompt(openSpecContext, previous.summary, diagnostic),
        // Built from the validated change itself; when even that is impossible planning simply proceeds from the task text and the raw constraints.
        fallback: () => { try { return deterministicDigest(openSpecContext, workflowPrompt); } catch { return null; } },
      });
      const digest = digestResult.value;
      if (digest) {
        optimizedOpenSpec = JSON.stringify(digest);
        for (const message of specSizeWarnings("", optimizedOpenSpec)) warnings.push({ stage: "spec_optimize", message });
        planningTaskGoal = digest.task_goal;
        digestResult.output.metadata = { ...digestResult.output.metadata, sourceArtifact: validated.artifactRef, coverageValidated: true, sourceRequirementCount: digest.requirements.length, sourceScenarioCount: digest.requirements.reduce((sum, req) => sum + req.scenarios.length, 0) };
      }
      completedStages.push("spec_optimize");
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "openspec_stage_failed";
      return finish("failed", `OpenSpec stage failed before planning: ${failureDetails(error)}`);
    }
  }
  let bugOutcome: BugOutcome | undefined;
  if (taskType?.flow === "bug") {
    // ADR 0008. Diagnose (read-only: real defects with evidence, plus a root-cause fix design) and reproduce (tests only) run side by side and feed each other
    // when only one succeeds. The run stops for a human only when neither produced anything.
    currentStage = "diagnose";
    const bugReport = planningTaskGoal || workflowPrompt;
    try {
      let lastDiagnosis = "";
      const diagnose = (hint = "") => structuredStage<Diagnosis | null>({
        stage: "diagnose",
        prompt: diagnosePrompt(bugReport, hint),
        parse: output => { lastDiagnosis = output.summary; return validateDiagnosis(output.summary, stageCompletionTokens(output)); },
        repairPrompt: (previous, diagnostic) => repairDiagnosisPrompt(bugReport, previous.summary, diagnostic),
        repairs: 1,
        // Keep the grounded hypotheses of an answer whose fix design is invalid; when nothing is usable the other half (reproduction) carries on.
        fallback: () => salvageDiagnosis(lastDiagnosis) ?? null,
      });
      const reproduce = async (hint = ""): Promise<{ reproduction: Reproduction | null; verification?: ReproVerification }> => {
        const attempt = await structuredStage<Reproduction | null>({
          stage: "reproduce",
          prompt: reproducePrompt(bugReport, hint),
          parse: output => validateReproduction(output.summary, stageCompletionTokens(output)),
          repairPrompt: (previous, diagnostic) => repairReproductionPrompt(previous.summary, diagnostic),
          repairs: 1,
          fallback: () => null,
        });
        const reproduction = attempt.value;
        if (!reproduction || reproduction.outcome !== "reproduced" || !reproduction.command) return { reproduction };
        // The model's claim is not evidence: the orchestrator re-runs the command and requires the announced failure.
        const verification = await verifyReproduction({ worktree: workspace, command: reproduction.command, expectedFailure: reproduction.expected_failure ?? "", testFiles: reproduction.test_files });
        attempt.output.metadata = { ...attempt.output.metadata, reproductionVerified: verification.reproduced, reproductionEvidence: verification.evidence.slice(0, 400) };
        return { reproduction, verification };
      };
      let [diagnosed, reproduced] = await Promise.all([diagnose(), reproduce()]);
      const defectFound = () => (diagnosed.value?.hypotheses.length ?? 0) > 0;
      const isReproduced = () => reproduced.verification?.reproduced === true;
      if (!isReproduced() && defectFound()) reproduced = await reproduce(hintFromDiagnosis(diagnosed.value!));
      else if (isReproduced() && !defectFound()) diagnosed = await diagnose(hintFromReproduction(reproduced.reproduction!, reproduced.verification!));
      bugOutcome = { diagnosis: diagnosed.value, reproduction: reproduced.reproduction, ...(reproduced.verification ? { verification: reproduced.verification } : {}) };
      if (!defectFound() && !isReproduced()) { stopReason = "bug_needs_info"; return finish("needs_info", needsInfoMessage(bugOutcome)); }
      if (!isReproduced()) warnings.push({ stage: "reproduce", message: "the bug could not be reproduced; the fix rests on code analysis and must add its own regression test" });
      if (!defectFound()) warnings.push({ stage: "diagnose", message: "code analysis found no defect; the fix rests on the reproduction alone" });
      analysisDecisions = diagnosisBlock(bugOutcome);
      investigationConstraints = diagnosisConstraints(bugOutcome);
      const gate = regressionGate(bugOutcome);
      if (gate) gateCommands = [...gateCommands, gate];
      completedStages.push("diagnose", "reproduce");
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "bug_investigation_failed";
      return finish("failed", `bug investigation failed before planning: ${failureDetails(error)}`);
    }
  }
  if (input.analysis && profile.stages.includes("implement") && patched("analysis-stage") && taskType?.flow !== "bug") {
    // Optional analysis: compare approaches and fix the parameters before planning. Runs once with one bounded repair pass; its decisions
    // travel as protected constraints through plan, brief, implementation and review, and the full text is committed as a document.
    currentStage = "analyze";
    try {
      const analysisGoal = planningTaskGoal || workflowPrompt;
      let lastAnalysisSummary = "";
      const analysisResult = await structuredStage<Analysis | null>({
        stage: "analyze",
        prompt: makeAnalysisPrompt(analysisGoal, optimizedOpenSpec),
        parse: output => { lastAnalysisSummary = output.summary; return validateAnalysis(output.summary, stageCompletionTokens(output)); },
        repairPrompt: (previous, diagnostic) => repairAnalysisPrompt(analysisGoal, previous.summary, diagnostic),
        repairs: 2,
        // Keep whatever is usable of the last answer; when nothing is, the run continues without analysis (and says so) rather than failing.
        fallback: () => salvageAnalysis(lastAnalysisSummary) ?? null,
      });
      if (analysisResult.value) {
        analysis = analysisResult.value;
        if (analysisResult.degraded) analysisNote = "The analysis answer did not fully match the expected format; the usable parts were kept (some sections may be missing).";
        analysisResult.output.metadata = { ...analysisResult.output.metadata, analysisValidated: !analysisResult.degraded, chosenApproach: analysis.chosen.name, candidateCount: analysis.candidates.length };
        analysisDecisions = analysisBlock(analysis);
        completedStages.push("analyze");
      } else warnings.push({ stage: "analyze", message: "the analysis stage produced nothing usable, so planning and implementation ran without analysis decisions" });
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "analysis_output_invalid";
      return finish("failed", `analysis output rejected: ${failureDetails(error)}`);
    }
  }
  if (taskType?.flow === "bootstrap") {
    // ADR 0009: stack, charter and blueprint (model stages, each validated and recoverable), a human approval gate, then the scaffold (repository, manifest) and the Paperclip issues.
    const run = input.bootstrap;
    if (!run) return finish("failed", "a bootstrap run needs its project form");
    const state: { phase: BootstrapState["phase"]; stack?: StackDecision; charter?: Charter; design?: GameDesign; blueprint?: Blueprint; summary?: string } = { phase: "planning" };
    const warningLines = () => warnings.map(warning => `${warning.stage}: ${warning.message}`);
    setHandler(bootstrapStateQuery, () => ({ ...state, warnings: warningLines() }));
    try {
      workspace = await prepareBootstrapSandbox(input.runId);
      const platform = String(run.options.platform);
      currentStage = "stack";
      // A Unity game does not ask a model for its stack: the engine is an option and the scaffold template is fixed (docs/engineering/research/unity-game-support.md).
      const game = isGame(run.options);
      const stack = game && isUnityGame(run.options) ? unityStackDecision() : (await structuredStage<StackDecision>({ stage: "stack", prompt: stackPrompt(run), parse: output => validateStack(output.summary, platform), repairPrompt: (previous, diagnostic) => repairStackPrompt(run, previous.summary, diagnostic), repairs: 1, fallback: () => deterministicStack(run) })).value;
      state.stack = stack; completedStages.push("stack");
      const template = usableTemplate(stack.template_id, platform, stack.architecture, game);
      currentStage = "charter";
      const charter = (await structuredStage<Charter>({ stage: "charter", prompt: charterPrompt(run, stack), parse: output => validateCharter(output.summary), repairPrompt: (previous, diagnostic) => repairCharterPrompt(previous.summary, diagnostic), repairs: 1, fallback: () => deterministicCharter(run) })).value;
      state.charter = charter; completedStages.push("charter");
      let design: GameDesign | undefined;
      if (game) {
        // The game design stage: numbered rules with edge cases, screens, feel and a test-case table, validated and recoverable like every other structured stage; the plan is built from it.
        currentStage = "design";
        design = (await structuredStage<GameDesign>({ stage: "design", prompt: gameDesignPrompt(run, `${charter.vision} Goals: ${charter.goals.join("; ")} Boundaries: ${[...charter.non_goals, ...charter.boundaries].join("; ") || "none"}`), parse: output => validateGameDesign(output.summary), repairPrompt: (previous, diagnostic) => repairGameDesignPrompt(previous.summary, diagnostic), repairs: 1, fallback: () => deterministicGameDesign(run.form) })).value;
        state.design = design; completedStages.push("design");
      }
      currentStage = "blueprint";
      const limits = planLimits(String(run.options.granularity));
      let lastBlueprint = "";
      const blueprint = (await structuredStage<Blueprint>({ stage: "blueprint", prompt: blueprintPrompt(run, stack, charter, limits, template !== undefined, design), parse: output => { lastBlueprint = output.summary; return validateBlueprint(output.summary, limits, game); }, repairPrompt: (previous, diagnostic) => repairBlueprintPrompt(previous.summary, diagnostic, limits), repairs: 2, fallback: () => salvageBlueprint(lastBlueprint, limits) ?? deterministicBlueprint(run.form, template !== undefined) })).value;
      state.blueprint = blueprint; completedStages.push("blueprint");
      const docs = { form: run.form, options: run.options, provenance: run.provenance, stack, charter, blueprint, ...(design ? { design } : {}), ...(template ? { template } : {}) };
      state.summary = renderPlanSummary(docs, { warnings: warningLines() });
      state.phase = "awaiting_approval";
      if (input.approval) {
        currentStage = "approval";
        if (!(await condition(() => approved || rejected, input.approvalTimeoutMs ?? 7 * 86_400_000))) { stopReason = "approval_timeout"; return finish("failed", "the project plan was not approved in time; nothing was created"); }
        if (rejected) return finish("rejected", "the project plan was rejected; nothing was created");
        completedStages.push("approval");
      }
      state.phase = "creating"; currentStage = "scaffold";
      const scaffold = await scaffoldProject({ runId: input.runId, run, stack, charter, blueprint, ...(design ? { design } : {}) });
      completedStages.push("scaffold");
      currentStage = "issues";
      // The agent can only build when there is a repository to publish to and checks to gate on; otherwise the tasks wait in the backlog.
      const runnable = scaffold.repositoryUrl !== undefined && scaffold.template !== "none";
      const plannedIssues = buildIssuePlan(blueprint, run.options, runnable, charter);
      if (!runnable) warnings.push({ stage: "issues", message: "the tasks were left in the backlog: the agent needs a GitHub repository and quality commands in the project manifest before it can build" });
      let outcome: NonNullable<RunResult["bootstrap"]> = { ...scaffold, issues: [] };
      try {
        outcome = { ...scaffold, issues: await materializeIssues({ companyId: run.form.paperclip.companyId, projectId: run.form.paperclip.projectId, ...(run.form.paperclip.agentId ? { agentId: run.form.paperclip.agentId } : {}), issues: plannedIssues }) };
      } catch (error) {
        if (isCancellation(error)) throw error;
        stopReason = "issues_failed";
        return { ...finish("failed", `the repository and manifest were created (${scaffold.projectRoot}) but the Paperclip tasks could not be: ${failureDetails(error)}`), bootstrap: outcome };
      }
      completedStages.push("issues"); currentStage = null; state.phase = "done";
      const markdown = renderPlanSummary(docs, { warnings: [...warningLines(), ...scaffold.warnings], ...(scaffold.repositoryUrl ? { repoUrl: scaffold.repositoryUrl } : {}), created: outcome.issues.length });
      return { ...finish("completed", withWarnings(`project created: ${outcome.issues.length} Paperclip issues${scaffold.repositoryUrl ? `, repository ${scaffold.repositoryUrl}` : ""}`)), report: { title: `Project plan: ${run.form.name}`, markdown }, bootstrap: outcome };
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "bootstrap_failed";
      return finish("failed", `${currentStage ?? "bootstrap"} step failed: ${failureDetails(error)}`);
    }
  }
  if (investigating) {
    // ADR 0008: research and architecture explore read-only from a bounded context pack and end in a validated report, committed as a document (draft PR).
    const kind: ReportKind = input.taskType === "architecture" ? "architecture" : "research";
    const request = workflowPrompt;
    let report: NonNullable<RunResult["report"]> | undefined;
    try {
      currentStage = "scope";
      const scoped = await structuredStage<Scope>({
        stage: "scope",
        prompt: scopePrompt(request, kind),
        parse: output => { return validateScope(output.summary, stageCompletionTokens(output)); },
        repairPrompt: (previous, diagnostic) => repairScopePrompt(request, previous.summary, diagnostic),
        repairs: 1,
        fallback: () => deterministicScope(request),
      });
      completedStages.push("scope");
      currentStage = "context";
      const pack = await buildContextPack({ worktree: workspace, terms: scoped.value.search_terms, paths: scoped.value.paths_of_interest });
      completedStages.push("context");
      currentStage = "explore";
      let lastReport = "";
      const explored = await structuredStage<Report>({
        stage: "explore",
        prompt: explorePrompt(request, scoped.value, pack.text, kind),
        parse: output => { lastReport = output.summary; return validateReport(output.summary, kind, stageCompletionTokens(output)); },
        repairPrompt: (previous, diagnostic) => repairReportPrompt(request, previous.summary, diagnostic),
        repairs: 1,
        // The text of an unreadable answer is kept, marked as unstructured, rather than throwing a finished exploration away.
        fallback: () => rawReport(lastReport, scoped.value),
      });
      completedStages.push("explore");
      currentStage = "report";
      const title = input.repository?.taskTitle ?? input.taskId;
      const markdown = formatReportMarkdown(explored.value, scoped.value, { taskId: input.taskId, title, kind, filesConsulted: pack.files, ...(explored.degraded ? { note: "The exploration answer was not in the expected format; the report is incomplete." } : {}) });
      report = { title, markdown };
      if (workspace !== input.projectRoot) artifactRefs.push(await writeDocument({ worktree: workspace, dir: input.documentsDir ?? (kind === "architecture" ? "docs/architecture" : "docs/research"), name: input.taskId, markdown }));
      else warnings.push({ stage: "report", message: "no isolated worktree, so the report was not committed; it is only in the issue comment" });
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "exploration_failed";
      return finish("failed", `${currentStage ?? "exploration"} stage failed: ${failureDetails(error)}`);
    }
    currentStage = null; completedStages.push("report");
    if (workspace !== input.projectRoot) artifactRefs.push(await collectWorktree({ runId: input.runId, projectRoot: input.projectRoot, worktree: workspace, artifactsDir: input.artifactsDir }));
    if (repository && workspace !== input.projectRoot) {
      try {
        const publish = await publishWorktree({ repository, worktree: workspace, taskId: input.taskId, prompt: input.prompt, kind: "document" });
        return { ...finish("completed", withWarnings("report produced; draft PR published")), publish, report };
      } catch (error) {
        stopReason = "publish_failed"; return { ...finish("failed", `publish failed; task requires recovery: ${failureDetails(error)}`), report };
      }
    }
    return { ...finish("completed", withWarnings("report produced")), report };
  }
  // ADR 0015: with a tier and a lane the stage list comes from the lane table (a prototype task is implement + verify); runs recorded without them keep the profile's own list.
  const lane = input.tier && input.lane && LANE_PROFILES.includes(profile.id) && profile.stages.includes("implement") ? lanePlan(input.tier, input.lane) : undefined;
  const stageList: WorkflowProfile["stages"] = lane ? [...lane.stages] : [...profile.stages];
  for (const stage of stageList) {
    currentStage = stage;
    // Without a plan and brief stage the brief comes from the task text: no model call, the acceptance criteria are already in it.
    if (lane && stage === "implement" && !executionBrief) {
      plan ??= { ...deterministicPlan({ taskPrompt: workflowPrompt }), hard_constraints: [...new Set([...extractHardConstraints(openSpecContext), ...extractTaskConstraints(workflowPrompt), ...(analysis ? analysisConstraints(analysis) : [])])] };
      executionBrief = deterministicBrief(plan, openSpecContext);
    }
    if (stage === "implement" && input.approval) {
      // patched(): runs already waiting without a timer must replay the original unbounded wait.
      if (patched("approval-timeout")) { if (!(await condition(() => approved || rejected, input.approvalTimeoutMs ?? 86_400_000))) { stopReason = "approval_timeout"; return finish("failed", "human approval timed out; no changes were published"); } }
      else await condition(() => approved || rejected);
      if (rejected) return { runId: input.runId, status: "rejected", stages, artifactRefs, message: "human approval rejected" }; }
    let output: StageOutput;
    try {
      if (stage === "plan") {
        const specConstraints = optimizedOpenSpec ? ((JSON.parse(optimizedOpenSpec) as { hard_constraints?: string[] }).hard_constraints ?? []) : extractHardConstraints(openSpecContext);
        // Source requirements, task constraints and analysis decisions are authoritative: they are restored into the plan whatever the model wrote.
        const protectedConstraints = [...new Set([...specConstraints, ...extractTaskConstraints(workflowPrompt), ...(analysis ? analysisConstraints(analysis) : []), ...investigationConstraints])];
        const digest = optimizedOpenSpec ? JSON.parse(optimizedOpenSpec) as OpenSpecDigest : undefined;
        let oversizedPlan: Plan | undefined;
        const planned = await structuredStage<Plan>({
          stage: "plan",
          prompt: makePlanningPrompt(planningTaskGoal || workflowPrompt, optimizedOpenSpec, uiUxContext, analysisDecisions, contractContext),
          parse: planOutput => {
            const candidate: Plan = { ...parseStructured(planOutput.summary, PlanSchema, "Plan", Number.MAX_SAFE_INTEGER), hard_constraints: protectedConstraints };
            try { parseStructured(planOutput.summary, PlanSchema, "Plan", HANDOFF_BUDGETS.plan, stageCompletionTokens(planOutput)); }
            catch (budgetError) { oversizedPlan = candidate; throw budgetError; }
            if (oversizedPlan) validatePlanCompression(oversizedPlan, candidate);
            return candidate;
          },
          repairPrompt: (previous, diagnostic) => diagnostic.includes("exceeds its") && oversizedPlan ? compressPlanPrompt(oversizedPlan) : repairStructuredPrompt("plan", PLAN_SCHEMA_HINT, previous.summary, diagnostic),
          repairs: 2,
          fallback: () => ({ ...deterministicPlan({ taskPrompt: workflowPrompt, ...(digest ? { digest } : {}) }), hard_constraints: protectedConstraints }),
        });
        plan = planned.value;
        output = planned.output;
      } else if (stage === "brief") {
        const sourcePlan = plan!;
        let oversizedBrief: ExecutionBrief | undefined;
        const briefed = await structuredStage<ExecutionBrief>({
          stage: "brief",
          prompt: makeBriefPrompt(workflowPrompt, openSpecContext, sourcePlan),
          parse: briefOutput => {
            // Protected constraints are restored deterministically before the budget check; validation still fails when the complete brief cannot fit.
            const canonical = canonicalizeBrief(parseStructured(briefOutput.summary, ExecutionBriefSchema, "Execution brief", Number.MAX_SAFE_INTEGER), sourcePlan, openSpecContext);
            try { return validateBrief(formatBrief(canonical), sourcePlan, openSpecContext); }
            catch (budgetError) { oversizedBrief = canonical; throw budgetError; }
          },
          repairPrompt: (previous, diagnostic, attempt) => diagnostic.includes("exceeds its") && oversizedBrief ? compressBriefPrompt(oversizedBrief, attempt === 1 ? 650 : 500) : repairStructuredPrompt("execution brief", BRIEF_SCHEMA_HINT, previous.summary, diagnostic),
          repairs: 2,
          // Prefer the model's own (slightly oversized) brief up to the hard ceiling, otherwise the deterministic one.
          fallback: () => {
            for (const candidate of [oversizedBrief, deterministicBrief(sourcePlan, openSpecContext)]) {
              if (!candidate) continue;
              try { return validateBrief(formatBrief(candidate), sourcePlan, openSpecContext, undefined, BRIEF_HARD_CEILING); } catch { /* try the next candidate */ }
            }
            throw new Error("the protected requirements do not fit the brief budget; split this task into smaller ones");
          },
        });
        executionBrief = briefed.value;
        output = briefed.output;
      } else if (stage === "review" && stageList.includes("verify")) {
        const round = ++reviewCount;
        // Verification can launch Unity and review can capture Unity visuals: for a Unity project they run one after the other so two Editor processes never contend for one project
        // and review sees the finished checks. Every other stack keeps them concurrent. patched(): runs recorded before this replayed the concurrent pair for every stack.
        if (input.visual?.engine === "unity" && patched("serial-verify-review-unity")) {
          try { deterministicVerification = await execute("verify", { provider: "fake", verificationOnly: true }); }
          catch (error) {
            if (isCancellation(error)) throw error;
            stopReason = "verify_activity_failed";
            return finish("failed", `verify Activity failed before review: ${failureDetails(error)}`);
          }
          output = await execute("review", { prompt: reviewPrompt(formatBrief(executionBrief!), stages, round, Boolean(input.injectReviewFailure && repairCount === 0 || input.repeatReviewFailure), false, uiUxContext, analysisDecisions, contractContext) });
        } else {
          const [review, verification] = await Promise.all([
            execute("review", { prompt: reviewPrompt(formatBrief(executionBrief!), stages, round, Boolean(input.injectReviewFailure && repairCount === 0 || input.repeatReviewFailure), true, uiUxContext, analysisDecisions, contractContext) }),
            execute("verify", { provider: "fake", verificationOnly: true }),
          ]);
          output = review;
          deterministicVerification = verification;
        }
      } else if (stage === "verify" && deterministicVerification) {
        // The deterministic quality commands are the verification. A second model call here could only ever pass, so it is skipped
        // (patched(): runs already past this point replay the original call).
        if (!deterministicVerification.ok) deterministicVerification = await repairGate(deterministicVerification);
        if (!deterministicVerification.ok || patched("skip-model-verify")) output = deterministicVerification;
        else output = await execute("verify", { deterministicChecksAlreadyPassed: true, qualityCommands: [] });
      } else if (stage === "verify" && lane) {
        // A lane without a paired review: the deterministic checks run directly, with the same one bounded repair pass.
        let verification = await execute("verify", { provider: "fake", verificationOnly: true });
        if (!verification.ok) verification = await repairGate(verification);
        deterministicVerification = verification; output = verification;
      } else {
        output = stage === "review" ? await execute("review", { prompt: reviewPrompt(formatBrief(executionBrief!), stages, ++reviewCount, Boolean(input.injectReviewFailure && repairCount === 0 || input.repeatReviewFailure), false, uiUxContext, analysisDecisions, contractContext) })
          : await execute(stage);
      }
    }
    catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = stage === "plan" || stage === "brief" ? `${stage}_output_invalid` : `${stage}_activity_failed`;
      return finish("failed", stage === "plan" || stage === "brief" ? `${stage} could not be produced: ${failureDetails(error)}` : `${stage} Activity failed after bounded retries: ${failureDetails(error)}`);
    }
    if (stage === "review") {
      // A reviewer answer that cannot be read as an assessment gets one request to restate it; it never counts as a pass.
      const readable = async (reviewed: StageOutput): Promise<StageOutput> => reviewed.metadata?.reviewUnparseable && patched("review-enforcement") ? await execute("review", { prompt: reviewRepairPrompt(reviewed.summary) }) : reviewed;
      const noteReview = (reviewed: StageOutput) => {
        reviewed.metadata = { ...reviewed.metadata, reviewRound: reviewCount, ...(reviewed.review ? { reviewFindingCount: reviewed.review.findings.length, nonBlockingNoteCount: reviewed.review.notes.length } : {}) };
        recordReview(reviewed, reviewCount);
        nonBlockingNotes.push(...(reviewed.review?.notes ?? []));
      };
      try { output = await readable(output); } catch (error) { if (isCancellation(error)) throw error; stopReason = "review_activity_failed"; return finish("failed", `review Activity failed after bounded retries: ${failureDetails(error)}`); }
      noteReview(output);
      const initialBlocking = blockingFindings(output).length;
      for (;;) {
        if (output.metadata?.reviewUnparseable) { stopReason = "review_unparseable"; unresolvedFindings.push({ severity: "high", category: "other", title: "Review output unreadable", evidence: output.summary.slice(0, 400), fixableInCode: false }); return finish("failed", "review output could not be read as an assessment, even after a request to restate it; the gate fails closed"); }
        const external = externalBlockers(output);
        // patched(): runs recorded before the change below stopped here, before any code-fixable blocker was repaired.
        if (external.length && !patched("external-blocker-after-repair")) { unresolvedFindings.push(...external); stopReason = "external_or_approval_prerequisite"; return finish("failed", "review stopped: external prerequisite requires operator action"); }
        const latestImplementation = [...stages].reverse().find(result => result.stage === "implement");
        const declared = latestImplementation ? declaredUnmetAcceptance(latestImplementation.summary) : [];
        // An implementer sent back once that declares the same items again, and a reviewer that then passes the change with that declaration in front of it, have settled the question:
        // a documented deferral (the contract allows one for work that belongs to a later task). It is recorded, not blocking, so the task finishes and its dependents can start (ADR 0020).
        // patched(): runs recorded before this change kept such a task in review.
        const deferred = declared.length > 0 && repairCount >= 1 && !blockingFindings(output).length && !external.length && patched("accept-reviewed-deferral");
        if (deferred) warnings.push({ stage: "review", message: `accepted as a documented deferral after review (${declared.length}): ${declared.map(item => item.title.replace(/^Declared unmet by the implementation: /, "").slice(0, 120)).join("; ")}` });
        const blocking = [...blockingFindings(output), ...(deferred ? [] : declared)];
        // An external prerequisite must stop publication, but it must not mask
        // independent, code-fixable blockers in the same review. Repair those
        // within the existing round budget, then stop if the prerequisite stays.
        if (!blocking.length) {
          if (external.length) { unresolvedFindings.push(...external); stopReason = "external_or_approval_prerequisite"; return finish("failed", "review stopped: external prerequisite requires operator action after code-fixable findings were addressed"); }
          break;
        }
        if (reviewCount >= maxRounds) {
          unresolvedFindings.push(...blocking, ...external);
          if (external.length) { stopReason = "external_or_approval_prerequisite"; return finish("failed", "review stopped: external prerequisite remains after the bounded code-repair rounds"); }
          // The deterministic gates are not affected by review findings: publish the draft with the open findings as a PR comment and let a human accept or send it back.
          if (patched("publish-with-open-findings")) { openFindings = blocking; stopReason = "review_findings_unresolved"; break; }
          stopReason = "blocking_findings_remain_after_final_review"; return finish("failed", `review quality gate failed after the maximum of ${maxRounds} review rounds`); }
        repairCount++;
        try { await execute("implement", { prompt: implementationPrompt(formatBrief(executionBrief!), blocking, gateCommands, uiUxContext, analysisDecisions, contractContext) }); }
        catch (error) { if (isCancellation(error)) throw error; stopReason = "repair_activity_failed"; return finish("failed", `repair Activity failed: ${failureDetails(error)}`); }
        try {
          let verification = await execute("verify", { provider: "fake", model: undefined, verificationOnly: true });
          if (!verification.ok) verification = await repairGate(verification);
          deterministicVerification = verification;
          if (!verification.ok) { unresolvedFindings.push(...blocking); stopReason = "deterministic_checks_failed_after_repair"; return finish("failed", `deterministic checks failed after review repair: ${verification.summary}`); }
        } catch (error) { if (isCancellation(error)) throw error; unresolvedFindings.push(...blocking); stopReason = "deterministic_checks_failed_after_repair"; return finish("failed", `deterministic checks failed after review repair: ${failureDetails(error)}`); }
        try { output = await readable(await execute("review", { prompt: reviewPrompt(formatBrief(executionBrief!), stages, ++reviewCount, Boolean(input.repeatReviewFailure), false, uiUxContext, analysisDecisions, contractContext) })); }
        catch (error) { if (isCancellation(error)) throw error; stopReason = "follow_up_review_failed"; return finish("failed", `follow-up review failed: ${failureDetails(error)}`); }
        // A follow-up review may only keep blocking findings that restate a prior blocker or show a concrete scenario; the rest become notes.
        output = requireSubstantiatedBlockers(output, blocking);
        noteReview(output);
        findingsFixed = initialBlocking;
      }
      if (!output.ok && !openFindings.length) {
        unresolvedFindings.push(...output.findings.map(title => ({ severity: "high" as const, category: "other" as const, title, evidence: title, fixableInCode: false })));
        stopReason = "unclassified_review_failure"; return finish("failed", "review failed without a structured code-fixable finding");
      }
    }
    if (!output.ok && !(stage === "review" && openFindings.length)) { stopReason = `${stage}_quality_gate_failed`; return finish("failed", `${stage} quality gate failed`); }
    // A result that skipped review but looks risky gets one after all (src/lanes.ts escalationReasons).
    if (lane?.escalation && stage === "implement" && !stageList.includes("review")) {
      const changes = await assessChanges({ worktree: workspace }).catch(() => undefined);
      const reasons = changes ? escalationReasons(changes, declaredUnmetAcceptance(output.summary).length > 0) : [];
      if (reasons.length) { stageList.splice(stageList.indexOf("verify"), 0, "review"); warnings.push({ stage: "review", message: `review added to this ${input.lane} task: ${reasons.join("; ")}` }); }
    }
    completedStages.push(stage);
  }
  currentStage = null;
  if (openSpecChangeId) {
    currentStage = "openspec-archive";
    try {
      const archiveInput = { changeId: openSpecChangeId, runId: input.runId, projectRoot: workspace, artifactsDir: input.artifactsDir };
      let archived: Awaited<ReturnType<typeof archiveOpenSpecChange>>;
      try { archived = await archiveOpenSpecChange(archiveInput); }
      catch (archiveError) {
        // Gates passed; archive failures are bookkeeping in the OpenSpec artifacts. Repair once, then archive again.
        const detail = failureDetails(archiveError, 6000);
        const checklist = /checklist.*is not complete|incomplete/i.test(detail);
        const specUpdate = /archive_spec_update_failed|delta|MODIFIED|REMOVED|RENAMED|not found/i.test(detail);
        if (isCancellation(archiveError) || !patched("openspec-checklist-reconcile") || (!checklist && !specUpdate)) throw archiveError;
        const prompt = checklist ? openSpecChecklistReconcilePrompt({ changeId: openSpecChangeId, error: failureDetails(archiveError, 2000) }) : openSpecRepairPrompt({ taskPrompt: input.prompt, changeId: openSpecChangeId, diagnostics: detail });
        const reconciled = await execute("openspec", { ...openSpecRouteOptions, providerTimeoutMs: input.providerTimeouts?.openspec ?? 720_000, openSpecChangeId, prompt });
        if (!reconciled.ok) throw archiveError;
        archived = await archiveOpenSpecChange(archiveInput);
      }
      artifactRefs.push(archived.artifactRef);
      if (openSpecInfo) openSpecInfo = { ...openSpecInfo, archivedPath: archived.archivedPath };
      completedStages.push("openspec-archive");
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "openspec_archive_failed";
      return finish("failed", `OpenSpec archive failed after quality gates; task was not published: ${failureDetails(error)}`);
    }
  }
  currentStage = null;
  if (analysis && workspace !== input.projectRoot && patched("analysis-stage")) {
    try {
      const document = await writeAnalysisDocument({ worktree: workspace, docsDir: input.analysisDocsDir ?? "docs/analysis", taskId: input.taskId, markdown: formatAnalysisMarkdown(analysis, { taskId: input.taskId, ...(input.repository?.taskTitle ? { title: input.repository.taskTitle } : {}), ...(analysisNote ? { note: analysisNote } : {}) }) });
      artifactRefs.push(document);
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "analysis_document_failed";
      return finish("failed", `analysis document could not be written: ${failureDetails(error)}`);
    }
  }
  if (bugOutcome && workspace !== input.projectRoot) {
    try {
      artifactRefs.push(await writeAnalysisDocument({ worktree: workspace, docsDir: input.analysisDocsDir ?? "docs/analysis", taskId: `${input.taskId}-diagnosis`, markdown: formatDiagnosisMarkdown(bugOutcome, { taskId: input.taskId, ...(input.repository?.taskTitle ? { title: input.repository.taskTitle } : {}) }) }));
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "diagnosis_document_failed";
      return finish("failed", `diagnosis document could not be written: ${failureDetails(error)}`);
    }
  }
  if (workspace !== input.projectRoot) artifactRefs.push(await collectWorktree({ runId: input.runId, projectRoot: input.projectRoot, worktree: workspace, artifactsDir: input.artifactsDir }));
  if (repository && workspace !== input.projectRoot) {
    try {
      const publish = await publishWorktree({ repository, worktree: workspace, taskId: input.taskId, prompt: input.prompt });
      if (openFindings.length) {
        // A failed comment must not hide the published PR: the findings are also in the result and the Paperclip comment.
        try { await commentOnPullRequest({ worktree: workspace, prUrl: publish.prUrl, body: openFindingsComment(openFindings, { rounds: reviewCount }) }); }
        catch (error) { if (isCancellation(error)) throw error; warnings.push({ stage: "review", message: `the open review findings could not be posted as a PR comment: ${failureDetails(error, 300)}` }); }
        return { ...finish("needs_review", withWarnings(`quality gates passed; draft PR published with ${openFindings.length} unresolved review finding${openFindings.length === 1 ? "" : "s"} (see the PR comment)`)), publish };
      }
      return { ...finish("completed", withWarnings("quality gates passed; draft PR published")), publish };
    } catch (error) {
      stopReason = "publish_failed"; return finish("failed", `publish failed; task requires recovery: ${failureDetails(error)}`);
    }
  }
  return finish(openFindings.length ? "needs_review" : "completed", withWarnings(openFindings.length ? `workflow completed with ${openFindings.length} unresolved review finding${openFindings.length === 1 ? "" : "s"}` : "workflow completed"));
}
