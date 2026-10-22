import { z } from "zod";
import { assertTokenBudget, HANDOFF_BUDGETS } from "./handoffs.js";
import { parseJsonLoose } from "./json-extract.js";

const text = (max: number) => z.string().trim().min(1).max(max);

/** Result of the optional analysis stage: which approaches were weighed, which one was chosen with concrete parameters, and what must be tested. */
export const AnalysisSchema = z.object({
  problem: text(400),
  constraints: z.array(text(200)).max(6),
  candidates: z.array(z.object({ name: text(80), summary: text(240), strengths: z.array(text(140)).max(3), weaknesses: z.array(text(140)).max(3) }).strict()).min(2).max(5),
  evaluation_criteria: z.array(text(140)).min(2).max(6),
  chosen: z.object({
    name: text(80),
    rationale: text(500),
    parameters: z.array(z.object({ name: text(60), value: text(80), rationale: text(200) }).strict()).max(10),
  }).strict(),
  /** Properties tests must establish (invariants, worst-case bounds, monotonicity), written as testable statements. */
  validation_properties: z.array(text(200)).min(1).max(4),
  risks: z.array(text(200)).max(5),
  /** Concise testable statements the implementation must satisfy; they travel as protected constraints through plan, brief and review. */
  implementation_requirements: z.array(text(200)).min(1).max(5),
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
  return [...new Set([...analysis.implementation_requirements, ...analysis.validation_properties.map(property => `Validate: ${property}`)])];
}

/** Compact block for the planning, implementation and review prompts. */
export function analysisBlock(analysis: Analysis): string {
  const parameters = analysis.chosen.parameters.map(parameter => `- ${parameter.name} = ${parameter.value} (${parameter.rationale})`).join("\n");
  return `ANALYSIS DECISIONS (authoritative; follow the chosen approach and its parameters, and make the validation properties real tests):\nChosen approach: ${analysis.chosen.name} - ${analysis.chosen.rationale}${parameters ? `\nParameters:\n${parameters}` : ""}\nValidation properties:\n${analysis.validation_properties.map(property => `- ${property}`).join("\n")}\nImplementation requirements:\n${analysis.implementation_requirements.map(requirement => `- ${requirement}`).join("\n")}`;
}

/** The document committed with the change so reviewers can read the reasoning behind the chosen approach. */
export function formatAnalysisMarkdown(analysis: Analysis, meta: { taskId: string; title?: string }): string {
  const list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- none";
  const candidates = analysis.candidates.map(candidate => `### ${candidate.name}\n${candidate.summary}\n\nStrengths:\n${list(candidate.strengths)}\n\nWeaknesses:\n${list(candidate.weaknesses)}`).join("\n\n");
  const parameters = analysis.chosen.parameters.length ? `| Parameter | Value | Why |\n|---|---|---|\n${analysis.chosen.parameters.map(parameter => `| ${parameter.name} | ${parameter.value} | ${parameter.rationale.replace(/\|/g, "/")} |`).join("\n")}` : "No tunable parameters.";
  return `# Analysis: ${meta.title ?? meta.taskId}\n\nTask: ${meta.taskId}. Produced by the orchestrator analysis stage before planning; the implementation and review stages were given these decisions as requirements.\n\n## Problem\n${analysis.problem}\n\n## Constraints\n${list(analysis.constraints)}\n\n## Evaluation criteria\n${list(analysis.evaluation_criteria)}\n\n## Candidate approaches\n${candidates}\n\n## Chosen approach: ${analysis.chosen.name}\n${analysis.chosen.rationale}\n\n${parameters}\n\n## Validation properties\n${list(analysis.validation_properties)}\n\n## Implementation requirements\n${list(analysis.implementation_requirements)}\n\n## Risks\n${list(analysis.risks)}\n`;
}
