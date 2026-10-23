import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deltaProblems, findDeltaProblems, normalizeDelta, parseDelta, repairDeltaFiles } from "../src/openspec-delta.js";

const main = "# Spec\n\n## Requirements\n\n### Requirement: Jump\nThe dino SHALL jump.\n\n#### Scenario: Jump\n- **WHEN** space\n\n### Requirement: Score\nScore SHALL grow.\n";
const delta = "## ADDED Requirements\n\n### Requirement: Pause\nIt SHALL pause.\n\n## MODIFIED Requirements\n\n### Requirement: Score\nScore SHALL grow and show.\n\n## REMOVED Requirements\n\n### Requirement: Jump\n\n## RENAMED Requirements\n- FROM: `### Requirement: Old`\n- TO: `### Requirement: New`\n";

describe("OpenSpec delta checks", () => {
  it("parses requirement names per operation", () => {
    expect(parseDelta(delta)).toEqual({ added: ["Pause"], modified: ["Score"], removed: ["Jump"], renamedFrom: ["Old"] });
  });
  it("ignores a plain '## Requirements' section (not a delta operation)", () => {
    expect(parseDelta(main)).toEqual({ added: [], modified: [], removed: [], renamedFrom: [] });
  });
  it("flags MODIFIED/REMOVED/RENAMED of unknown requirements and ADDED duplicates", () => {
    const problems = deltaProblems("dino", { added: ["Jump"], modified: ["Ghost"], removed: ["Nope"], renamedFrom: ["Old"] }, main).join("\n");
    expect(problems).toContain('MODIFIED requirement "Ghost"');
    expect(problems).toContain('REMOVED requirement "Nope"');
    expect(problems).toContain('RENAMED FROM requirement "Old"');
    expect(problems).toContain('ADDED requirement "Jump" already exists');
  });
  it("accepts a consistent delta and treats a missing main spec as 'everything must be ADDED'", () => {
    expect(deltaProblems("dino", { added: ["Pause"], modified: ["Score"], removed: ["Jump"], renamedFrom: [] }, main)).toEqual([]);
    expect(deltaProblems("dino", { added: ["A"], modified: [], removed: [], renamedFrom: [] }, undefined)).toEqual([]);
    expect(deltaProblems("dino", { added: [], modified: ["A"], removed: [], renamedFrom: [] }, undefined).join()).toContain("no main spec yet");
  });
});

describe("findDeltaProblems on disk", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  it("reads the main spec of the capability and reports a stale MODIFIED header (regression: dino-runner task 2)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-delta-")); roots.push(root);
    await mkdir(path.join(root, "openspec", "specs", "dino-runner"), { recursive: true });
    await mkdir(path.join(root, "openspec", "changes", "c1", "specs", "dino-runner"), { recursive: true });
    await writeFile(path.join(root, "openspec", "specs", "dino-runner", "spec.md"), main);
    await writeFile(path.join(root, "openspec", "changes", "c1", "specs", "dino-runner", "spec.md"), "## MODIFIED Requirements\n\n### Requirement: Runner scene displays a live distance score\nx\n");
    const problems = await findDeltaProblems(root, "c1", ["openspec/changes/c1/specs/dino-runner/spec.md"]);
    expect(problems.join()).toContain("Runner scene displays a live distance score");
  });
});

// Regression (LOC-40): the model wrote MODIFIED for a requirement that is new, and the single repair pass did not fix it, so the run died at OpenSpec.
describe("mechanical delta correction", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  const req = (name: string) => `### Requirement: ${name}\nThe system SHALL ${name.toLowerCase()}.\n\n#### Scenario: ${name}\n- **WHEN** it happens\n- **THEN** it works\n`;
  it("moves a MODIFIED requirement that does not exist to ADDED and records a note", () => {
    const input = `## MODIFIED Requirements\n\n${req("Obstacles are configurable pixel-art components")}\n${req("Score")}`;
    const fixed = normalizeDelta(input, main);
    expect(fixed.notes).toEqual(['MODIFIED requirement "Obstacles are configurable pixel-art components" does not exist in the main spec; moved to ADDED']);
    const ops = parseDelta(fixed.markdown);
    expect(ops.added).toEqual(["Obstacles are configurable pixel-art components"]);
    expect(ops.modified).toEqual(["Score"]);
    expect(deltaProblems("dino", ops, main)).toEqual([]);
    expect(fixed.markdown).toContain("#### Scenario: Obstacles are configurable pixel-art components");
  });
  it("moves an ADDED requirement that already exists to MODIFIED and drops a REMOVED one that does not exist", () => {
    const input = `## ADDED Requirements\n\n${req("Jump")}\n## REMOVED Requirements\n\n### Requirement: Ghost\n**Reason**: gone\n`;
    const fixed = normalizeDelta(input, main);
    expect(parseDelta(fixed.markdown)).toEqual({ added: [], modified: ["Jump"], removed: [], renamedFrom: [] });
    expect(fixed.notes).toHaveLength(2);
    expect(fixed.markdown).not.toContain("Ghost");
  });
  it("treats every requirement as new when the capability has no main spec yet", () => {
    const fixed = normalizeDelta(`## MODIFIED Requirements\n\n${req("Pause")}`, undefined);
    expect(parseDelta(fixed.markdown).added).toEqual(["Pause"]);
  });
  it("leaves a consistent delta byte for byte untouched", () => {
    expect(normalizeDelta(delta, main)).toEqual({ markdown: delta, notes: [] });
  });
  it("is idempotent and keeps the requirement text intact", () => {
    const once = normalizeDelta(`## MODIFIED Requirements\n\n${req("Pause")}`, main);
    expect(normalizeDelta(once.markdown, main)).toEqual({ markdown: once.markdown, notes: [] });
    expect(once.markdown).toContain("The system SHALL pause.");
  });
  it("rewrites the delta file on disk so that the later archive step sees a consistent change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-delta-fix-")); roots.push(root);
    await mkdir(path.join(root, "openspec", "specs", "dino-runner"), { recursive: true });
    await mkdir(path.join(root, "openspec", "changes", "c1", "specs", "dino-runner"), { recursive: true });
    await writeFile(path.join(root, "openspec", "specs", "dino-runner", "spec.md"), main);
    const file = "openspec/changes/c1/specs/dino-runner/spec.md";
    await writeFile(path.join(root, ...file.split("/")), `## MODIFIED Requirements\n\n${req("Pause")}`);
    expect(await findDeltaProblems(root, "c1", [file])).not.toEqual([]);
    const notes = await repairDeltaFiles(root, "c1", [file]);
    expect(notes.join()).toContain("corrected automatically");
    expect(await findDeltaProblems(root, "c1", [file])).toEqual([]);
    expect(await repairDeltaFiles(root, "c1", [file])).toEqual([]);
  });
});
