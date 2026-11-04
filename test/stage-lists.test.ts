import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProjectManifestSchema } from "../src/contracts.js";
import { parseTaskDirectives } from "../src/openspec-policy.js";
import { admitStages } from "../src/stage-admission.js";

const base = JSON.parse(readFileSync("project.example.json", "utf8"));
const project = (extra: Record<string, unknown> = {}) => ProjectManifestSchema.parse({ ...base, ...extra });
const files = (n: number, dir = "src/a") => Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`).join(" ");

describe("Stages directive", () => {
  it("parses a case-insensitive comma list and removes the line", () => {
    const parsed = parseTaskDirectives("Do it\nStages: Implement, review ,VERIFY\nmore");
    expect(parsed.stages).toEqual(["implement", "review", "verify"]);
    expect(parsed.prompt).toBe("Do it\nmore");
    expect(parsed.error).toBeUndefined();
  });
  it("rejects unknown stage names and conflicting lines", () => {
    expect(parseTaskDirectives("Stages: implement, deploy").error).toMatch(/deploy/);
    expect(parseTaskDirectives("Stages: implement\nStages: verify").error).toMatch(/conflicting Stages/);
    expect(parseTaskDirectives("no directive").stages).toBeUndefined();
  });
});

describe("admitStages", () => {
  it("task Stages line wins and carries its reason", () => {
    const out = admitStages({ project: project({ tier: "production", lanes: { light: ["implement", "verify"] } }), lane: "light", stages: ["implement", "review", "verify"], prompt: "x" });
    expect(out.stageList).toEqual(["implement", "review", "verify"]);
    expect(out.stageListReason).toBe("task Stages line");
  });
  it("manifest lanes list applies when the task names no stages", () => {
    const out = admitStages({ project: project({ tier: "production", lanes: { light: ["implement", "review", "verify"] } }), lane: "light", prompt: "x" });
    expect(out.stageList).toEqual(["implement", "review", "verify"]);
    expect(out.stageListReason).toBe("manifest lanes.light");
  });
  it("neither source: no stage list fields", () => {
    const out = admitStages({ project: project({ tier: "production" }), lane: "light", prompt: "x" });
    expect(out.stageList).toBeUndefined();
    expect(out.stageListReason).toBeUndefined();
  });
  it("a code task cannot skip implement or verify", () => {
    expect(() => admitStages({ project: project({ tier: "production" }), lane: "light", stages: ["plan", "review"], prompt: "x" })).toThrow("a code task cannot skip implement or verify");
    expect(() => admitStages({ project: project({ tier: "production", lanes: { heavy: ["plan", "implement"] } }), lane: "heavy", prompt: "x" })).toThrow("a code task cannot skip implement or verify");
  });
  it("no lane (not a tier code task): no stage list, a Stages line is ignored", () => {
    const out = admitStages({ project: project({ tier: "production" }), stages: ["plan"], prompt: "x" });
    expect(out.stageList).toBeUndefined();
  });
  it("sizing and size are set only for a tier or a sizing block", () => {
    expect(admitStages({ project: project(), lane: undefined, prompt: `edit ${files(20)}` })).toEqual({});
    const tiered = admitStages({ project: project({ tier: "production" }), lane: "standard", prompt: "nothing named" });
    expect(tiered.sizing).toEqual({ firstEditMinutes: 15, idleMinutes: 10, largeMinFiles: 10 });
    expect(tiered.size?.basis).toBe("unknown");
    expect(tiered.sizeWarning).toBeUndefined();
    expect(admitStages({ project: project({ sizing: { idleMinutes: 20, largeMinFiles: 7 } }), prompt: "x" }).sizing).toEqual({ firstEditMinutes: 15, idleMinutes: 20, largeMinFiles: 7 });
  });
  it("a task naming 14 files on production is admitted with a warning", () => {
    const out = admitStages({ project: project({ tier: "production" }), lane: "standard", prompt: `change ${files(14)}` });
    expect(out.size).toMatchObject({ hint: "large", files: 14, areas: 1, basis: "text" });
    expect(out.sizeWarning).toBe("task names 14 files in 1 areas; limit is 10 files / 2 areas");
  });
});
