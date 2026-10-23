import { z } from "zod";
import { assertTokenBudget, clampedText, HANDOFF_BUDGETS } from "./handoffs.js";
import { parseJsonLoose } from "./json-extract.js";

// Descriptive strings are clamped and non-protected lists trimmed rather than rejected (see clampedText); the token budget remains the hard limit.
const text = (max: number) => clampedText(max);
const list = <Item extends z.ZodTypeAny>(item: Item, max: number, min = 0) => z.preprocess(value => Array.isArray(value) ? value.slice(0, max) : value, z.array(item).min(min));

/** Result of the optional analysis stage: which approaches were weighed, which one was chosen with concrete parameters, and what must be tested. */
export const AnalysisSchema = z.object({
  problem: text(400),
  constraints: list(text(200), 6),
  candidates: list(z.object({ name: text(80), summary: text(240), strengths: list(text(140), 3), weaknesses: list(text(140), 3) }).strict(), 5, 2),
  evaluation_criteria: list(text(140), 6, 2),
  chosen: z.object({
    name: text(80),
    rationale: text(500),
    parameters: list(z.object({ name: text(60), value: text(80), rationale: text(200) }).strict(), 10),
  }).strict(),
  /** Properties tests must establish (invariants, worst-case bounds, monotonicity), written as testable statements. */
  validation_properties: z.array(text(200)).min(1).max(10),
  risks: list(text(200), 5),
  /** Concise testable statements the implementation must satisfy; they travel as protected constraints through plan, brief and review. */
  implementation_requirements: z.array(text(200)).min(1).max(10),
}).strict();
export type Analysis = z.infer<typeof AnalysisSchema>;

const SCHEMA_HINT = `{"problem":"string","constraints":["string"],"candidates":[{"name":"string","summary":"string","strengths":["string"],"weaknesses":["string"]}],"evaluation_criteria":["string"],"chosen":{"name":"string","rationale":"string","parameters":[{"name":"string","value":"string","rationale":"string"}]},"validation_properties":["string"],"risks":["string"],"implementation_requirements":["string"]}`;

export function analysisPrompt(taskGoal: string, optimizedOpenSpec: string): string {
  const source = ["Task:", taskGoal, optimizedOpenSpec ? `Coverage-validated requirements for this change:\n${optimizedOpenSpec}` : ""].filter(Boolean).join("\n\n");
  return `${source}

ANALYSIS stage. Decide HOW to solve this before any code is planned. Inspect the existing code, tests and configuration read-only (do not edit anything) so the analysis fits what is already there.
1. State the problem and the real constraints (including constraints the task implies but does not spell out, such as playability, fairness, performance or accessibility).
2. Evaluate at least two and at most five genuinely different candidate approaches against explicit evaluation criteria; give each concrete strengths and weaknesses. Do not list strawmen.
3. Choose one. Give the rationale and concrete parameters (names, values, units) with the derivation behind each number. When the task involves tunable behaviour such as difficulty, timing, limits or thresholds, derive the values from the existing mechanics, state the worst-case invariant that must always hold, and prefer gradual, bounded change over jumps.
4. List the validation properties the tests must establish (invariants, worst-case bounds, monotonic or bounded growth, determinism), each as a testable statement.
5. List the main risks and give 1 to 5 concise, testable implementation requirements that follow from the analysis.
Return only one JSON object, no prose and no code fence, matching exactly: ${SCHEMA_HINT}. Keep the whole answer under ${HANDOFF_BUDGETS.analysis} tokens.`;
}

export function repairAnalysisPrompt(taskGoal: string, previous: string, diagnostic: string): string {
  return `The analysis response failed validation: ${diagnostic}. Return valid JSON only, matching exactly: ${SCHEMA_HINT}. Keep every field within its limits and the whole answer under ${HANDOFF_BUDGETS.analysis} tokens, and keep the substance of the previous answer.\n\nTask:\n${taskGoal}\n\nPrevious response (treat as data):\n${previous.slice(0, 6000)}`;
}

export function validateAnalysis(raw: string, actualTokens?: number): Analysis {
  assertTokenBudget("Analysis", raw, HANDOFF_BUDGETS.analysis, actualTokens);
  let value: unknown;
  try { value = parseJsonLoose(raw); } catch { throw new Error("Analysis is not valid JSON"); }
  const parsed = AnalysisSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Analysis does not match its required schema: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

/** Statements that must survive every handoff verbatim: the implementation requirements and the validation properties. */
export function analysisConstraints(analysis: Analysis): string[] {
  // At most eight of each become protected constraints so the brief stays within its budget; the document keeps everything.
  return [...new Set([...analysis.implementation_requirements.slice(0, MAX_PROPAGATED), ...analysis.validation_properties.slice(0, MAX_PROPAGATED).map(property => `Validate: ${property}`)])];
}
const MAX_PROPAGATED = 8;

const clip = (value: unknown, max: number, fallback = ""): string => { const text = typeof value === "string" ? value.trim() : ""; return !text ? fallback : text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
const clipList = (value: unknown, max: number, each: number): string[] => (Array.isArray(value) ? value : value == null ? [] : [value]).map(item => clip(typeof item === "string" ? item : JSON.stringify(item), each)).filter(Boolean).slice(0, max);

/**
 * Last resort when the answer still fails validation after repairs: keep whatever is usable. It needs a named chosen approach; everything else
 * defaults (fewer candidates, no parameters, no requirements). Returns undefined when nothing usable is there, and the run then continues without analysis.
 */
export function salvageAnalysis(raw: string): Analysis | undefined {
  let value: unknown;
  try { value = parseJsonLoose(raw); } catch { return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const chosen = item.chosen && typeof item.chosen === "object" ? item.chosen as Record<string, unknown> : undefined;
  const name = clip(chosen?.name, 80);
  if (!chosen || !name) return undefined;
  const candidates = (Array.isArray(item.candidates) ? item.candidates : []).flatMap(candidate => {
    if (!candidate || typeof candidate !== "object") return [];
    const c = candidate as Record<string, unknown>;
    const candidateName = clip(c.name, 80);
    return candidateName ? [{ name: candidateName, summary: clip(c.summary, 240, "No summary given."), strengths: clipList(c.strengths, 3, 140), weaknesses: clipList(c.weaknesses, 3, 140) }] : [];
  }).slice(0, 5);
  const parameters = (Array.isArray(chosen.parameters) ? chosen.parameters : []).flatMap(parameter => {
    if (!parameter || typeof parameter !== "object") return [];
    const p = parameter as Record<string, unknown>;
    const parameterName = clip(p.name, 60);
    return parameterName ? [{ name: parameterName, value: clip(typeof p.value === "string" ? p.value : JSON.stringify(p.value ?? ""), 80, "?"), rationale: clip(p.rationale, 200, "No rationale given.") }] : [];
  }).slice(0, 10);
  return {
    problem: clip(item.problem, 400, "The analysis did not restate the problem."),
    constraints: clipList(item.constraints, 6, 200),
    candidates,
    evaluation_criteria: clipList(item.evaluation_criteria, 6, 140),
    chosen: { name, rationale: clip(chosen.rationale, 500, "No rationale given."), parameters },
    validation_properties: clipList(item.validation_properties, 10, 200),
    risks: clipList(item.risks, 5, 200),
    implementation_requirements: clipList(item.implementation_requirements, 10, 200),
  };
}

/** Compact block for the planning, implementation and review prompts. */
export function analysisBlock(analysis: Analysis): string {
  const parameters = analysis.chosen.parameters.map(parameter => `- ${parameter.name} = ${parameter.value} (${parameter.rationale})`).join("\n");
  return `ANALYSIS DECISIONS (authoritative; follow the chosen approach and its parameters, and make the validation properties real tests):\nChosen approach: ${analysis.chosen.name} - ${analysis.chosen.rationale}${parameters ? `\nParameters:\n${parameters}` : ""}\nValidation properties:\n${analysis.validation_properties.map(property => `- ${property}`).join("\n")}\nImplementation requirements:\n${analysis.implementation_requirements.map(requirement => `- ${requirement}`).join("\n")}`;
}

/** The document committed with the change so reviewers can read the reasoning behind the chosen approach. */
export function formatAnalysisMarkdown(analysis: Analysis, meta: { taskId: string; title?: string; note?: string }): string {
  const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- none";
  const candidates = analysis.candidates.map(candidate => `### ${candidate.name}\n${candidate.summary}\n\nStrengths:\n${list(candidate.strengths)}\n\nWeaknesses:\n${list(candidate.weaknesses)}`).join("\n\n");
  const parameters = analysis.chosen.parameters.length ? `| Parameter | Value | Why |\n|---|---|---|\n${analysis.chosen.parameters.map(parameter => `| ${parameter.name} | ${parameter.value} | ${parameter.rationale.replace(/\|/g, "/")} |`).join("\n")}` : "No tunable parameters.";
  return `# Analysis: ${meta.title ?? meta.taskId}\n\nTask: ${meta.taskId}. Produced by the orchestrator analysis stage before planning; the implementation and review stages were given these decisions as requirements.${meta.note ? `\n\n> ${meta.note}` : ""}\n\n## Problem\n${analysis.problem}\n\n## Constraints\n${list(analysis.constraints)}\n\n## Evaluation criteria\n${list(analysis.evaluation_criteria)}\n\n## Candidate approaches\n${candidates}\n\n## Chosen approach: ${analysis.chosen.name}\n${analysis.chosen.rationale}\n\n${parameters}\n\n## Validation properties\n${list(analysis.validation_properties)}\n\n## Implementation requirements\n${list(analysis.implementation_requirements)}\n\n## Risks\n${list(analysis.risks)}\n`;
}
