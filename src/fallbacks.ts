// Deterministic substitutes for model-written handoffs. When a structured stage still cannot produce a valid answer after its repair pass, the run
// continues with these instead of failing: they are built only from validated inputs (the OpenSpec change, the task text, the validated plan), so
// they are correct by construction, if less polished than a good model answer.
import { canonicalizeBrief, estimateTokens, HANDOFF_BUDGETS, openSpecCoverage, type ExecutionBrief, type OpenSpecDigest, type Plan } from "./handoffs.js";

const clamp = (text: string, max: number): string => { const clean = text.replace(/\s+/g, " ").trim(); return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean; };
const stripMarkdown = (text: string): string => text.replace(/\*\*/g, "").replace(/^[-*]\s+/, "").trim();

/** One digest entry per requirement and scenario heading of the (change-only) OpenSpec context, with a short description taken from the text below it. */
function buildDigest(changeContext: string, taskGoal: string, intentMax: number, expectedMax: number): OpenSpecDigest {
  const coverage = openSpecCoverage(changeContext);
  const requirements: OpenSpecDigest["requirements"] = [];
  const seenRequirements = new Set<string>();
  const seenScenarios = new Set<string>();
  let currentRequirement: OpenSpecDigest["requirements"][number] | undefined;
  let currentScenario: { id: string; lines: string[] } | undefined;
  let intentLines: string[] = [];
  const pending: Array<{ id: string; expected: string }> = [];
  const closeScenario = () => {
    if (!currentScenario) return;
    const scenario = { id: currentScenario.id, expected: clamp(currentScenario.lines.join(" ") || "See the scenario in the OpenSpec change.", expectedMax) };
    if (currentRequirement) currentRequirement.scenarios.push(scenario); else pending.push(scenario);
    currentScenario = undefined;
  };
  const closeRequirement = () => { closeScenario(); if (currentRequirement) currentRequirement.intent = clamp(intentLines.join(" ") || currentRequirement.id.replace(/^Requirement:\s*/, ""), intentMax); intentLines = []; };
  for (const line of changeContext.split(/\r?\n/)) {
    const requirement = /^### Requirement:\s*(.+)$/.exec(line);
    const scenario = /^#### Scenario:\s*(.+)$/.exec(line);
    if (requirement) {
      closeRequirement();
      const id = `Requirement: ${requirement[1]!.trim()}`;
      currentRequirement = undefined;
      if (!seenRequirements.has(id)) { seenRequirements.add(id); currentRequirement = { id, intent: "", scenarios: [] }; requirements.push(currentRequirement); }
      continue;
    }
    if (scenario) {
      closeScenario();
      const id = `Scenario: ${scenario[1]!.trim()}`;
      if (!seenScenarios.has(id)) { seenScenarios.add(id); currentScenario = { id, lines: [] }; }
      continue;
    }
    if (/^#{1,3}\s/.test(line)) { closeScenario(); continue; }
    const text = stripMarkdown(line);
    if (!text) continue;
    if (currentScenario) currentScenario.lines.push(text);
    else if (currentRequirement && intentLines.length < 2) intentLines.push(text);
  }
  closeRequirement();
  if (pending.length) {
    // Scenarios that appear before any requirement heading still have to be covered; hang them on the first requirement.
    if (!requirements[0]) throw new Error("OpenSpec context has scenarios but no requirement to attach them to");
    requirements[0].scenarios.unshift(...pending);
  }
  return { task_goal: clamp(taskGoal || "Implement the requested change", 400), requirements, hard_constraints: coverage.hardConstraints, relevant_design_decisions: [] };
}

/** Digest built from the context alone. Descriptions shrink step by step until the digest fits its token budget (identifiers are never shortened). */
export function deterministicDigest(changeContext: string, taskGoal: string): OpenSpecDigest {
  let digest = buildDigest(changeContext, taskGoal, 700, 500);
  for (const [intentMax, expectedMax] of [[350, 250], [150, 100], [60, 40]] as const) {
    if (estimateTokens(JSON.stringify(digest)) <= HANDOFF_BUDGETS.openSpecDigest) break;
    digest = buildDigest(changeContext, taskGoal, intentMax, expectedMax);
  }
  return digest;
}

/** A plan whose acceptance criteria are the requirements of the change (or the task itself when there is no OpenSpec digest). */
export function deterministicPlan(input: { taskPrompt: string; digest?: OpenSpecDigest }): Plan {
  const criteria = (input.digest?.requirements ?? []).map(requirement => clamp(`${requirement.id.replace(/^Requirement:\s*/, "")}: ${requirement.intent}`, 220));
  const acceptance = criteria.length > 8 ? [...criteria.slice(0, 7), clamp(`Also satisfy: ${criteria.slice(7).join("; ")}`, 500)] : criteria;
  return {
    task_goal: clamp(input.digest?.task_goal ?? input.taskPrompt.split(/\r?\n/).find(line => line.trim()) ?? "Implement the requested behavior", 300),
    approach: "Extend the existing implementation to satisfy every listed requirement and scenario with the smallest complete change, following existing conventions.",
    important_decisions: [],
    risks: [],
    acceptance_criteria: acceptance.length ? acceptance : ["Implement the task as described and cover it with focused tests."],
    hard_constraints: [],
  };
}

/** A minimal brief; canonicalizeBrief restores every protected constraint and acceptance check from the plan. */
export function deterministicBrief(plan: Plan, openSpecContext: string): ExecutionBrief {
  return canonicalizeBrief({
    task_goal: plan.task_goal,
    files_or_modules: [],
    must_follow: [],
    must_avoid: [],
    implementation_steps: ["Inspect the existing code and tests that the requirements touch", "Implement the requirements with the smallest complete change", "Add focused tests for each requirement and scenario", "Run the configured quality commands and fix what they report"],
    verification_steps: ["Run the focused tests and the configured quality commands"],
    acceptance_checks: plan.acceptance_criteria,
  }, plan, openSpecContext);
}
