import { describe, expect, it } from "vitest";
import { applyStack, describePlan, orchestratorPrs, planStack, stackBody, stackPr } from "../src/stack-pr.js";

const raw = (number: number, task: string, head: string, base: string, extra: Partial<{ body: string; isDraft: boolean; title: string }> = {}) => ({ number, url: `https://github.com/me/g/pull/${number}`, title: extra.title ?? `Draft: Task ${task}`, headRefName: head, baseRefName: base, body: extra.body ?? `Paperclip task: ${task}\n\nAutomated review passed.`, isDraft: extra.isDraft ?? true });
// T1 <- T2 <- T3 <- T4 stacked on main
const stack = [raw(1, "LOC-1", "codex/t1", "main"), raw(2, "LOC-2", "codex/t2", "codex/t1"), raw(3, "LOC-3", "codex/t3", "codex/t2"), raw(4, "LOC-4", "codex/t4", "codex/t3")];

describe("orchestratorPrs", () => {
  it("keeps only the PRs the orchestrator published", () => {
    const prs = orchestratorPrs([...stack, raw(9, "x", "feature/x", "main", { body: "A human PR" }), raw(10, "y", "dependabot/y", "main", { body: "" })]);
    expect(prs.map(pr => pr.number)).toEqual([1, 2, 3, 4]);
    expect(prs[0]).toMatchObject({ taskId: "LOC-1", head: "codex/t1", base: "main", draft: true });
  });
});

describe("planStack", () => {
  const prs = orchestratorPrs(stack);
  it("takes the whole stack up to its only tip, bottom first", () => {
    const plan = planStack(prs);
    expect(plan.tip.number).toBe(4);
    expect(plan.included.map(pr => pr.number)).toEqual([1, 2, 3, 4]);
    expect(plan.rootBase).toBe("main");
    expect(plan.above).toEqual([]);
  });
  it("cuts the stack at a milestone: by PR number, task id or branch, and leaves the rest stacked above", () => {
    for (const selector of ["3", "#3", "LOC-3", "loc-3", "codex/t3", "https://github.com/me/g/pull/3"]) {
      const plan = planStack(prs, { through: selector });
      expect(plan.tip.number, selector).toBe(3);
      expect(plan.included.map(pr => pr.number)).toEqual([1, 2, 3]);
      expect(plan.above.map(pr => pr.number)).toEqual([4]);
    }
  });
  it("asks for a choice when two stacks end at different tips, and names an unknown selector", () => {
    const parallel = orchestratorPrs([...stack, raw(5, "LOC-5", "codex/t5", "codex/t2")]);
    expect(() => planStack(parallel)).toThrow("2 stacks end at different tips");
    expect(planStack(parallel, { through: "LOC-5" }).included.map(pr => pr.number)).toEqual([1, 2, 5]);
    expect(() => planStack(prs, { through: "LOC-99" })).toThrow('no open orchestrator PR matches "LOC-99"');
    expect(() => planStack([])).toThrow("no open orchestrator PRs");
  });
  it("handles a single PR stacked on the base", () => {
    const plan = planStack(orchestratorPrs([stack[0]!]));
    expect(plan.included).toHaveLength(1);
    expect(describePlan(plan, { closeStacked: true }).join("\n")).not.toContain("close #");
  });
});

describe("stackBody", () => {
  it("keeps the original description and lists the stacked tasks, replacing an earlier list", () => {
    const plan = planStack(orchestratorPrs(stack), { through: "LOC-3" });
    const body = stackBody(plan);
    expect(body).toContain("Paperclip task: LOC-3");
    expect(body).toContain("Merging this pull request into `main`");
    expect(body).toContain("- #1 Task LOC-1 (task LOC-1)");
    expect(body).toContain("- #3 Task LOC-3 (task LOC-3)");
    const again = stackBody({ ...plan, tip: { ...plan.tip, body } });
    expect(again.match(/### Stacked changes/g)).toHaveLength(1);
  });
});

describe("stackPr", () => {
  function runner() {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => { calls.push([command, ...args]); return args[1] === "list" ? JSON.stringify(stack) : ""; };
    return { calls, run };
  }
  it("changes nothing in a dry run and says what it would do", async () => {
    const { calls, run } = runner();
    const result = await stackPr({ cwd: ".", apply: false, closeStacked: true }, run);
    expect(calls.every(call => call[2] === "list")).toBe(true);
    expect(result.lines.join("\n")).toContain("tip #4");
    expect(result.lines.join("\n")).toContain("close #1, #2, #3");
    expect(result.lines.at(-1)).toContain("dry run");
  });
  it("retargets the tip onto the base and nothing else by default", async () => {
    const { calls, run } = runner();
    await stackPr({ cwd: ".", apply: true, closeStacked: false }, run);
    const writes = calls.filter(call => call[2] !== "list");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.slice(0, 6)).toEqual(["gh", "pr", "edit", "4", "--base", "main"]);
    expect(calls.some(call => call[2] === "merge")).toBe(false);
  });
  it("closes the intermediate PRs with a pointer when asked, and never the tip", async () => {
    const { calls, run } = runner();
    const result = await stackPr({ cwd: ".", through: "LOC-3", apply: true, closeStacked: true }, run);
    const closed = calls.filter(call => call[2] === "close").map(call => call[3]);
    expect(closed).toEqual(["1", "2"]);
    expect(calls.filter(call => call[2] === "comment").every(call => call.join(" ").includes("Included in #3"))).toBe(true);
    expect(result.lines).toContain("closed #2");
    expect(calls.some(call => call[2] === "merge")).toBe(false);
  });
  it("applyStack on its own reports what it did", async () => {
    const plan = planStack(orchestratorPrs(stack), { through: "LOC-2" });
    expect(await applyStack(plan, { cwd: ".", closeStacked: true }, async () => "")).toEqual(["retargeted #2 onto main", "closed #1"]);
  });
});
