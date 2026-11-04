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
  it("leaves a Stages line with any unknown entry, or an empty one, in the prompt as prose (no error)", () => {
    for (const prompt of ["Biomes\nStages: forest, desert, snow", "Stages: implement, deploy", "Stages:", "Stages:   "]) {
      const parsed = parseTaskDirectives(prompt);
      expect(parsed.error, prompt).toBeUndefined(); expect(parsed.stages, prompt).toBeUndefined(); expect(parsed.prompt, prompt).toBe(prompt.trim());
    }
  });
  it("rejects conflicting directive lines; a prose Stages line next to a directive is not a conflict", () => {
    expect(parseTaskDirectives("Stages: implement\nStages: verify").error).toMatch(/conflicting Stages/);
    const mixed = parseTaskDirectives("Stages: forest, snow\nStages: implement, verify");
    expect(mixed.error).toBeUndefined(); expect(mixed.stages).toEqual(["implement", "verify"]); expect(mixed.prompt).toBe("Stages: forest, snow");
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
  it("a code task cannot skip implement or verify, and a brief needs a plan", () => {
    expect(() => admitStages({ project: project({ tier: "production" }), lane: "light", stages: ["plan", "review"], prompt: "x" })).toThrow("a code task cannot skip implement or verify");
    // The manifest schema now rejects such a lanes list itself; admission keeps its own check for a manifest object built without the schema.
    const unchecked = { ...project({ tier: "production" }), lanes: { heavy: ["plan", "implement"] } } as ReturnType<typeof project>;
    expect(() => admitStages({ project: unchecked, lane: "heavy", prompt: "x" })).toThrow("a code task cannot skip implement or verify");
    expect(() => admitStages({ project: project({ tier: "production" }), lane: "light", stages: ["brief", "implement", "verify"], prompt: "x" })).toThrow("a brief needs a plan");
    expect(admitStages({ project: project({ tier: "production" }), lane: "light", stages: ["plan", "brief", "implement", "verify"], prompt: "x" }).stageList).toEqual(["plan", "brief", "implement", "verify"]);
  });
  it("no lane (not a tier code task): no stage list, a Stages line is ignored", () => {
    const out = admitStages({ project: project({ tier: "production" }), stages: ["plan"], prompt: "x" });
    expect(out.stageList).toBeUndefined();
  });
  it("sizing only with a sizing block (opt-in); size and warning for a code task of a tier or sizing project", () => {
    expect(admitStages({ project: project(), codeTask: true, prompt: `edit ${files(20)}` })).toEqual({});
    const tiered = admitStages({ project: project({ tier: "production" }), lane: "standard", codeTask: true, prompt: "nothing named" });
    expect(tiered).not.toHaveProperty("sizing");
    expect(tiered.size?.basis).toBe("unknown");
    expect(tiered.sizeWarning).toBeUndefined();
    const opted = admitStages({ project: project({ sizing: { idleMinutes: 20, largeMinFiles: 7 } }), codeTask: true, prompt: `edit ${files(8)}` });
    expect(opted.sizing).toEqual({ firstEditMinutes: 15, idleMinutes: 20, largeMinFiles: 7 });
    expect(opted.size).toMatchObject({ hint: "large", files: 8 }); expect(opted.sizeWarning).toMatch(/^task names 8 files/);
    // Research, architecture and bug investigation flows are not code tasks: no estimate and no warning; the sizing block still opts the run in.
    for (const extra of [{ tier: "production" }, {}]) expect(admitStages({ project: project(extra), codeTask: false, prompt: `edit ${files(20)}` })).toEqual({});
    expect(admitStages({ project: project({ tier: "production", sizing: {} }), codeTask: false, prompt: `edit ${files(20)}` })).toEqual({ sizing: { firstEditMinutes: 15, idleMinutes: 10, largeMinFiles: 10 } });
  });
  it("a task naming 14 files on production is admitted with a warning", () => {
    const out = admitStages({ project: project({ tier: "production" }), lane: "standard", codeTask: true, prompt: `change ${files(14)}` });
    expect(out.size).toMatchObject({ hint: "large", files: 14, areas: 1, basis: "text" });
    expect(out.sizeWarning).toBe("task names 14 files in 1 areas; limit is 10 files / 2 areas");
  });
});
