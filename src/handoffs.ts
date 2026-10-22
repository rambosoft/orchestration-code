import { z } from "zod";

// The OpenSpec digest must cover every requirement and scenario, so it is capped below the planning context
// (digest + task text + instructions must fit) rather than at an arbitrary small size.
// The brief must carry the plan's protected hard constraints and acceptance criteria verbatim, so its cap
// has to exceed the plan cap by the brief's own overhead (goal, steps, avoid list); otherwise a verbose but
// valid plan can never produce a valid brief, however often it is compressed.
export const HANDOFF_BUDGETS = { planningContext: 2800, openSpecDigest: 2200, plan: 900, brief: 1200, reviewChecklist: 900 } as const;

// Provider-independent conservative estimate. Three characters per token
// leaves headroom for punctuation-heavy, multilingual, and structured text.
export function estimateTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 3);
}

/** A brief over its soft cap is still accepted (and flagged) up to this ceiling after compression has failed. */
export const BRIEF_HARD_CEILING = Math.floor(HANDOFF_BUDGETS.brief * 1.5);

export function assertTokenBudget(label: string, text: string, budget: number, actualTokens?: number): void {
  const estimated = actualTokens ?? estimateTokens(text);
  if (estimated > budget) throw new Error(`${label} exceeds its ${budget}-token budget (${actualTokens === undefined ? "estimated " : "measured "}${estimated}); shorten the source without dropping requirements`);
}

export const PlanSchema = z.object({
  task_goal: z.string().min(1),
  approach: z.string().min(1),
  important_decisions: z.array(z.string()),
  risks: z.union([z.array(z.string()), z.string()]).transform(value => Array.isArray(value) ? value : [value]),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  hard_constraints: z.array(z.string()),
}).strict();
export type Plan = z.infer<typeof PlanSchema>;

export const ExecutionBriefSchema = z.object({
  task_goal: z.string().min(1),
  files_or_modules: z.array(z.string()),
  must_follow: z.array(z.string()),
  must_avoid: z.array(z.string()),
  implementation_steps: z.array(z.string()),
  verification_steps: z.array(z.string()),
  acceptance_checks: z.array(z.string().min(1)).min(1),
}).strict();
export type ExecutionBrief = z.infer<typeof ExecutionBriefSchema>;

export function parseStructured<T>(raw: string, schema: z.ZodType<T>, label: string, budget: number, actualTokens?: number): T {
  assertTokenBudget(label, raw, budget, actualTokens);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`${label} is not valid JSON`); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} does not match its required schema: ${parsed.error.issues.map(issue => issue.path.join(".") || issue.message).join(", ")}`);
  return parsed.data;
}

export function compressPlanPrompt(plan: Plan): string {
  return `Compress this plan to at most ${HANDOFF_BUDGETS.plan} tokens. Keep task_goal and approach to one concise sentence each. Keep at most 4 implementation-changing decisions and 2 concrete risks; omit points already covered by the approach or acceptance criteria. Preserve every acceptance_criteria and hard_constraints string exactly, without omission or weakening. Return only the same JSON schema: {"task_goal":"string","approach":"string","important_decisions":["string"],"risks":["string"],"acceptance_criteria":["string"],"hard_constraints":["string"]}.\n\nPlan to compress:\n${JSON.stringify(plan)}`;
}

export function validatePlanCompression(original: Plan, compressed: Plan): void {
  const missing = [
    ...original.acceptance_criteria.filter(item => !compressed.acceptance_criteria.includes(item)),
    ...original.hard_constraints.filter(item => !compressed.hard_constraints.includes(item)),
  ];
  if (missing.length) throw new Error(`Compressed plan omitted protected requirements: ${missing.map(item => item.slice(0, 160)).join(" | ")}`);
}

export function compressBriefPrompt(brief: ExecutionBrief, targetTokens = 650): string {
	return `Compress this execution brief to at most ${targetTokens} tokens (absolute cap ${HANDOFF_BUDGETS.brief}). Priority: (1) preserve every must_follow item exactly in must_follow; (2) preserve every acceptance_checks item exactly; (3) shorten or remove redundant steps, files, and must_avoid items. Never move, weaken, or omit must_follow constraints or acceptance checks. Remove duplicate acceptance checks only when the identical check is already present in must_follow. Return only the same JSON schema: {"task_goal":"string","files_or_modules":["string"],"must_follow":["string"],"must_avoid":["string"],"implementation_steps":["string"],"verification_steps":["string"],"acceptance_checks":["string"]}.\n\nBrief to compress:\n${JSON.stringify(brief)}`;
}

export function validateBriefCompression(original: ExecutionBrief, compressed: ExecutionBrief): void {
	const missing = [...original.must_follow.filter(item => !compressed.must_follow.includes(item)), ...original.acceptance_checks.filter(item => !compressed.acceptance_checks.includes(item) && !compressed.must_follow.includes(item))];
  if (missing.length) throw new Error(`Compressed brief omitted protected requirements: ${missing.map(item => item.slice(0, 160)).join(" | ")}`);
}

export function canonicalizeBrief(brief: ExecutionBrief, plan: Plan, openSpecContext: string): ExecutionBrief {
  const applyDirective = openSpecContext ? ["Use the $openspec-apply-change workflow and mark checklist items complete only after code and validation are complete."] : [];
  // The plan is built from the coverage-validated OpenSpec digest, so its
  // protected constraints are the compact source of truth for this handoff.
  // Re-extracting from the archival context would reintroduce whole paragraphs
  // and duplicate requirements that the digest already preserved.
  const mustFollow = [...new Set([...plan.hard_constraints, ...applyDirective])];
  const acceptanceChecks = [...new Set(plan.acceptance_criteria)];
  const mustAvoid = brief.must_avoid.filter(item => /\b(?:must not|shall not|do not|never|avoid)\b/i.test(item));
  return {
    task_goal: plan.task_goal,
    files_or_modules: [...new Set(brief.files_or_modules)].slice(0, 6),
    must_follow: mustFollow,
    must_avoid: mustAvoid,
    implementation_steps: brief.implementation_steps.slice(0, 5),
    verification_steps: brief.verification_steps.slice(0, 4),
    acceptance_checks: acceptanceChecks,
  };
}

export const OpenSpecDigestSchema = z.object({
  task_goal: z.string().min(1).max(180),
  requirements: z.array(z.object({ id: z.string().min(1), intent: z.string().min(1).max(220), scenarios: z.array(z.object({ id: z.string().min(1), expected: z.string().min(1).max(200) })).default([]) })).default([]),
  hard_constraints: z.array(z.string()), relevant_design_decisions: z.array(z.string()).max(1),
}).strict();
export type OpenSpecDigest = z.infer<typeof OpenSpecDigestSchema>;

export function openSpecCoverage(context: string): { requirements: string[]; scenarios: string[]; hardConstraints: string[] } {
  const requirements = [...context.matchAll(/^### Requirement:\s*(.+)$/gm)].map(m => `Requirement: ${m[1]!.trim()}`);
  const scenarios = [...context.matchAll(/^#### Scenario:\s*(.+)$/gm)].map(m => `Scenario: ${m[1]!.trim()}`);
  return { requirements, scenarios, hardConstraints: extractHardConstraints(context) };
}

export function openSpecOptimizationPrompt(context: string): string {
  const coverage = openSpecCoverage(context);
  return `Semantically optimize this validated OpenSpec for planning. Start with task_goal: one concise sentence (max 180 characters), with no background. Preserve each listed requirement and scenario by exact ID; capture complete intent in max 220 characters and each observable outcome in max 200 characters. Preserve every hard constraint verbatim. Retain at most ONE high-impact implementation decision that is not already stated in requirements or constraints; omit repeated rationale and alternatives. Do not delete, merge, or broaden requirements. Keep total JSON under 1400 tokens. Return only JSON matching {"task_goal":"one concise sentence","requirements":[{"id":"exact Requirement: title","intent":"concise complete intent","scenarios":[{"id":"exact Scenario: title","expected":"concise observable outcome"}]}],"hard_constraints":["exact source text"],"relevant_design_decisions":["one novel implementation-changing decision, or an empty array"]}.\nCoverage ledger (all entries mandatory):\n${JSON.stringify(coverage)}\nValidated source:\n${context}`;
}

export function repairOpenSpecDigestPrompt(context: string, invalidOutput: string, diagnostic: string): string {
  return `Repair the OpenSpec digest response. The prior response failed validation: ${diagnostic}. Return valid JSON only, matching the exact schema and preserving every source requirement/scenario ID and every required hard constraint. Do not add keys, duplicate keys, omit coverage, or change requirement meaning. Keep under 1400 tokens.\n\nCoverage ledger and full validated source:\n${openSpecOptimizationPrompt(context)}\n\nInvalid prior response to repair:\n${invalidOutput}`;
}

export function validateOpenSpecDigest(raw: string, context: string, actualTokens?: number): OpenSpecDigest {
  const digest = parseStructured(raw, OpenSpecDigestSchema, "OpenSpec optimization", HANDOFF_BUDGETS.openSpecDigest, actualTokens);
  const source = openSpecCoverage(context);
  const gotReq = digest.requirements.map(r => r.id), gotScenarios = digest.requirements.flatMap(r => r.scenarios.map(s => s.id));
  const missing = [...source.requirements.filter(id => !gotReq.includes(id)), ...source.scenarios.filter(id => !gotScenarios.includes(id)), ...source.hardConstraints.filter(c => !digest.hard_constraints.includes(c))];
  const duplicate = [...gotReq, ...gotScenarios].filter((id, i, all) => all.indexOf(id) !== i);
  const extra = [...gotReq, ...gotScenarios].filter(id => ![...source.requirements, ...source.scenarios].includes(id));
  const extraConstraints = digest.hard_constraints.filter(constraint => !source.hardConstraints.includes(constraint));
  if (missing.length || duplicate.length || extra.length || extraConstraints.length) throw new Error(`OpenSpec optimization failed coverage validation; missing=${missing.join(" | ")}; duplicate=${duplicate.join(" | ")}; extra=${extra.join(" | ")}; extraConstraints=${extraConstraints.join(" | ")}`);
  return digest;
}

export function planningPrompt(task: string, optimizedOpenSpec: string, _uiUxContext = ""): string {
  const source = ["Task:", task, optimizedOpenSpec ? `Semantically optimized, coverage-validated OpenSpec:\n${optimizedOpenSpec}` : ""].filter(Boolean).join("\n\n");
  assertTokenBudget("Planning context", source, HANDOFF_BUDGETS.planningContext);
  return `${source}\n\nChoose one implementation approach. Return only one JSON object matching this schema: {"task_goal":"string","approach":"string","important_decisions":["string"],"risks":["string"],"acceptance_criteria":["testable string"],"hard_constraints":["exact source constraint"]}. Keep the complete response within ${HANDOFF_BUDGETS.plan} tokens. Acceptance criteria must cover every explicit task and OpenSpec requirement, grouped into at most 5 concise, non-overlapping checks. Combine related requirements in a single testable sentence; do not create separate checks for requirement titles or visual details. Keep task_goal and approach to one concise sentence each, important_decisions to at most 4, and concrete risks to at most 2. Put only non-negotiable prohibitions, privacy rules, and factual guardrails in hard_constraints; place positive implementation and validation requirements in acceptance_criteria. Do not repeat a hard constraint as a separate acceptance criterion when one check can cover it. Copy all normative OpenSpec constraints (MUST/SHALL/NEVER/DO NOT/AVOID) verbatim into hard_constraints; do not invent constraints.`;
}

export function extractHardConstraints(context: string): string[] {
  // Keep only explicit prohibitions here. Positive design, quality, and scope
  // requirements belong in acceptance checks, where they can be consolidated
  // into testable outcomes instead of being repeated as constraints.
  const clauses = context.split(/\r?\n/).flatMap(line => line.trim().replace(/^[-*]\s+/, "").split(/(?<=[.!?])\s+(?=[A-Z0-9])/u));
  return [...new Set(clauses.map(clause => clause.trim()).filter(clause => /\b(?:MUST\s+NOT|SHALL\s+NOT|MUST\s+NEVER|SHALL\s+NEVER|NEVER|DO NOT)\b/i.test(clause)))];
}

export function extractOpenSpecAcceptance(context: string): string[] {
  return [...new Set(context.split(/\r?\n/).map(line => line.trim().replace(/^#{1,6}\s+/, "")).filter(line => /^Requirement:\s*\S/i.test(line)))];
}

export const compactOpenSpecContext = (context: string): string => context;

export function extractTaskConstraints(task: string): string[] {
  // Issue text is often markdown-escaped by the task tracker. Split its list
  // items before sentences so a prohibition does not drag neighboring positive
  // requirements and explanatory prose into the hard-constraint channel.
  const sentences = task.replace(/\\-\s+/g, "\n").split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/u).map(sentence => sentence.trim()).filter(Boolean);
  return [...new Set(sentences.filter(sentence => /\b(?:must\s+not|must\s+never|shall\s+not|shall\s+never|never|do\s+not|avoid)\b/i.test(sentence)))];
}

export function briefPrompt(_task: string, openSpecContext: string, plan: Plan): string {
  const applyDirective = openSpecContext ? ["Use the $openspec-apply-change workflow and mark checklist items complete only after code and validation are complete."] : [];
  const protectedItems = [...new Set([...plan.hard_constraints, ...plan.acceptance_criteria, ...applyDirective])];
  // Pass decisions plus protected requirements and source paths. The original
  // task, full spec prose, and criteria already represented in protectedItems
  // are intentionally omitted from this phase's context.
  const openSpecFiles = [...openSpecContext.matchAll(/^###\s+(openspec\/[^\r\n]+)/gm)].map(match => match[1]);
  const source = JSON.stringify({ task_goal: plan.task_goal, approach: plan.approach, important_decisions: plan.important_decisions, risks: plan.risks, openSpecFiles, requiredVerbatimItems: protectedItems });
  assertTokenBudget("Brief-builder input", source, HANDOFF_BUDGETS.planningContext);
  return `Build a concise implementation handoff from this source. Remove repetition, rationale, and rejected alternatives. Keep every requiredVerbatimItems entry exactly and completely in must_follow or acceptance_checks. Do not omit or weaken a hard constraint or acceptance criterion. Return only JSON matching: {"task_goal":"string","files_or_modules":["string"],"must_follow":["string"],"must_avoid":["string"],"implementation_steps":["string"],"verification_steps":["string"],"acceptance_checks":["string"]}. Keep the complete JSON within ${HANDOFF_BUDGETS.brief} tokens.\n\nSource:\n${source}`;
}

export function validateBrief(raw: string, plan: Plan, openSpecContext: string, actualTokens?: number, budget: number = HANDOFF_BUDGETS.brief): ExecutionBrief {
  const brief = parseStructured(raw, ExecutionBriefSchema, "Execution brief", budget, actualTokens);
  const combined = [...brief.must_follow, ...brief.acceptance_checks];
  const applyDirective = openSpecContext ? ["Use the $openspec-apply-change workflow and mark checklist items complete only after code and validation are complete."] : [];
  const missing = [...new Set([...plan.hard_constraints, ...plan.acceptance_criteria, ...applyDirective])].filter(item => !combined.includes(item));
  if (missing.length) throw new Error(`Execution brief omitted protected requirements: ${missing.map(item => item.slice(0, 160)).join(" | ")}`);
  assertTokenBudget("Review checklist", JSON.stringify({ acceptance_checks: brief.acceptance_checks }), HANDOFF_BUDGETS.reviewChecklist);
  return brief;
}

export function formatBrief(brief: ExecutionBrief): string {
  return JSON.stringify(brief, null, 2);
}
