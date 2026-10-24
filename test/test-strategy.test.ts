import { describe, expect, it } from "vitest";
import { affectedTestHints, testStrategy } from "../src/test-strategy.js";
import { implementationPrompt } from "../src/workflows.js";

describe("test strategy", () => {
  it("tells every implementation to run only the affected tests while working and the full suite once at the end", () => {
    const text = testStrategy([{ executable: "npm", args: ["test"] }]);
    expect(text).toContain("run only the tests your change can affect");
    expect(text).toContain("Do not run the whole suite after every edit");
    expect(text).toContain("once, at the end");
  });
  it("names the way to select affected tests for each kind of project", () => {
    expect(affectedTestHints([{ executable: "unity", args: ["test", "--mode", "EditMode"] }]).join(" ")).toContain("--affected --since HEAD");
    expect(affectedTestHints([{ executable: "npm", args: ["test"] }]).join(" ")).toContain("--changed");
    const both = affectedTestHints([{ executable: "node", args: ["scripts/check-unity-hygiene.mjs"] }, { executable: "unity", args: ["test"] }, { executable: "npm", args: ["run", "test"] }]);
    expect(both).toHaveLength(2);
    expect(affectedTestHints([{ executable: "python", args: ["-m", "pytest"] }] as never)[0]).toContain("file or name filter");
    expect(affectedTestHints([])[0]).toContain("file or name filter");
  });
  it("is part of the implementation prompt for a first pass and a repair, with or without configured checks", () => {
    const checks = [{ executable: "unity" as const, args: ["test"] }];
    expect(implementationPrompt("Task", undefined, checks)).toContain("TEST STRATEGY");
    expect(implementationPrompt("Task", undefined, checks)).toContain("unity test --mode PlayMode --filter");
    expect(implementationPrompt("Task", [{ severity: "high", category: "tests", title: "t", evidence: "e", fixableInCode: true }])).toContain("TEST STRATEGY");
    expect(implementationPrompt("Task")).toContain("TEST STRATEGY");
  });
});
