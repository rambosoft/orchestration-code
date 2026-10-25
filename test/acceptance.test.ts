import { describe, expect, it } from "vitest";
import { acceptanceIds, acceptanceProblem, traceAcceptance } from "../src/acceptance.js";
import { buildIssuePlan, gameAcceptance, validateBlueprint } from "../src/bootstrap.js";
import { PLAN_LIMITS, resolveOptions } from "../src/bootstrap-options.js";

const prompt = (ids: string[]) => `Build it.\n\nTask id: T3\n\nAcceptance criteria:\n${ids.map(id => `- ${id}: something observable`).join("\n")}\n\nProof is required.`;

describe("acceptance ids", () => {
  it("reads the numbered criteria of a task description and nothing else", () => {
    expect(acceptanceIds(prompt(["T3-AC1", "T3-AC2", "T3-AC2"]))).toEqual(["T3-AC1", "T3-AC2"]);
    expect(acceptanceIds("Acceptance criteria:\n- plain item\n- another")).toEqual([]);
    expect(acceptanceIds("Mentions T3-AC9 in prose only")).toEqual([]);
  });
});

describe("acceptance trace", () => {
  const tests = (...lines: string[]) => [lines.map(line => `        // ${line}`).join("\n")];
  it("passes when every criterion has a test that says Covers, in any list form", () => {
    expect(acceptanceProblem(prompt(["T3-AC1", "T3-AC2", "T3-AC3"]), tests("Covers: T3-AC1", "Covers: T3-AC2, T3-AC3"))).toBeUndefined();
    expect(acceptanceProblem(prompt(["T3-AC1"]), tests("covers: T3-AC1"))).toBeUndefined();
  });
  it("names every criterion without a test and tells the agent what to write", () => {
    const problem = acceptanceProblem(prompt(["T3-AC1", "T3-AC2", "T3-AC3"]), tests("Covers: T3-AC2"))!;
    expect(problem).toContain("T3-AC1, T3-AC3");
    expect(problem).toContain('"Covers: T3-AC1"');
    expect(problem).toContain("never delete or weaken a criterion");
  });
  it("does not accept a mention that is not a Covers line, or a criterion of another task", () => {
    expect(acceptanceProblem(prompt(["T3-AC1"]), tests("see T3-AC1 for details"))).toContain("T3-AC1");
    expect(acceptanceProblem(prompt(["T3-AC1"]), tests("Covers: T4-AC1"))).toContain("T3-AC1");
    expect(acceptanceProblem(prompt(["T3-AC1"]), [])).toContain("T3-AC1");
  });
  it("accepts an open deferral to a later task and reports it, but not a deferral without a target", () => {
    const trace = traceAcceptance(["T3-AC1", "T3-AC4"], tests("Covers: T3-AC1", "Deferred: T3-AC4 -> T8 gameplay screen does not exist yet"));
    expect(trace.missing).toEqual([]);
    expect(trace.deferred).toEqual([{ id: "T3-AC4", to: "T8" }]);
    expect(acceptanceProblem(prompt(["T3-AC1", "T3-AC4"]), tests("Covers: T3-AC1", "Deferred: T3-AC4 because hard"))).toContain("T3-AC4");
  });
  it("is off for a task without numbered criteria", () => {
    expect(acceptanceProblem("Acceptance criteria:\n- plain", [])).toBeUndefined();
  });
});

describe("game task descriptions", () => {
  const task = { title: "Build the board view", description: "Render the 4x4 board.", acceptance: ["The board shows 16 cells", "Tiles show their values"] };
  it("numbers the criteria with the task id and states the proof convention", () => {
    const text = gameAcceptance(task, 8);
    expect(text).toContain("Task id: T8");
    expect(text).toContain("- T8-AC1: The board shows 16 cells");
    expect(text).toContain("- T8-AC2: Tiles show their values");
    expect(text).toContain('"Covers: T8-AC1"');
    expect(text).toContain('"Deferred: T8-ACn -> T<later task> reason"');
  });
  it("adds a standing capture criterion to a task that builds a screen, and not to one that does not", () => {
    expect(acceptanceIds(gameAcceptance(task, 8))).toEqual(["T8-AC1", "T8-AC2", "T8-AC3"]);
    expect(gameAcceptance(task, 8)).toContain("PlayMode capture test");
    const logic = { title: "Implement merge rules", description: "Pure C# rules.", acceptance: ["Equal tiles merge once per move"] };
    expect(acceptanceIds(gameAcceptance(logic, 5))).toEqual(["T5-AC1"]);
  });
  it("numbers tasks across the whole plan in order for a game, and leaves an application untouched", () => {
    const blueprint = validateBlueprint(JSON.stringify({ summary: "s", milestones: [
      { key: "M1", title: "Core", goal: "g", tasks: [{ key: "A", title: "Rules", description: "d", acceptance: ["ok"], depends_on: [] }, { key: "B", title: "Board screen", description: "d", acceptance: ["ok"], depends_on: ["A"] }] },
      { key: "M2", title: "More", goal: "g", tasks: [{ key: "C", title: "Stats", description: "d", acceptance: ["ok"], depends_on: ["B"] }] },
    ] }), PLAN_LIMITS.normal!);
    const game = buildIssuePlan(blueprint, resolveOptions({ product_kind: "game" }).values, true).filter(issue => issue.kind === "task");
    expect(game.map(issue => acceptanceIds(issue.description)[0])).toEqual(["T1-AC1", "T2-AC1", "T3-AC1"]);
    const app = buildIssuePlan(blueprint, resolveOptions({}).values, true).filter(issue => issue.kind === "task");
    expect(app.every(issue => acceptanceIds(issue.description).length === 0)).toBe(true);
    expect(app[0]!.description).toContain("Acceptance criteria:\n- ok");
  });
});

describe("waiving a criterion", () => {
  const text = "Task id: T14\n\nAcceptance criteria:\n- T14-AC1: tests pass\n- T14-AC2: A device run shows feedback within 100ms\n- T14-AC3: screens are captured\n\nProof is required.";
  it("rewrites only that criterion so the gate no longer asks for its test, and tells the reviewer why", async () => {
    const { waiveCriteria } = await import("../src/acceptance.js");
    const result = waiveCriteria(text, [{ id: "T14-AC2", reason: "needs a physical Android device; verified at release" }]);
    expect(result.waived).toEqual(["T14-AC2"]);
    expect(acceptanceIds(result.prompt)).toEqual(["T14-AC1", "T14-AC3"]);
    expect(result.prompt).toContain("Waived by the operator, not verified by this task (needs a physical Android device; verified at release): A device run shows feedback within 100ms");
    expect(result.prompt).toContain("- T14-AC1: tests pass");
  });
  it("reports ids it did not find and leaves the prompt alone", async () => {
    const { waiveCriteria } = await import("../src/acceptance.js");
    const result = waiveCriteria(text, [{ id: "T14-AC9", reason: "x" }]);
    expect(result.waived).toEqual([]);
    expect(result.prompt).toBe(text);
  });
});
