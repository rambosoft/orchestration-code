import { describe, expect, it } from "vitest";
import { BRIEF_HARD_CEILING, canonicalizeBrief, estimateTokens, ExecutionBriefSchema, extractHardConstraints, formatBrief, HANDOFF_BUDGETS, PlanSchema, validateBrief, validateOpenSpecDigest } from "../src/handoffs.js";
import { deterministicBrief, deterministicDigest, deterministicPlan } from "../src/fallbacks.js";
import { parseReviewAssessment, reviewOutcome } from "../src/review.js";

// Small seeded generator so a failing case is reproducible from its seed.
function rng(seed: number) { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; }; }
const pick = <T,>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const WORDS = ["dino", "runner", "speed", "gap", "jump", "score", "pause", "curve", "ramp", "limit", "obstacle", "cactus", "résumé", "日本語", "emoji🙂", "a|b", "`code`", "<tag>", "50%", "C:\\path", "#hash", "- dash", "**bold**"];
const sentence = (random: () => number, min = 3, max = 14) => Array.from({ length: min + Math.floor(random() * (max - min)) }, () => pick(random, WORDS)).join(" ");

function randomContext(seed: number): string {
  const random = rng(seed);
  const parts: string[] = ["### openspec/changes/c1/proposal.md\n\n## Why\n" + sentence(random)];
  const files = 1 + Math.floor(random() * 3);
  for (let f = 0; f < files; f++) {
    const lines: string[] = [`### openspec/changes/c1/specs/cap${f}/spec.md`, "", pick(random, ["## ADDED Requirements", "## MODIFIED Requirements"]), ""];
    if (random() < 0.15) lines.push("#### Scenario: orphan scenario before any requirement", "- **WHEN** x", "");
    const requirements = Math.floor(random() * 7);
    for (let r = 0; r < requirements; r++) {
      lines.push(`### Requirement: ${sentence(random, 1, 5)}`);
      if (random() < 0.9) lines.push(`The system ${pick(random, ["SHALL", "MUST", "MUST NOT", "SHALL NOT"])} ${sentence(random)}.`);
      if (random() < 0.2) lines.push("", sentence(random, 20, 60));
      const scenarios = Math.floor(random() * 5);
      for (let s = 0; s < scenarios; s++) lines.push("", `#### Scenario: ${sentence(random, 1, 4)}`, `- **WHEN** ${sentence(random)}`, `- **THEN** ${sentence(random)}`);
      if (random() < 0.1) lines.push("", `### Requirement: duplicate heading`, "text", `### Requirement: duplicate heading`);
      lines.push("");
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

describe("deterministic digest is valid by construction", () => {
  it("covers every requirement, scenario and hard constraint of 300 random OpenSpec contexts", () => {
    let nonTrivial = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const context = randomContext(seed);
      let digest;
      try { digest = deterministicDigest(context, `goal ${seed}`); }
      catch (error) { // the only legitimate refusal: scenarios exist but there is no requirement to attach them to
        expect(String(error)).toContain("no requirement to attach");
        continue;
      }
      expect(() => validateOpenSpecDigest(JSON.stringify(digest), context), `seed ${seed}`).not.toThrow();
      if (digest.requirements.length > 0) nonTrivial++;
    }
    expect(nonTrivial).toBeGreaterThan(150);
  });
  it("keeps the digest inside its token budget by shortening descriptions, not identifiers", () => {
    const heavy = Array.from({ length: 14 }, (_, i) => `### Requirement: Behavior number ${i}\n${"The system SHALL do a long and wordy thing. ".repeat(30)}\n\n#### Scenario: Case ${i}a\n- **WHEN** ${"something happens ".repeat(30)}\n\n#### Scenario: Case ${i}b\n- **WHEN** ${"another thing ".repeat(30)}`).join("\n\n");
    const digest = deterministicDigest(heavy, "g");
    expect(estimateTokens(JSON.stringify(digest))).toBeLessThanOrEqual(HANDOFF_BUDGETS.openSpecDigest);
    expect(digest.requirements).toHaveLength(14);
    expect(() => validateOpenSpecDigest(JSON.stringify(digest), heavy)).not.toThrow();
  });
});

describe("deterministic plan and brief always satisfy the downstream validators", () => {
  it("builds a plan and a brief that carry every protected constraint, for random contexts", () => {
    for (let seed = 1000; seed < 1150; seed++) {
      const context = randomContext(seed);
      let digest; try { digest = deterministicDigest(context, `goal ${seed}`); } catch { continue; }
      const plan = { ...deterministicPlan({ taskPrompt: `Task ${seed}\nsecond line`, digest }), hard_constraints: [...new Set([...digest.hard_constraints, "Do not change the public API."])] };
      expect(() => PlanSchema.parse(plan), `plan seed ${seed}`).not.toThrow();
      expect(estimateTokens(JSON.stringify(plan)), `plan size seed ${seed}`).toBeLessThanOrEqual(HANDOFF_BUDGETS.plan * 2);
      const brief = deterministicBrief(plan, context);
      expect(() => validateBrief(formatBrief(brief), plan, context, undefined, BRIEF_HARD_CEILING), `brief seed ${seed}`).not.toThrow();
      for (const constraint of plan.hard_constraints) expect(brief.must_follow).toContain(constraint);
    }
  });
  it("works without any OpenSpec digest", () => {
    const plan = deterministicPlan({ taskPrompt: "Add a pause button\nwith keyboard support" });
    expect(plan.task_goal).toBe("Add a pause button");
    expect(plan.acceptance_criteria.length).toBeGreaterThan(0);
    expect(() => validateBrief(formatBrief(deterministicBrief(plan, "")), plan, "", undefined, BRIEF_HARD_CEILING)).not.toThrow();
  });
});

describe("tolerant handoff schemas", () => {
  it("accept extra keys, scalars where lists are expected, numbers inside lists, and missing fields", () => {
    const plan = PlanSchema.parse({ task_goal: "Goal", approach: "A", notes: "extra field", risks: "one risk", acceptance_criteria: ["x", 3, { a: 1 }], important_decisions: null });
    expect(plan.risks).toEqual(["one risk"]);
    expect(plan.acceptance_criteria).toEqual(["x", "3", "{\"a\":1}"]);
    expect(plan.important_decisions).toEqual([]);
    expect(plan.hard_constraints).toEqual([]);
    const bare = PlanSchema.parse({});
    expect(bare.task_goal.length).toBeGreaterThan(0);
    expect(bare.acceptance_criteria).toHaveLength(1);
    const brief = ExecutionBriefSchema.parse({ must_follow: "only one", extra: true, acceptance_checks: [] });
    expect(brief.must_follow).toEqual(["only one"]);
    expect(brief.acceptance_checks).toHaveLength(1);
    expect(brief.implementation_steps).toEqual([]);
  });
  it("canonicalizeBrief restores protected constraints a model dropped", () => {
    const plan = PlanSchema.parse({ task_goal: "g", approach: "a", acceptance_criteria: ["Criterion"], hard_constraints: ["Do not change X."] });
    const restored = canonicalizeBrief(ExecutionBriefSchema.parse({ task_goal: "g" }), plan, "");
    expect(restored.must_follow).toContain("Do not change X.");
    expect(restored.acceptance_checks).toContain("Criterion");
  });
  it("hard constraints extracted from a context always round-trip through the digest", () => {
    const context = randomContext(77);
    for (const constraint of extractHardConstraints(context)) expect(deterministicDigest(context, "g").hard_constraints).toContain(constraint);
  });
});

describe("review assessment parsing", () => {
  const blocking = { verdict: "needs_changes", findings: [{ severity: "high", category: "functional", title: "Broken", evidence: "e", fixableInCode: true }], notes: [] };
  it.each([
    ["bare JSON", JSON.stringify(blocking)],
    ["fenced JSON", "```json\n" + JSON.stringify(blocking) + "\n```"],
    ["JSON inside prose", "Here is my review: " + JSON.stringify(blocking) + " Thanks."],
  ])("reads %s and enforces the blocking finding", (_label, text) => {
    const review = parseReviewAssessment(text)!;
    expect(review.verdict).toBe("needs_changes");
    expect(reviewOutcome(review).ok).toBe(false);
  });
  it("normalizes unknown severities and categories, string findings and missing evidence instead of discarding the review", () => {
    const review = parseReviewAssessment(JSON.stringify({ verdict: "NEEDS-CHANGES", findings: [{ severity: "blocker", category: "performance", title: "Slow", fixableInCode: true }, "A bare string finding", { summary: "Alt title", reason: "because" }], notes: [{ title: "n" }] }))!;
    expect(review.findings).toHaveLength(3);
    expect(review.findings[0]).toMatchObject({ severity: "medium", category: "other", title: "Slow", evidence: "Slow" });
    expect(review.findings[2]).toMatchObject({ title: "Alt title", evidence: "because" });
    expect(review.notes).toHaveLength(1);
  });
  it("accepts a pass with no findings, a VERDICT line, and rejects unreadable answers", () => {
    expect(reviewOutcome(parseReviewAssessment('{"verdict":"pass","findings":[],"notes":[]}')!).ok).toBe(true);
    expect(parseReviewAssessment("Looks fine.\nVERDICT: PASS")?.verdict).toBe("pass");
    expect(reviewOutcome(parseReviewAssessment("Bug found\nVERDICT: NEEDS_CHANGES")!).ok).toBe(false);
    expect(parseReviewAssessment("I looked at it and it seems okay overall.")).toBeUndefined();
    expect(parseReviewAssessment("")).toBeUndefined();
  });
  it("treats environment findings and non-fixable findings as external blockers, medium findings as non-blocking", () => {
    expect(reviewOutcome(parseReviewAssessment(JSON.stringify({ verdict: "needs_changes", findings: [{ severity: "high", category: "environment", title: "t", evidence: "e", fixableInCode: false }] }))!).ok).toBe(false);
    expect(reviewOutcome(parseReviewAssessment(JSON.stringify({ verdict: "needs_changes", findings: [{ severity: "medium", category: "functional", title: "t", evidence: "e", fixableInCode: true }] }))!).ok).toBe(true);
  });
});
