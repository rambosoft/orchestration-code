import { proxyActivities, defineSignal, defineQuery, setHandler, condition, isCancellation, patched } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type { OpenSpecPrepared, OpenSpecContext, ProviderRoute, ReviewFinding, RunInput, RunResult, StageInput, StageName, StageOutput } from "./contracts.js";
import { profiles } from "./profiles.js";
import { openSpecProposalPrompt, openSpecChecklistReconcilePrompt, openSpecRepairPrompt, shouldRunOpenSpec } from "./openspec-policy.js";
import { SIMPLICITY_POLICY, SIMPLICITY_REVIEW_POLICY } from "./simplicity.js";
import { DEFAULT_UI_UX_CONFIG, uiUxGuidance } from "./uiux.js";
import { assertTokenBudget, briefPrompt as makeBriefPrompt, canonicalizeBrief, compressBriefPrompt, compressPlanPrompt, estimateTokens, extractHardConstraints, extractTaskConstraints, ExecutionBriefSchema, formatBrief, HANDOFF_BUDGETS, openSpecOptimizationPrompt, repairOpenSpecDigestPrompt, parseStructured, PlanSchema, planningPrompt as makePlanningPrompt, validateBrief, validateBriefCompression, validateOpenSpecDigest, validatePlanCompression, type ExecutionBrief, type Plan } from "./handoffs.js";

const { executeStage } = proxyActivities<typeof activities>({ startToCloseTimeout: "16 minutes", heartbeatTimeout: "2 minutes", cancellationType: "WAIT_CANCELLATION_COMPLETED", retry: { initialInterval: "1 second", maximumInterval: "15 seconds", maximumAttempts: 2 } });
const { prepareWorktree, collectWorktree, publishWorktree, checkDependencies, prepareProjectDependencies } = proxyActivities<typeof activities>({ startToCloseTimeout: "16 minutes", retry: { initialInterval: "1 second", maximumInterval: "15 seconds", maximumAttempts: 2 } });
const { prepareOpenSpec, validateOpenSpec, archiveOpenSpecChange } = proxyActivities<typeof activities>({ startToCloseTimeout: "16 minutes", retry: { initialInterval: "1 second", maximumInterval: "15 seconds", maximumAttempts: 2 } });
const { timeoutProbe } = proxyActivities<typeof activities>({ startToCloseTimeout: "1 second", retry: { initialInterval: "100 milliseconds", maximumInterval: "100 milliseconds", maximumAttempts: 2 } });
export const approveSignal = defineSignal<[boolean]>("approval");
export const progressQuery = defineQuery<{ currentStage: string | null; completedStages: string[] }>("progress");

export function stageRoute(input: RunInput, stage: StageName) {
  const fallback: ProviderRoute = { provider: input.provider ?? "fake" };
  return input.providerRouting?.[stage] ?? fallback;
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
  if (input.maxReviewRounds !== undefined) return Math.max(1, Math.min(2, Math.trunc(input.maxReviewRounds)));
  if (input.maxRepairAttempts !== undefined) return Math.max(1, Math.min(2, Math.trunc(input.maxRepairAttempts) + 1));
  return 2;
}

export function blockingFindings(output: StageOutput): ReviewFinding[] {
  if (output.review) return output.review.findings.filter(f => (f.severity === "critical" || f.severity === "high") && f.fixableInCode && f.category !== "environment" && f.category !== "approval");
  return output.ok ? [] : output.findings.map(title => ({ severity: "high", category: "functional", title: title.slice(0, 180), evidence: title, fixableInCode: true }));
}

export function externalBlockers(output: StageOutput): ReviewFinding[] {
  return output.review?.findings.filter(f => f.category === "environment" || f.category === "approval" || !f.fixableInCode) ?? [];
}

export function implementationPrompt(taskPrompt: string, repairFindings?: ReviewFinding[], qualityCommands: StageInput["qualityCommands"] = [], uiUxContext = ""): string {
  const configuredChecks = qualityCommands.length
    ? `\nThe orchestration will run these configured deterministic checks as a publication gate after implementation/review${repairFindings?.length ? "; after repair it runs them before the follow-up review" : ""}:\n${qualityCommands.map(check => `- ${check.executable} ${check.args.join(" ")}${check.cwd ? ` (cwd: ${check.cwd})` : ""}`).join("\n")}`
    : "\nNo deterministic checks are configured; report this as a blocking delivery risk.";
  const deliveryContract = `Implement the brief and satisfy every acceptance_check. Follow existing project patterns; make the smallest complete change. Add focused regression coverage and run focused tests only. Inspect the diff and report changed files and test results accurately. The orchestration runs configured quality gates; do not claim checks you did not run.

${SIMPLICITY_POLICY}${configuredChecks}`;
  const guidance = uiUxContext ? `\n\n${uiUxContext}` : "";
  if (!repairFindings?.length) return `${taskPrompt}${guidance}\n\n${deliveryContract}`;
  const repairList = repairFindings.map((finding, index) => `${index + 1}. [${finding.severity}/${finding.category}] ${finding.title}\n   Evidence: ${finding.evidence}${finding.acceptanceCriterion ? `\n   Acceptance criterion: ${finding.acceptanceCriterion}` : ""}`).join("\n");
  return `${taskPrompt}${guidance}\n\n${deliveryContract}\n\nREPAIR: One bounded repair pass remains. Resolve each blocker below with the smallest complete fix; add or update a regression test. Run focused tests; the orchestration runs its quality gate before follow-up review. Report each resolution and any unresolved blocker with evidence.\n${repairList}`;
}

export function reviewPrompt(taskPrompt: string, stageResults: StageOutput[], reviewNumber: number, repeatFailure = false, verificationPending = false, uiUxContext = ""): string {
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
  const summaries = implementations.map((result, index) => `Implementation ${index + 1}: ${result.summary}`).join("\n\n");
  const priorReview = [...stageResults].reverse().find(result => result.stage === "review");
  const previousFindings = priorReview?.review?.findings.length
    ? priorReview.review.findings.filter(f => (f.severity === "critical" || f.severity === "high") && f.fixableInCode).map(f => `- [${f.severity}/${f.category}] ${f.title}: ${f.evidence}${f.acceptanceCriterion ? ` (criterion: ${f.acceptanceCriterion})` : ""}`).join("\n")
    : priorReview?.findings.length ? priorReview.findings.map(finding => `- ${finding}`).join("\n")
    : "No prior actionable review findings.";
  const verification = [...stageResults].reverse().find(result => result.stage === "verify");
  const verificationSummary = verification ? `\nDeterministic check result before this review: ${verification.ok ? "PASS" : "FAIL"}. ${verification.summary}\n` : "";
  const reviewMode = reviewNumber <= 1
    ? `FIRST REVIEW — check this checklist against the full diff and relevant tests. Also check correctness, regressions, security, accessibility/responsive behavior, and test coverage. Report substantiated findings only.\n\n${reviewChecklist}`
    : `FOLLOW-UP REVIEW ${reviewNumber} — verify only prior blockers, the acceptance checks, and regressions introduced by repair. Do not restart broad review or repeat fixed findings. If all fixes are correct, return pass.\n\nPrior blocking findings:\n${previousFindings}${verificationSummary}\n${reviewChecklist}`;
  const checkStatus = verificationPending ? "Deterministic checks are running concurrently with this review. Do not infer their result, treat their pending status as a defect, or claim that they passed or failed." : "Deterministic checks are authoritative; report their supplied result without overriding it.";
  const uiChecks = uiUxContext ? "\nUI checks: responsive reflow, keyboard access, semantics, contrast, reduced motion, and relevant loading/empty/error states." : "";
  const prompt = `${repeatFailure ? "[INJECT_REVIEW_FAILURE]\n" : ""}${reviewMode}${uiChecks}\n\n${summaries ? `Implementation summary:\n${summaries}` : "No implementation summary is available."}\n\n${SIMPLICITY_REVIEW_POLICY}

Return exactly one JSON object: {"verdict":"pass"|"needs_changes","findings":[{"severity":"critical"|"high"|"medium"|"low"|"info","category":"functional"|"acceptance"|"regression"|"security"|"accessibility"|"tests"|"environment"|"approval"|"polish"|"other","title":"short issue","evidence":"specific evidence","acceptanceCriterion":"optional","fixableInCode":true|false}],"notes":[same objects]}. Only critical/high code-fixable issues belong in findings; environment/approval blockers use fixableInCode=false. Do not execute commands. ${checkStatus}`;
  return prompt;
}

export async function projectWorkflow(input: RunInput): Promise<RunResult> {
  const profile = profiles[input.profile];
  if (!profile) return { runId: input.runId, status: "failed", stages: [], artifactRefs: [], message: `unknown profile '${input.profile}'` };
  const uiUxContext = profile.stages.includes("implement") ? uiUxGuidance({ prompt: input.prompt, frameworks: input.uiUxFrameworks, config: input.uiUx ?? DEFAULT_UI_UX_CONFIG }) : "";
  if (input.injectActivityTimeout) {
    try { await timeoutProbe(); } catch (error) { if (isCancellation(error)) throw error; return { runId: input.runId, status: "failed", stages: [], artifactRefs: [], message: `Activity timed out after bounded retries: ${failureDetails(error)}` }; }
  }
  const stages: StageOutput[] = []; const artifactRefs: string[] = []; let approved = !input.approval; let rejected = false;
  let currentStage: string | null = null; const completedStages: string[] = [];
  setHandler(progressQuery, () => ({ currentStage, completedStages: [...completedStages] }));
  let workspace = input.projectRoot;
  if (profile.stages.includes("implement") && stageRoute(input, "implement").provider !== "fake" && !input.repository) return { runId: input.runId, status: "failed", stages, artifactRefs, message: "GitHub publication is required for code workflows; configure a clean GitHub repository, target branch, and remote before dispatch." };
  if (profile.stages.includes("implement") && input.repository) {
    try {
      await checkDependencies({ blockerIds: input.blockerIds ?? [], parentPublications: input.parentPublications ?? [], repository: input.repository, projectRoot: input.projectRoot });
      workspace = await prepareWorktree({ runId: input.runId, projectRoot: input.projectRoot, baseSha: input.repository.baseSha, branch: input.repository.branch, requiredSourcePaths: input.repository.requiredSourcePaths });
      currentStage = "dependencies";
      await prepareProjectDependencies(workspace);
      completedStages.push("dependencies");
    } catch (error) {
      return { runId: input.runId, status: "failed", stages, artifactRefs, message: `admission recheck failed before branch creation: ${failureDetails(error)}` };
    }
  }
  setHandler(approveSignal, (value) => { approved = value; rejected = !value; });
  const maxRounds = effectiveMaxReviewRounds(input); let repairCount = 0; let reviewCount = 0; let findingsFixed = 0; let stopReason: string | undefined;
  const nonBlockingNotes: ReviewFinding[] = []; const unresolvedFindings: ReviewFinding[] = [];
  const reviewRuns: NonNullable<RunResult["metadata"]>["review"]["reviewRuns"] = [];
  const recordReview = (output: StageOutput, round: number) => {
    const blockingCount = blockingFindings(output).length;
    reviewRuns.push({ round, provider: output.provider, durationMs: output.durationMs, verdict: output.review?.verdict ?? (output.ok ? "pass" : "unstructured"), blockingFindingCount: blockingCount, nonBlockingNoteCount: output.review?.notes.length ?? 0, ...(output.metadata?.usage !== undefined ? { usage: output.metadata.usage } : {}) });
  };
  let openSpecInfo: NonNullable<RunResult["metadata"]>["openSpec"];
  const resultMetadata = () => ({ review: { maxReviewRounds: maxRounds, reviewCount, repairCount, findingsFixed, reviewRuns: [...reviewRuns], nonBlockingNotes: [...nonBlockingNotes], unresolvedFindings: [...unresolvedFindings], ...(stopReason ? { stopReason } : {}) }, ...(openSpecInfo ? { openSpec: openSpecInfo } : {}) });
  const finish = (status: RunResult["status"], message: string): RunResult => ({ runId: input.runId, status, stages, artifactRefs, message, metadata: resultMetadata() });
  let workflowPrompt = input.prompt;
  let openSpecContext = "";
  let optimizedOpenSpec = "";
  let planningTaskGoal = "";
  let plan: Plan | undefined;
  let executionBrief: ExecutionBrief | undefined;
  let openSpecChangeId: string | undefined;
  let deterministicVerification: StageOutput | undefined;
  const execute = async (stage: StageName, options: { prompt?: string; provider?: string; model?: string; reasoningEffort?: StageInput["reasoningEffort"]; providerTimeoutMs?: number; verificationOnly?: boolean; deterministicChecksAlreadyPassed?: boolean; qualityCommands?: StageInput["qualityCommands"]; openSpecChangeId?: string } = {}): Promise<StageOutput> => {
    const route = stageRoute(input, stage === "brief" || stage === "spec_optimize" ? "plan" : stage); const stageAttempt = stages.filter(item => item.stage === stage).length + 1;
    const defaultPrompt = stage === "implement" ? implementationPrompt(executionBrief ? formatBrief(executionBrief) : "", undefined, input.qualityCommands, uiUxContext) : stage === "plan" ? makePlanningPrompt(planningTaskGoal || workflowPrompt, optimizedOpenSpec, uiUxContext) : stage === "brief" ? (plan ? makeBriefPrompt(workflowPrompt, openSpecContext, plan) : "") : workflowPrompt;
    const args: StageInput = { runId: input.runId, taskId: input.taskId, projectId: input.projectId, profile: input.profile, stage, prompt: options.prompt ?? defaultPrompt, attempt: stageAttempt, provider: options.provider ?? route.provider, model: options.model ?? route.model, reasoningEffort: options.reasoningEffort ?? route.reasoningEffort, providerTimeoutMs: options.providerTimeoutMs ?? input.providerTimeouts?.[stage] ?? (stage === "openspec" ? 720_000 : undefined), projectRoot: workspace, artifactsDir: input.artifactsDir, plugins: input.plugins ?? [], qualityCommands: options.qualityCommands ?? input.qualityCommands ?? [], verificationOnly: options.verificationOnly, deterministicChecksAlreadyPassed: options.deterministicChecksAlreadyPassed, openSpecChangeId: options.openSpecChangeId };
    const output = await executeStage(args); stages.push(output); artifactRefs.push(...output.artifactRefs); return output;
  };
  if (shouldRunOpenSpec(input.openSpec, profile.stages)) {
    if (!input.repository || workspace === input.projectRoot) return finish("failed", "OpenSpec requires an isolated Git worktree; configure a repository for this implementation task.");
    currentStage = "openspec";
    try {
      const prepared: OpenSpecPrepared = await prepareOpenSpec({ taskId: input.taskId, runId: input.runId, prompt: input.prompt, projectRoot: workspace, artifactsDir: input.artifactsDir });
      openSpecChangeId = prepared.changeId;
      artifactRefs.push(prepared.artifactRef);
      const output = await execute("openspec", { provider: "codex", providerTimeoutMs: input.providerTimeouts?.openspec ?? 720_000, openSpecChangeId, prompt: openSpecProposalPrompt({ taskPrompt: input.prompt, changeId: prepared.changeId }) });
      if (!output.ok) { stopReason = "openspec_proposal_failed"; return finish("failed", "OpenSpec proposal stage did not complete successfully."); }
      const validateInput = { changeId: prepared.changeId, runId: input.runId, projectRoot: workspace, artifactsDir: input.artifactsDir };
      let validated: OpenSpecContext;
      try { validated = await validateOpenSpec(validateInput); }
      catch (validationError) {
        // Models often get the delta format wrong; give the proposal stage one bounded repair pass with the validator's diagnostics.
        if (isCancellation(validationError) || !patched("openspec-validation-repair")) throw validationError;
        const repaired = await execute("openspec", { provider: "codex", providerTimeoutMs: input.providerTimeouts?.openspec ?? 720_000, openSpecChangeId, prompt: openSpecRepairPrompt({ taskPrompt: input.prompt, changeId: prepared.changeId, diagnostics: failureDetails(validationError, 6000) }) });
        if (!repaired.ok) { stopReason = "openspec_repair_failed"; return finish("failed", "OpenSpec validation repair did not complete successfully."); }
        validated = await validateOpenSpec(validateInput);
      }
      artifactRefs.push(validated.artifactRef);
      openSpecContext = validated.context;
      openSpecInfo = { changeId: prepared.changeId, version: validated.version, contextArtifact: validated.artifactRef };
      output.metadata = { ...output.metadata, openSpec: { changeId: prepared.changeId, version: validated.version, validated: true, contextArtifact: validated.artifactRef } };
      completedStages.push("openspec");
      currentStage = "spec_optimize";
      let optimized = await execute("spec_optimize", { prompt: openSpecOptimizationPrompt(openSpecContext) });
      if (!optimized.ok) { stopReason = "openspec_optimization_failed"; return finish("failed", "OpenSpec optimization stage did not complete successfully."); }
      let digest;
      try { digest = validateOpenSpecDigest(optimized.summary, openSpecContext, stageCompletionTokens(optimized)); }
      catch (validationError) {
        if (isCancellation(validationError)) throw validationError;
        const diagnostic = failureDetails(validationError);
        optimized = await execute("spec_optimize", { prompt: repairOpenSpecDigestPrompt(openSpecContext, optimized.summary, diagnostic) });
        if (!optimized.ok) { stopReason = "openspec_optimization_repair_failed"; return finish("failed", "OpenSpec optimization repair did not complete successfully."); }
        digest = validateOpenSpecDigest(optimized.summary, openSpecContext, stageCompletionTokens(optimized));
      }
      optimizedOpenSpec = JSON.stringify(digest);
      planningTaskGoal = digest.task_goal;
      optimized.metadata = { ...optimized.metadata, sourceArtifact: validated.artifactRef, coverageValidated: true, sourceRequirementCount: digest.requirements.length, sourceScenarioCount: digest.requirements.reduce((sum, req) => sum + req.scenarios.length, 0) };
      completedStages.push("spec_optimize");
    } catch (error) {
      if (isCancellation(error)) throw error;
      stopReason = "openspec_stage_failed";
      return finish("failed", `OpenSpec stage failed before planning: ${failureDetails(error)}`);
    }
  }
  for (const stage of profile.stages) {
    currentStage = stage;
    if (stage === "implement" && input.approval) {
      // patched(): runs already waiting without a timer must replay the original unbounded wait.
      if (patched("approval-timeout")) { if (!(await condition(() => approved || rejected, input.approvalTimeoutMs ?? 86_400_000))) { stopReason = "approval_timeout"; return finish("failed", "human approval timed out; no changes were published"); } }
      else await condition(() => approved || rejected);
      if (rejected) return { runId: input.runId, status: "rejected", stages, artifactRefs, message: "human approval rejected" }; }
    const effectiveStage: StageName = stage;
    let output: StageOutput;
    try {
      if (stage === "review" && profile.stages.includes("verify")) {
        const round = ++reviewCount;
        const [review, verification] = await Promise.all([
          execute("review", { prompt: reviewPrompt(formatBrief(executionBrief!), stages, round, Boolean(input.injectReviewFailure && repairCount === 0 || input.repeatReviewFailure), true, uiUxContext) }),
          execute("verify", { provider: "fake", verificationOnly: true }),
        ]);
        output = review;
        deterministicVerification = verification;
      } else if (stage === "verify" && deterministicVerification) {
        if (!deterministicVerification.ok) output = deterministicVerification;
        else output = await execute("verify", { deterministicChecksAlreadyPassed: true, qualityCommands: [] });
      } else {
        output = stage === "review" ? await execute("review", { prompt: reviewPrompt(formatBrief(executionBrief!), stages, ++reviewCount, Boolean(input.injectReviewFailure && repairCount === 0 || input.repeatReviewFailure), false, uiUxContext) })
          : stage === "brief" ? await execute("brief")
          : await execute(effectiveStage);
      }
    }
    catch (error) { if (isCancellation(error)) throw error; stopReason = `${stage}_activity_failed`; return finish("failed", `${stage} Activity failed after bounded retries: ${failureDetails(error)}`); }
    if (stage === "plan") {
      try {
        const parsedPlan = parseStructured(output.summary, PlanSchema, "Plan", Number.MAX_SAFE_INTEGER);
        // Treat source requirements as authoritative; do not preserve boilerplate
        // the model may mistakenly classify as a project constraint.
        const validatedSpecConstraints = optimizedOpenSpec
          ? ((JSON.parse(optimizedOpenSpec) as { hard_constraints?: string[] }).hard_constraints ?? [])
          : extractHardConstraints(openSpecContext);
        const firstPlan: Plan = { ...parsedPlan, hard_constraints: [...new Set([...validatedSpecConstraints, ...extractTaskConstraints(workflowPrompt)])] };
        try {
          parseStructured(output.summary, PlanSchema, "Plan", HANDOFF_BUDGETS.plan, stageCompletionTokens(output));
          plan = firstPlan;
        } catch (budgetError) {
          if (!(budgetError instanceof Error) || !budgetError.message.includes("exceeds its")) throw budgetError;
          const compressedOutput = await execute("plan", { prompt: compressPlanPrompt(firstPlan) });
          const compressedPlan = parseStructured(compressedOutput.summary, PlanSchema, "Compressed plan", HANDOFF_BUDGETS.plan, stageCompletionTokens(compressedOutput));
          validatePlanCompression(firstPlan, compressedPlan);
          plan = compressedPlan;
          output = compressedOutput;
        }
      }
      catch (error) { stopReason = "plan_output_invalid"; return finish("failed", `planning output rejected: ${failureDetails(error)}`); }
    }
    if (stage === "brief") {
      try {
        if (!plan) throw new Error("plan output is unavailable");
        const parsedBrief = parseStructured(output.summary, ExecutionBriefSchema, "Execution brief", Number.MAX_SAFE_INTEGER);
        const firstBrief = canonicalizeBrief(parsedBrief, plan, openSpecContext);
        try {
          // Reconstitute protected source requirements deterministically before
          // checking the budget. Providers can paraphrase or omit a constraint;
          // canonicalization restores it from the validated plan/OpenSpec, and
          // validation still fails closed if the complete brief cannot fit.
          executionBrief = validateBrief(formatBrief(firstBrief), plan, openSpecContext);
        } catch (budgetError) {
          if (!(budgetError instanceof Error) || !budgetError.message.includes("exceeds its")) throw budgetError;
          let compressionError: unknown;
          let compressedOutput: StageOutput | undefined;
          for (const targetTokens of [650, 500]) {
            const candidateOutput = await execute("brief", { prompt: compressBriefPrompt(firstBrief, targetTokens) });
            try {
              const compressedBrief = parseStructured(candidateOutput.summary, ExecutionBriefSchema, "Compressed brief", HANDOFF_BUDGETS.brief, stageCompletionTokens(candidateOutput));
              const protectedBrief = canonicalizeBrief(compressedBrief, plan, openSpecContext);
              validateBriefCompression(firstBrief, protectedBrief);
              executionBrief = validateBrief(formatBrief(protectedBrief), plan, openSpecContext);
              compressedOutput = candidateOutput;
              break;
            } catch (compressionValidationError) {
              compressionError = compressionValidationError;
              if (!(compressionValidationError instanceof Error) || !compressionValidationError.message.includes("exceeds its")) throw compressionValidationError;
            }
          }
          if (!compressedOutput) throw compressionError ?? new Error("Execution brief could not fit its token budget");
          output = compressedOutput;
        }
      } catch (error) { stopReason = "brief_output_invalid"; return finish("failed", `execution brief rejected: ${failureDetails(error)}`); }
    }
    if (stage === "review") {
      output.metadata = { ...output.metadata, reviewRound: reviewCount, ...(output.review ? { reviewFindingCount: output.review.findings.length, nonBlockingNoteCount: output.review.notes.length } : {}) };
      recordReview(output, reviewCount);
      nonBlockingNotes.push(...(output.review?.notes ?? []));
      let blocking = blockingFindings(output); const external = externalBlockers(output);
      if (external.length) { unresolvedFindings.push(...external); stopReason = "external_or_approval_prerequisite"; return finish("failed", "review stopped: external prerequisite requires operator action"); }
      if (blocking.length && reviewCount < maxRounds) {
        repairCount++;
        try { await execute("implement", { prompt: implementationPrompt(formatBrief(executionBrief!), blocking, input.qualityCommands, uiUxContext) }); }
        catch (error) { if (isCancellation(error)) throw error; stopReason = "repair_activity_failed"; return finish("failed", `repair Activity failed: ${failureDetails(error)}`); }
        try {
          const verification = await execute("verify", { provider: "fake", model: undefined, verificationOnly: true });
          deterministicVerification = verification;
          if (!verification.ok) { unresolvedFindings.push(...blocking); stopReason = "deterministic_checks_failed_after_repair"; return finish("failed", `deterministic checks failed after review repair: ${verification.summary}`); }
        } catch (error) { if (isCancellation(error)) throw error; unresolvedFindings.push(...blocking); stopReason = "deterministic_checks_failed_after_repair"; return finish("failed", `deterministic checks failed after review repair: ${failureDetails(error)}`); }
        try { output = await execute("review", { prompt: reviewPrompt(formatBrief(executionBrief!), stages, ++reviewCount, Boolean(input.repeatReviewFailure), false, uiUxContext) }); }
        catch (error) { if (isCancellation(error)) throw error; stopReason = "follow_up_review_failed"; return finish("failed", `follow-up review failed: ${failureDetails(error)}`); }
        output.metadata = { ...output.metadata, reviewRound: reviewCount, ...(output.review ? { reviewFindingCount: output.review.findings.length, nonBlockingNoteCount: output.review.notes.length } : {}) };
        recordReview(output, reviewCount);
        nonBlockingNotes.push(...(output.review?.notes ?? [])); blocking = blockingFindings(output); const followupExternal = externalBlockers(output);
        if (followupExternal.length) { unresolvedFindings.push(...followupExternal); stopReason = "external_or_approval_prerequisite"; return finish("failed", "follow-up review stopped: external prerequisite requires operator action"); }
        if (blocking.length || !output.ok) {
          unresolvedFindings.push(...(blocking.length ? blocking : output.findings.map(title => ({ severity: "high" as const, category: "other" as const, title, evidence: title, fixableInCode: true }))));
          stopReason = "blocking_findings_remain_after_final_review";
          return finish("failed", "review quality gate failed after the maximum of two review rounds");
        }
        findingsFixed += blockingFindings(stages.filter(item => item.stage === "review")[0]!).length;
      } else if (blocking.length) {
        unresolvedFindings.push(...blocking); stopReason = "blocking_findings_remain_after_final_review";
        return finish("failed", "review quality gate failed after the maximum of two review rounds");
      }
      if (!output.ok && blocking.length === 0) {
        unresolvedFindings.push(...output.findings.map(title => ({ severity: "high" as const, category: "other" as const, title, evidence: title, fixableInCode: false })));
        stopReason = "unclassified_review_failure"; return finish("failed", "review failed without a structured code-fixable finding");
      }
    }
    if (!output.ok) { stopReason = `${stage}_quality_gate_failed`; return finish("failed", `${stage} quality gate failed`); }
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
        // Gates passed; an unticked checklist is usually bookkeeping (e.g. manual-only items). Reconcile once, then archive again.
        if (isCancellation(archiveError) || !patched("openspec-checklist-reconcile") || !/checklist.*is not complete|incomplete/i.test(failureDetails(archiveError, 4000))) throw archiveError;
        const reconciled = await execute("openspec", { provider: "codex", providerTimeoutMs: input.providerTimeouts?.openspec ?? 720_000, openSpecChangeId, prompt: openSpecChecklistReconcilePrompt({ changeId: openSpecChangeId, error: failureDetails(archiveError, 2000) }) });
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
  if (workspace !== input.projectRoot) artifactRefs.push(await collectWorktree({ runId: input.runId, projectRoot: input.projectRoot, worktree: workspace, artifactsDir: input.artifactsDir }));
  if (input.repository && workspace !== input.projectRoot) {
    try {
      const publish = await publishWorktree({ repository: input.repository, worktree: workspace, taskId: input.taskId, prompt: input.prompt });
      return { ...finish("completed", "quality gates passed; draft PR published"), publish };
    } catch (error) {
      stopReason = "publish_failed"; return finish("failed", `publish failed; task requires recovery: ${failureDetails(error)}`);
    }
  }
  return finish("completed", "workflow completed");
}
