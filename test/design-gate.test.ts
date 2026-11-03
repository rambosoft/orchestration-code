// The design gate for critical areas (B-159): the document format, the approval rules, admission of a critical task, and the protected constraints reaching the prompts.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { admitDesign, designConstraintsBlock, designProblems, isDesignPath, parseDesign } from "../src/design-gate.js";
import { parseTaskDirectives } from "../src/openspec-policy.js";

const doc = (over: { status?: string; area?: string; author?: string; open?: string; review?: string; constraints?: string; skip?: string } = {}): string => {
  const sections: Record<string, string> = {
    "Purpose": "Store the catalogue so a TV with little memory can page it.",
    "Protected constraints": over.constraints ?? "- D-001 Catalogue data is stored in IndexedDB only through the storage interface.\n- D-002 Every cache has a stated size limit and an eviction rule.",
    "Interfaces": "Storage: get(key), put(batch), evict(policy). Errors are typed.",
    "Failure modes": "Quota exceeded: evict, then surface a typed error.",
    "Test plan": "Table-driven tests for eviction; a leak test over repeated navigation.",
    "Open questions": over.open ?? "none",
    "Review record": over.review ?? "- claude 2026-11-03 approved: comprehension, structure and readiness checked from a fresh context.",
  };
  return [`# Design: storage`, `Status: ${over.status ?? "approved"}`, `Area: ${over.area ?? "storage"}`, `Author: ${over.author ?? "codex"}`, "", ...Object.entries(sections).filter(([name]) => name !== over.skip).flatMap(([name, body]) => [`## ${name}`, body, ""])].join("\n");
};

describe("designProblems", () => {
  it("accepts a complete approved design and a complete draft", () => {
    expect(designProblems(doc(), { requireApproved: true })).toEqual([]);
    expect(designProblems(doc({ status: "draft", review: "- claude 2026-11-03 changes: not ready" }))).toEqual([]);
  });
  it.each([
    ["a missing section", doc({ skip: "Failure modes" }), "the section '## Failure modes' is missing"],
    ["an empty section", doc().replace("Table-driven tests for eviction; a leak test over repeated navigation.", ""), "the section '## Test plan' is empty"],
    ["no constraint line", doc({ constraints: "Be careful." }), "needs at least one '- D-001"],
    ["a repeated constraint id", doc({ constraints: "- D-001 One.\n- D-001 Two." }), "constraint ids must be unique"],
    ["no status", doc().replace("Status: approved\n", ""), "a 'Status: draft' or 'Status: approved' line is required"],
    ["a bad area", doc({ area: "Storage Layer" }), "an 'Area: <slug>' line is required"],
    ["no author", doc().replace("Author: codex\n", ""), "an 'Author:"],
    ["open questions", doc({ open: "Which quota?" }), "'## Open questions' must say 'none'"],
    ["a review by the author", doc({ review: "- codex 2026-11-03 approved: looks fine" }), "other than its author"],
    ["no review", doc({ review: "no reviews yet" }), "needs a review record from a reviewer other than its author"],
    ["a later request for changes", doc({ review: "- claude 2026-11-03 approved: ok\n- claude 2026-11-04 changes: the eviction rule is vague" }), "the latest review asked for changes"],
  ])("rejects %s", (_name, text, expected) => { expect(designProblems(text, { requireApproved: true }).join(" | ")).toContain(expected); });
  it("requires the approved form when asked even if the document says draft", () => {
    expect(designProblems(doc({ status: "draft" }), { requireApproved: true })).toContain("the design is not approved (Status is not 'approved')");
  });
  it("reads CRLF documents and a title that is not a design", () => {
    expect(designProblems(doc().replace(/\n/g, "\r\n"), { requireApproved: true })).toEqual([]);
    expect(designProblems(doc().replace("# Design: storage", "# Storage notes"))).toContain("the title must start with 'Design'");
  });
});

describe("parseDesign and the constraints block", () => {
  it("reads fields, constraints and reviews", () => {
    const design = parseDesign(doc());
    expect(design).toMatchObject({ status: "approved", area: "storage", author: "codex" });
    expect(design.constraints.map(constraint => constraint.id)).toEqual(["D-001", "D-002"]);
    expect(design.reviews).toEqual([{ reviewer: "claude", date: "2026-11-03", verdict: "approved", note: "comprehension, structure and readiness checked from a fresh context." }]);
  });
  it("carries the protected constraints and the interfaces, marks them protected, and stays within the limit", () => {
    const block = designConstraintsBlock("docs/design/storage.md", doc());
    expect(block).toContain("APPROVED DESIGN (docs/design/storage.md, area storage");
    expect(block).toContain("never change or weaken them");
    expect(block).toContain("- D-002 Every cache has a stated size limit and an eviction rule.");
    expect(block).toContain("Storage: get(key), put(batch), evict(policy).");
    const long = doc({ constraints: Array.from({ length: 200 }, (_value, index) => `- D-${String(index + 1).padStart(3, "0")} ${"x".repeat(80)}`).join("\n") });
    expect(designConstraintsBlock("docs/design/storage.md", long, 1_000).length).toBeLessThanOrEqual(1_000);
  });
});

describe("isDesignPath", () => {
  it.each([["docs/design/storage.md", true], ["docs/design/sub/input.md", true], ["docs/design/_TEMPLATE.md", false], ["docs/other/storage.md", false], ["docs/design/../secret.md", false], ["/docs/design/storage.md", false], ["docs/design/storage.txt", false], ["docs/design/storage.md/..", false], ["docs/designer/storage.md", false]])("%s is %s", (file, expected) => { expect(isDesignPath(file, "docs/design")).toBe(expected); });
});

describe("the Design directive", () => {
  it("is read from the task text and removed from the prompt", () => {
    expect(parseTaskDirectives("Build the cache.\nCritical: yes\nDesign: docs/design/storage.md\n")).toMatchObject({ prompt: "Build the cache.", critical: true, design: "docs/design/storage.md" });
    expect(parseTaskDirectives("Build a page.").design).toBeUndefined();
  });
  it("rejects two different designs", () => {
    expect(parseTaskDirectives("x\nDesign: docs/design/a.md\nDesign: docs/design/b.md").error).toContain("conflicting Design");
  });
});

describe("admitDesign", () => {
  const gate = { enabled: true, dir: "docs/design", areas: ["input"], maxChars: 3_500 };
  const base = { taskId: "LUX-9", baseSha: "a".repeat(40), targetBranch: "main" };
  const reading = (files: Record<string, string>) => async (file: string) => files[file];
  it("lets an ordinary task start without looking at designs", async () => {
    expect(await admitDesign({ ...base, task: {}, gate, read: async () => { throw new Error("must not read"); } })).toBeUndefined();
    expect(await admitDesign({ ...base, task: { critical: true }, gate: undefined, read: reading({}) })).toBeUndefined();
    expect(await admitDesign({ ...base, task: { critical: true }, gate: { ...gate, enabled: false }, read: reading({}) })).toBeUndefined();
  });
  it("refuses a critical task that names no design, and a task in a listed area", async () => {
    await expect(admitDesign({ ...base, task: { critical: true }, gate, read: reading({}) })).rejects.toThrow("is critical and needs an approved design");
    await expect(admitDesign({ ...base, task: { area: "input" }, gate, read: reading({}) })).rejects.toThrow("needs an approved design");
  });
  it("refuses a design that is missing, not under the folder, a draft, or for another area", async () => {
    await expect(admitDesign({ ...base, task: { critical: true, design: "docs/design/storage.md" }, gate, read: reading({}) })).rejects.toThrow("does not exist at the base of this task");
    await expect(admitDesign({ ...base, task: { critical: true, design: "README.md" }, gate, read: reading({}) })).rejects.toThrow("not a markdown design document under docs/design/");
    await expect(admitDesign({ ...base, task: { critical: true, design: "docs/design/storage.md" }, gate, read: reading({ "docs/design/storage.md": doc({ status: "draft" }) }) })).rejects.toThrow("not an approved design");
    await expect(admitDesign({ ...base, task: { critical: true, area: "input", design: "docs/design/storage.md" }, gate, read: reading({ "docs/design/storage.md": doc() }) })).rejects.toThrow("is for area 'storage', but the task is in area 'input'");
  });
  it("returns the constraints block of an approved design for a critical task, and for any task that names one", async () => {
    const read = reading({ "docs/design/storage.md": doc() });
    expect(await admitDesign({ ...base, task: { critical: true, area: "storage", design: "docs/design/storage.md" }, gate, read })).toContain("D-001 Catalogue data is stored in IndexedDB");
    expect(await admitDesign({ ...base, task: { design: "docs/design/storage.md" }, gate: undefined, read })).toContain("APPROVED DESIGN");
  });
});
