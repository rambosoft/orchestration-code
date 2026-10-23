import { describe, expect, it } from "vitest";
import { implementationPrompt, reviewPrompt } from "../src/workflows.js";
import { SIMPLICITY_POLICY, SIMPLICITY_REVIEW_POLICY } from "../src/simplicity.js";

describe("simplicity policy in prompts", () => {
  it("is part of implementation and repair prompts and never replaces the brief", () => {
    const brief = implementationPrompt("BRIEF-TEXT");
    expect(brief).toContain(SIMPLICITY_POLICY);
    expect(brief.indexOf("BRIEF-TEXT")).toBeLessThan(brief.indexOf(SIMPLICITY_POLICY));
    expect(implementationPrompt("BRIEF-TEXT", [{ severity: "high", category: "functional", title: "t", evidence: "e", fixableInCode: true }])).toContain(SIMPLICITY_POLICY);
  });
  it("review treats complexity as low-severity and keeps the JSON contract", () => {
    const prompt = reviewPrompt("check it", [], 1);
    expect(prompt).toContain(SIMPLICITY_REVIEW_POLICY);
    expect(prompt).toContain("Return exactly one JSON object");
  });
  it("states that required validation and security are never cut", () => {
    expect(SIMPLICITY_POLICY).toMatch(/Never remove validation/);
    expect(SIMPLICITY_POLICY).toMatch(/lower priority than the acceptance checks/);
  });
});

import { openSpecRoute } from "../src/workflows.js";
describe("openspec stage routing", () => {
  it("defaults to codex regardless of the project default provider, and honours a manifest route", () => {
    expect(openSpecRoute({})).toEqual({ provider: "codex" });
    expect(openSpecRoute({ providerRouting: { plan: { provider: "claude" } } })).toEqual({ provider: "codex" });
    expect(openSpecRoute({ providerRouting: { openspec: { provider: "claude", model: "m" } } })).toEqual({ provider: "claude", model: "m" });
  });
});
