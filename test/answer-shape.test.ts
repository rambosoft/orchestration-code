import { describe, expect, it } from "vitest";
import { ANSWER_SHAPE } from "../src/answer-shape.js";
import { analysisPrompt } from "../src/analysis.js";
import { diagnosePrompt, reproducePrompt } from "../src/bug.js";
import { explorePrompt, scopePrompt } from "../src/research.js";

describe("answer shape of the structured stages", () => {
  const scope = { restated: "How requests are routed", questions: ["How are requests routed?"], out_of_scope: [], search_terms: [], paths_of_interest: [] };
  const prompts = {
    analysis: analysisPrompt("goal", ""),
    diagnose: diagnosePrompt("Users see English after choosing German"),
    reproduce: reproducePrompt("Users see English after choosing German"),
    scope: scopePrompt("How are requests routed?", "research"),
    explore: explorePrompt("How are requests routed?", scope, "PACK", "research"),
  };
  it("asks every one of them for short, grounded strings and honest unknowns, without limiting the size of the answer", () => {
    for (const [stage, prompt] of Object.entries(prompts)) {
      expect(prompt, stage).toContain(ANSWER_SHAPE);
      expect(prompt, stage).not.toContain("${ANSWER_SHAPE}");
      expect(prompt, stage).toMatch(/Keep (the whole answer|it) under \d+ tokens/);
    }
    expect(ANSWER_SHAPE).toContain("path:line");
    expect(ANSWER_SHAPE).toContain("unknown");
    expect(ANSWER_SHAPE.length).toBeLessThan(400);
  });
  it("puts the rule before the output format so the format instruction stays last", () => {
    for (const [stage, prompt] of Object.entries(prompts)) expect(prompt.indexOf(ANSWER_SHAPE), stage).toBeLessThan(prompt.indexOf("Return only one JSON object"));
  });
});
