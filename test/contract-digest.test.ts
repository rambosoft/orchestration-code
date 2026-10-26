import { describe, expect, it } from "vitest";
import { buildContractBlock, DEFAULT_CONTRACT_MAX_CHARS, DEFAULT_DRIFT_RULES, digestContract } from "../src/contract-text.js";
import { implementationPrompt, reviewPrompt } from "../src/workflows.js";

const bullets = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `- ${prefix} ${index + 1}: ${"detail ".repeat(22)}`).join("\n");
const contract = [
  "# Project contract: Tile Merge 2048", "", "## Vision", "A calm, polished merge game.", "",
  "## Goals", bullets("Goal", 12), "", "## Non-goals", bullets("Non-goal", 4), "", "## Boundaries", bullets("Boundary", 4), "",
  "## Target users", bullets("User", 6), "", "## Design rules", bullets("Design rule", 10), "", "## Quality bar", bullets("Quality", 5), "",
  "## Open questions", bullets("Question", 6), "", "## Drift rules", bullets("Drift", 5),
].join("\n");
const block = buildContractBlock({ rules: DEFAULT_DRIFT_RULES, contract, file: "docs/PROJECT_CONTRACT.md", maxChars: DEFAULT_CONTRACT_MAX_CHARS });

describe("digestContract", () => {
  const digest = digestContract(block);
  it("keeps the global drift rules whole and the sections that bind a task, and says what it left out", () => {
    for (const rule of DEFAULT_DRIFT_RULES) expect(digest).toContain(rule);
    for (const section of ["## Goals", "## Non-goals", "## Boundaries", "## Quality bar"]) expect(digest).toContain(section);
    expect(digest).toContain("Also in docs/PROJECT_CONTRACT.md, not repeated here:");
    expect(digest).toContain("Target users");
    expect(digest).toContain("Design rules");
    expect(digest).not.toContain("## Target users");
    expect(digest).not.toContain("Question 1");
  });
  it("is much shorter than the block, trims long bullets and caps a section at eight bullets", () => {
    expect(block.length).toBeGreaterThan(4500);
    expect(digest.length).toBeLessThanOrEqual(2400);
    expect(digest.length).toBeLessThan(block.length / 2);
    expect(digest).toContain("Goal 1:");
    expect(digest).not.toContain("Goal 12");
    expect(digest).toContain("...");
  });
  it("returns a short block unchanged, and a block without contract text as it is", () => {
    const small = buildContractBlock({ rules: DEFAULT_DRIFT_RULES, contract: "## Goals\n- one", file: "docs/PROJECT_CONTRACT.md", maxChars: DEFAULT_CONTRACT_MAX_CHARS });
    expect(digestContract(small)).toBe(small);
    expect(digestContract("no marker here".repeat(300))).toBe("no marker here".repeat(300));
    expect(digestContract("")).toBe("");
  });
  it("keeps the first section when the contract has no title heading", () => {
    const untitled = buildContractBlock({ rules: DEFAULT_DRIFT_RULES, contract: ["## Goals", bullets("Goal", 3), "## Open questions", bullets("Q", 40)].join("\n"), file: "docs/PROJECT_CONTRACT.md", maxChars: DEFAULT_CONTRACT_MAX_CHARS });
    expect(digestContract(untitled, 1800)).toContain("## Goals");
  });
});

describe("buildContractBlock with a contract that does not fit", () => {
  it("keeps the sections that bind a task and drops the others by name, instead of cutting whatever comes last", () => {
    expect(block).toContain("## Quality bar");
    expect(block).toContain("## Boundaries");
    expect(block).toContain("Quality 5:");
    expect(block).toMatch(/\[contract sections left out to fit \d+ characters: .*Open questions.*\. Read docs\/PROJECT_CONTRACT\.md for them\.\]/);
    expect(block.length).toBeLessThanOrEqual(DEFAULT_CONTRACT_MAX_CHARS + 200);
  });
  it("still cuts the text, with the old marker, when the binding sections alone do not fit", () => {
    const huge = ["## Goals", bullets("Goal", 200), "## Boundaries", bullets("Boundary", 50)].join("\n");
    const cut = buildContractBlock({ rules: DEFAULT_DRIFT_RULES, contract: huge, file: "docs/PROJECT_CONTRACT.md", maxChars: 3000 });
    expect(cut).toContain("[contract truncated at");
    expect(cut.length).toBeLessThan(3200);
  });
});

describe("where the digest is used", () => {
  it("gives the implement and review prompts the digest and leaves the rules in both", () => {
    const implement = implementationPrompt("BRIEF", undefined, [], "", "", block);
    const review = reviewPrompt("BRIEF", [], 1, false, false, "", "", block);
    for (const prompt of [implement, review]) {
      expect(prompt).toContain("digest of docs/PROJECT_CONTRACT.md");
      expect(prompt).toContain(DEFAULT_DRIFT_RULES[2]!);
      expect(prompt).not.toContain("Question 1");
    }
    expect(review).toContain("Review against the contract");
    expect(implementationPrompt("BRIEF", undefined, [], "", "", block).length).toBeLessThan(implementationPrompt("BRIEF", undefined, [], "", "", "x".repeat(block.length)).length);
  });
  it("adds nothing when there is no contract", () => {
    expect(implementationPrompt("BRIEF", undefined, [])).not.toContain("PROJECT CONTRACT");
  });
});
