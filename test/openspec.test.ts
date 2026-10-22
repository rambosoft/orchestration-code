import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveOpenSpec, makeOpenSpecChangeId, OPEN_SPEC_VERSION, parseOpenSpecTaskPrompt, prepareOpenSpec, resolveOpenSpecEnabled, validateOpenSpec } from "../src/openspec.js";
import { openSpecContextPrompt, plannedTaskPrompt } from "../src/workflows.js";
import { shouldRunOpenSpec } from "../src/openspec.js";
import { openSpecProposalPrompt } from "../src/openspec-policy.js";

describe("OpenSpec task policy and prompts", () => {
  it("defaults project configuration on and lets an explicit task setting win", async () => {
    const { ProjectManifestSchema } = await import("../src/contracts.js");
    const base = { id: "demo-typescript", name: "Demo", root: ".", defaultProfile: "implementation" };
    expect(ProjectManifestSchema.parse(base).openSpec.enabled).toBe(true);
    expect(ProjectManifestSchema.parse({ ...base, openSpec: { enabled: false } }).openSpec.enabled).toBe(false);
    expect(resolveOpenSpecEnabled(true)).toBe(true);
    expect(resolveOpenSpecEnabled(false)).toBe(false);
    expect(resolveOpenSpecEnabled(false, true)).toBe(true);
    expect(resolveOpenSpecEnabled(true, false)).toBe(false);
    expect(shouldRunOpenSpec(true, ["plan", "implement", "review", "verify"])).toBe(true);
    expect(shouldRunOpenSpec(true, ["research", "verify"])).toBe(false);
  });

  it("strips the explicit task directive and rejects contradictory directives", () => {
    expect(parseOpenSpecTaskPrompt("Add a percentage button.\n\nOpenSpec: off")).toEqual({ prompt: "Add a percentage button.", override: false });
    expect(parseOpenSpecTaskPrompt("OpenSpec: ON\nAdd a button.")).toEqual({ prompt: "Add a button.", override: true });
    expect(parseOpenSpecTaskPrompt("OpenSpec: on\nOpenSpec: off").error).toContain("conflicting");
  });

  it("tells the unattended proposal stage to populate its scaffold and resolve ambiguity conservatively", () => {
    const prompt = openSpecProposalPrompt({ taskPrompt: "Add a percentage button.", changeId: "task-percent-1" });
    expect(prompt).toContain("created this change as an empty scaffold");
    expect(prompt).toContain("do not ask the user follow-up questions");
    expect(prompt).toContain("smallest useful scope consistent with repository evidence");
    expect(prompt).toContain("add acceptance coverage rather than claiming the implementation is missing");
  });

  it("keeps validated OpenSpec requirements and planner output in implementation context", () => {
    const withSpecs = openSpecContextPrompt("Add a percentage button.", "Requirement: percent applies to current operand");
    const withPlan = plannedTaskPrompt(withSpecs, "Implementation: follow existing calculator conventions");
    expect(withPlan).toContain("Requirement: percent applies to current operand");
    expect(withPlan).toContain("$openspec-apply-change");
    expect(withPlan).toContain("Implementation: follow existing calculator conventions");
  });

});

describe("pinned OpenSpec CLI lifecycle", () => {
  it("creates, validates, and archives a completed change while preserving its main spec", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-openspec-"));
    try {
      const prepared = await prepareOpenSpec({ taskId: "PERCENT-1", runId: "run-12345678", prompt: "Add a percentage button.", projectRoot: root, artifactsDir: path.join(root, "artifacts") });
      expect(prepared.version).toBe(OPEN_SPEC_VERSION);
      expect(prepared.changeId).toBe(makeOpenSpecChangeId("PERCENT-1", "run-12345678"));

      const changeRoot = path.join(root, "openspec", "changes", prepared.changeId);
      await writeFile(path.join(changeRoot, "proposal.md"), `# Proposal\n\n## Why\nA percentage button is missing.\n\n## What Changes\n- Add percentage behavior for the current operand.\n\n## Capabilities\n\n### New Capabilities\n- \`percentage-calculation\`: Apply a percentage to the current operand.\n\n### Modified Capabilities\n\n## Impact\n- Calculator controls and arithmetic behavior.\n`, "utf8");
      await mkdir(path.join(changeRoot, "specs", "percentage-calculation"), { recursive: true });
      await writeFile(path.join(changeRoot, "specs", "percentage-calculation", "spec.md"), `# Percentage calculation\n\n## Purpose\nSpecify the calculator behavior for applying a percentage to the current operand.\n\n## ADDED Requirements\n### Requirement: Apply a percentage to the current operand\nThe calculator MUST apply percentage semantics to the current operand.\n\n#### Scenario: Convert the current operand\n- **WHEN** the user activates the percentage button\n- **THEN** the current operand is converted using the calculator's existing percentage semantics\n`, "utf8");
      await writeFile(path.join(changeRoot, "design.md"), `# Design\n\n## Context\nKeep the new control consistent with the existing calculator.\n`, "utf8");
      await writeFile(path.join(changeRoot, "tasks.md"), `## 1. Percentage button\n- [ ] 1.1 Add the button and preserve existing keyboard behavior\n`, "utf8");

      const validated = await validateOpenSpec({ changeId: prepared.changeId, projectRoot: root, artifactsDir: path.join(root, "artifacts") });
      expect(validated.version).toBe(OPEN_SPEC_VERSION);
      expect(validated.context).toContain("The calculator MUST apply percentage semantics");
      expect(validated.context).toContain("proposal.md");
      await expect(archiveOpenSpec({ changeId: prepared.changeId, projectRoot: root, artifactsDir: path.join(root, "artifacts") })).rejects.toThrow("task checklist");

      await writeFile(path.join(changeRoot, "tasks.md"), `## 1. Percentage button\n- [x] 1.1 Add the button and preserve existing keyboard behavior\n`, "utf8");
      const archived = await archiveOpenSpec({ changeId: prepared.changeId, projectRoot: root, artifactsDir: path.join(root, "artifacts") });
      expect(archived.archivedPath).toContain(prepared.changeId);
      const mainSpec = await readFile(path.join(root, "openspec", "specs", "percentage-calculation", "spec.md"), "utf8");
      expect(mainSpec).toContain("Apply a percentage to the current operand");
      expect(await readFile(archived.artifactRef, "utf8")).toContain("archivedPath");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects an incomplete proposal before it can reach the planner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-openspec-incomplete-"));
    try {
      const prepared = await prepareOpenSpec({ taskId: "PERCENT-2", runId: "run-incomplete", prompt: "Add a percentage button.", projectRoot: root, artifactsDir: path.join(root, "artifacts") });
      await expect(validateOpenSpec({ changeId: prepared.changeId, projectRoot: root, artifactsDir: path.join(root, "artifacts") })).rejects.toThrow("incomplete");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("fails closed when the worker CLI is not at the pinned version", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => { calls.push(args); return { stdout: "1.14.2", stderr: "" }; };
    await expect(prepareOpenSpec({ taskId: "PERCENT-3", runId: "run-old-cli", prompt: "Add a percentage button.", projectRoot: os.tmpdir(), artifactsDir: os.tmpdir() }, runner)).rejects.toThrow("requires 1.14.3, found 1.14.2");
    expect(calls).toEqual([["--version"]]);
  });
});

describe("archive when the implementing agent already archived the change", () => {
  it("recognises the date-prefixed archive entry and skips status/archive commands", async () => {
    const calls: string[] = [];
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-archived-"));
    try {
      const result = await archiveOpenSpec({ changeId: "task-dino-1-abc", projectRoot: root, artifactsDir: path.join(root, "artifacts") }, async (args) => {
        calls.push(args[0]!);
        if (args[0] === "list") return { stdout: JSON.stringify({ changes: [{ name: "2026-10-22-task-dino-1-abc", status: "complete", archived: true }] }), stderr: "" };
        return { stdout: "{}", stderr: "" };
      });
      expect(result.archivedPath).toContain("2026-10-22-task-dino-1-abc");
      expect(calls).toEqual(["list", "validate"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
