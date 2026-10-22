import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deltaProblems, findDeltaProblems, parseDelta } from "../src/openspec-delta.js";

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
