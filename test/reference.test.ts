import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManifestSchema } from "../src/contracts.js";
import { applyReference, referencePromptBlock, resolveReferenceHostPath } from "../src/reference.js";

describe("reference repository prompts", () => {
  it("formats a short read-only block with forward slash paths and all instructions", () => {
    const block = referencePromptBlock("C:\\projects\\legacy-app", "old app");
    expect(block).toContain("old app at C:/projects/legacy-app");
    expect(block).toContain("Read the OLD files named in this task from there with absolute paths.");
    expect(block).toContain("Never modify, create or delete anything there.");
    expect(block).toContain("If a file cannot be read, say so in docs/migration/findings.md instead of guessing.");
    expect(block.length).toBeLessThan(600);
    expect(block.endsWith("\n\n")).toBe(true);
  });

  it("resolves only paths under ORCHESTRATOR_PROJECTS_ROOT", () => {
    const environment = { ORCHESTRATOR_PROJECTS_ROOT: "C:\\work\\projects" };
    expect(resolveReferenceHostPath({ root: "legacy-app" }, environment)).toBe(path.resolve(environment.ORCHESTRATOR_PROJECTS_ROOT, "legacy-app"));
    expect(resolveReferenceHostPath({ root: "legacy-app" }, {})).toBeUndefined();
    expect(() => resolveReferenceHostPath({ root: "../escape" }, environment)).toThrow(/must stay inside ORCHESTRATOR_PROJECTS_ROOT/);
  });

  it("applies the block once and leaves prompts alone without a reference", () => {
    const environment = { ORCHESTRATOR_PROJECTS_ROOT: "C:\\work\\projects" };
    const prompt = "Type: bug\nLane: fast\nFix the old app";
    const result = applyReference(prompt, { root: "legacy-app", label: "old app" }, environment);
    expect(result.startsWith("REFERENCE REPOSITORY")).toBe(true);
    expect(result.endsWith(prompt)).toBe(true);
    expect(result.match(/REFERENCE REPOSITORY/g)).toHaveLength(1);
    expect(applyReference(prompt, undefined, {})).toBe(prompt);
    expect(() => applyReference(prompt, { root: "legacy-app" }, {}, "migration")).toThrow("project 'migration' declares a reference repository but ORCHESTRATOR_PROJECTS_ROOT is not set");
    expect(() => applyReference("x".repeat(20_000), { root: "legacy-app" }, environment)).toThrow(/20000 character limit/);
  });
});

describe("manifest reference schema", () => {
  const manifest = { id: "sample", name: "Sample", root: "app", defaultProfile: "implementation" };

  it("accepts a reference with a default or supplied label", () => {
    expect(ProjectManifestSchema.parse({ ...manifest, reference: { root: "legacy-app" } }).reference?.label).toBe("reference repository");
    expect(ProjectManifestSchema.parse({ ...manifest, reference: { root: "legacy-app", label: " old app " } }).reference?.label).toBe("old app");
  });

  it("rejects absolute and escaping reference roots", () => {
    expect(ProjectManifestSchema.safeParse({ ...manifest, reference: { root: "C:\\outside" } }).success).toBe(false);
    expect(ProjectManifestSchema.safeParse({ ...manifest, reference: { root: "../outside" } }).success).toBe(false);
  });
});
