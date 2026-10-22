import { describe, expect, it } from "vitest";
import { briefPrompt, canonicalizeBrief, estimateTokens, ExecutionBriefSchema, formatBrief, extractHardConstraints, extractTaskConstraints, HANDOFF_BUDGETS, openSpecCoverage, openSpecOptimizationPrompt, parseStructured, PlanSchema, planningPrompt, repairOpenSpecDigestPrompt, validateBrief, validateBriefCompression, validateOpenSpecDigest, validatePlanCompression } from "../src/handoffs.js";
import { implementationPrompt } from "../src/workflows.js";

const plan = PlanSchema.parse({ task_goal: "Add a percentage button", approach: "Follow current calculator behavior", important_decisions: ["Keep existing semantics"], risks: [], acceptance_criteria: ["The button applies the existing percentage semantics."], hard_constraints: ["Do not change keyboard behavior."] });

describe("compressed handoff schemas and budgets", () => {
  it("normalizes a scalar planner risk into the compact plan schema", () => {
    const parsed = PlanSchema.parse({ task_goal: "Ship", approach: "Build", important_decisions: [], risks: "Regression risk", acceptance_criteria: ["Works"], hard_constraints: [] });
    expect(parsed.risks).toEqual(["Regression risk"]);
  });

  it("uses conservative token estimates and rejects oversized phase output", () => {
    expect(estimateTokens("12345678")).toBe(3);
    expect(() => parseStructured("x".repeat(4000), PlanSchema, "Plan", HANDOFF_BUDGETS.plan)).toThrow("exceeds its 900-token budget");
    expect(() => planningPrompt("task", "x".repeat(10_000))).toThrow("Planning context exceeds its 2800-token budget");
  });

  it("keeps planner acceptance checks grouped and non-duplicative", () => {
    const prompt = planningPrompt("Redesign the game page", "");
    expect(prompt).toContain("at most 5 concise, non-overlapping checks");
    expect(prompt).toContain("non-negotiable prohibitions, privacy rules, and factual guardrails");
    expect(prompt).toContain("Do not repeat a hard constraint as a separate acceptance criterion");
  });

  it("semantically optimizes OpenSpec only when every requirement, scenario, and hard constraint is covered", () => {
    const spec = `### openspec/changes/rework/specs/presentation/spec.md\n\n# Spec Delta\n\n## Purpose\n${"Repeated background rationale. ".repeat(90)}\n\n## Requirements\n\n### Requirement: Distinctive page composition\nThe page MUST use a cinematic game presentation.\n\n#### Scenario: Desktop hero\n- **WHEN** opened on desktop\n- **THEN** the hero has layered original art\n\n### Requirement: Safe preview\nThe form MUST NOT transmit or persist entered information.\n\n#### Scenario: Submit preview\n- **WHEN** submitted\n- **THEN** show a local response only\n\n### openspec/changes/rework/design.md\n\n${"Long design rationale. ".repeat(200)}\n\nThe implementation MUST preserve keyboard operation.`;
    const optimized = { task_goal: "Redesign the game presentation with stronger cinematic art direction.", requirements: [
      { id: "Requirement: Distinctive page composition", intent: "Create a cinematic game presentation.", scenarios: [{ id: "Scenario: Desktop hero", expected: "Layer original art in desktop hero." }] },
      { id: "Requirement: Safe preview", intent: "Keep entered information local and ephemeral.", scenarios: [{ id: "Scenario: Submit preview", expected: "Show a local-only response." }] },
      ], hard_constraints: ["The form MUST NOT transmit or persist entered information."], relevant_design_decisions: ["Favor layered composition over additional sections."] };
    expect(openSpecCoverage(spec).requirements).toHaveLength(2);
    expect(estimateTokens(openSpecOptimizationPrompt(spec))).toBeGreaterThan(estimateTokens(spec));
    expect(validateOpenSpecDigest(JSON.stringify(optimized), spec)).toEqual(optimized);
    expect(estimateTokens(JSON.stringify(optimized))).toBeLessThan(estimateTokens(spec) / 5);
    expect(() => validateOpenSpecDigest(JSON.stringify({ ...optimized, requirements: optimized.requirements.slice(1) }), spec)).toThrow("failed coverage validation");
    expect(() => validateOpenSpecDigest(JSON.stringify({ ...optimized, hard_constraints: optimized.hard_constraints.slice(1) }), spec)).toThrow("failed coverage validation");
    expect(() => validateOpenSpecDigest(JSON.stringify({ ...optimized, hard_constraints: [...optimized.hard_constraints, "Invented constraint"] }), spec)).toThrow("extraConstraints");
    expect(() => validateOpenSpecDigest(JSON.stringify({ ...optimized, relevant_design_decisions: ["x".repeat(8_000)] }), spec)).toThrow("exceeds its 2200-token budget");
    expect(() => planningPrompt("Redesign the game landing page", JSON.stringify(optimized))).not.toThrow();
  });

  it("repairs invalid optimizer output against the original coverage ledger", () => {
    const prompt = repairOpenSpecDigestPrompt("### Requirement: Safe\n#### Scenario: Submit", "{ malformed", "not valid JSON");
    expect(prompt).toContain("Repair the OpenSpec digest response");
    expect(prompt).toContain("not valid JSON");
    expect(prompt).toContain("Requirement: Safe");
    expect(prompt).toContain("{ malformed");
  });

  it("rejects malformed plan and execution brief JSON", () => {
    expect(() => parseStructured("not json", PlanSchema, "Plan", HANDOFF_BUDGETS.plan)).toThrow("not valid JSON");
    expect(() => parseStructured(JSON.stringify({ task_goal: "x" }), ExecutionBriefSchema, "Execution brief", HANDOFF_BUDGETS.brief)).toThrow("does not match its required schema");
  });

  it("accepts a shorter plan only when protected decisions remain verbatim", () => {
    const compact = { ...plan, approach: "Follow existing calculator behavior.", important_decisions: [], risks: [] };
    expect(() => validatePlanCompression(plan, compact)).not.toThrow();
    expect(() => validatePlanCompression(plan, { ...compact, hard_constraints: [] })).toThrow("omitted protected requirements");
  });

  it("extracts imperative task constraints without copying planner instructions", () => {
    expect(extractTaskConstraints("Modernize the page. Keep the form inert. Preserve keyboard access. Do not add network calls. Avoid new dependencies.")).toEqual(["Do not add network calls.", "Avoid new dependencies."]);
  });

  it("keeps prohibitions as hard constraints and treats positive requirements as acceptance work", () => {
    expect(extractHardConstraints("The page MUST use a strong art direction.\nThe form MUST NOT transmit visitor data.")).toEqual(["The form MUST NOT transmit visitor data."]);
    expect(extractHardConstraints("Use original map art with layered terrain and lighting. Do not imply it is gameplay.")).toEqual(["Do not imply it is gameplay."]);
    expect(extractTaskConstraints("Modernize the page. Do not send form values. Avoid new dependencies.")).toEqual(["Do not send form values.", "Avoid new dependencies."]);
  });

  it("keeps requirements and acceptance checks verbatim through brief validation", () => {
    const context = "Requirement: preserve current state semantics\nThe implementation MUST NOT change keyboard behavior.";
    const prompt = briefPrompt("Add a percentage button", context, plan);
    expect(prompt).not.toContain("The implementation MUST NOT change keyboard behavior.");
    expect(prompt).toContain("Do not change keyboard behavior.");
    expect(prompt).not.toContain("Requirement: preserve current state semantics");
    const result = {
      task_goal: "Add a percentage button", files_or_modules: ["calculator"],
      must_follow: ["The implementation MUST NOT change keyboard behavior.", "Do not change keyboard behavior.", "Use the $openspec-apply-change workflow and mark checklist items complete only after code and validation are complete."],
      must_avoid: [], implementation_steps: ["Add the control"], verification_steps: ["Run focused tests"],
      acceptance_checks: [...plan.acceptance_criteria, "Requirement: preserve current state semantics"],
    };
    const brief = validateBrief(JSON.stringify(result), plan, context);
    expect(brief.acceptance_checks).toContain(plan.acceptance_criteria[0]);
  });

  it("requires hard constraints to remain in must_follow and acceptance checks to remain intact", () => {
    const original = { task_goal: "x", files_or_modules: [], must_follow: ["Do not change keyboard behavior."], must_avoid: [], implementation_steps: ["One", "Two"], verification_steps: ["Run tests"], acceptance_checks: ["The button applies the existing percentage semantics."] };
    const compressed = { ...original, implementation_steps: ["Implement"], verification_steps: ["Run tests"] };
    expect(() => validateBriefCompression(original, compressed)).not.toThrow();
    expect(() => validateBriefCompression(original, { ...compressed, must_follow: [], acceptance_checks: [original.acceptance_checks[0]!] })).toThrow("omitted protected requirements");
  });

  it("reconstitutes exact protected requirements from the plan after provider paraphrasing", () => {
    const providerBrief = ExecutionBriefSchema.parse({ task_goal: plan.task_goal, files_or_modules: ["src/"], must_follow: [], must_avoid: [], implementation_steps: ["Implement"], verification_steps: ["Build"], acceptance_checks: ["A generic check."] });
    const canonical = canonicalizeBrief(providerBrief, plan, "");
    expect(canonical.must_follow).toContain("Do not change keyboard behavior.");
    expect(canonical.acceptance_checks).toContain("The button applies the existing percentage semantics.");
  });

  it("makes implementation handoffs materially shorter than repeated source context", () => {
    const context = `${"Project conventions and stable behavior. ".repeat(35)}\nThe implementation MUST NOT change keyboard behavior.`;
    const validated = validateBrief(JSON.stringify({
      task_goal: "Add a percentage button", files_or_modules: ["calculator"],
      must_follow: ["The implementation MUST NOT change keyboard behavior.", "Do not change keyboard behavior.", "Use the $openspec-apply-change workflow and mark checklist items complete only after code and validation are complete."], must_avoid: [],
      implementation_steps: ["Add the button"], verification_steps: ["Run focused tests"], acceptance_checks: plan.acceptance_criteria,
    }), plan, context);
    const implementation = implementationPrompt(JSON.stringify(validated));
    const repeatedSource = ["Add a percentage button", context, JSON.stringify(plan), context, JSON.stringify(plan)].join("\n\n");
    expect(estimateTokens(implementation)).toBeLessThan(estimateTokens(repeatedSource) * 0.7);
  });

  it("fails closed when a protected requirement is missing or checklist exceeds its budget", () => {
    const omitted = { task_goal: "x", files_or_modules: [], must_follow: [], must_avoid: [], implementation_steps: [], verification_steps: [], acceptance_checks: ["The button applies the existing percentage semantics."] };
    expect(() => validateBrief(JSON.stringify(omitted), plan, "The implementation MUST preserve keyboard behavior.")).toThrow("omitted protected requirements");
    const large = { ...omitted, must_follow: ["Do not change keyboard behavior."], acceptance_checks: [...plan.acceptance_criteria, "x".repeat(4500)] };
    expect(() => validateBrief(JSON.stringify(large), plan, "")).toThrow("exceeds its 1200-token budget");
  });
});

describe("brief budget vs verbose plan", () => {
  it("a valid plan near its own cap can always be turned into a valid brief (regression: dino-runner task 2)", () => {
    const criteria = Array.from({ length: 4 }, (_, i) => `Criterion ${i + 1}: ${"the system shall behave deterministically for identical inputs and report the outcome clearly; ".repeat(6)}`);
    const verbosePlan = PlanSchema.parse({ task_goal: "Extend the runner", approach: "Extend the pure rules", important_decisions: [], risks: [], acceptance_criteria: criteria, hard_constraints: [] });
    parseStructured(JSON.stringify(verbosePlan), PlanSchema, "Plan", HANDOFF_BUDGETS.plan);
    const brief = canonicalizeBrief({ task_goal: "x", files_or_modules: [], must_follow: [], must_avoid: [], implementation_steps: ["Implement the rules", "Wire the view", "Add tests"], verification_steps: ["Run tests"], acceptance_checks: [] }, verbosePlan, "ctx");
    expect(estimateTokens(formatBrief(brief))).toBeGreaterThan(800);
    expect(() => validateBrief(formatBrief(brief), verbosePlan, "ctx")).not.toThrow();
  });
});

describe("OpenSpec digest budget", () => {
  it("accepts a digest of ~1800 tokens that still fits the planning context (regression: dino-runner task 3)", () => {
    const reqs = Array.from({ length: 9 }, (_, i) => ({ id: `Requirement: R${i}`, intent: "x".repeat(200), scenarios: [{ id: `Scenario: S${i}a`, expected: "y".repeat(190) }, { id: `Scenario: S${i}b`, expected: "z".repeat(190) }] }));
    const context = reqs.map(r => `### ${r.id}\n${r.scenarios.map(sc => `#### ${sc.id}`).join("\n")}`).join("\n");
    const raw = JSON.stringify({ task_goal: "Polish the runner", requirements: reqs, hard_constraints: [], relevant_design_decisions: [] });
    expect(estimateTokens(raw)).toBeGreaterThan(1400);
    expect(() => validateOpenSpecDigest(raw, context)).not.toThrow();
    expect(() => planningPrompt("Polish the runner", raw)).not.toThrow();
  });
});
