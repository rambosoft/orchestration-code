import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BacklogItemSchema, formatSurveyMarkdown, validateSurvey } from "../src/survey.js";
import { parseSurveyBacklog, planFromBacklog } from "../src/plan-from-survey.js";
import { DEFAULT_SIZE_LIMITS } from "../src/task-size.js";

describe("survey backlog planning", () => {
  it("round trips the validated backlog, including normalized area and critical", () => {
    const survey = validateSurvey(JSON.stringify({ summary: "Survey", stack: "Vue", modules: [], refactor_backlog: [{ id: "R1", title: "Search", kind: "logic", old_paths: ["src/search.ts"], target: "Search module", tests: ["search parity"], size: "S", depends_on: [], changes_behaviour: false, area: " Search Sort ", critical: "true" }] }));
    const markdown = formatSurveyMarkdown(survey, { project: "app", mode: "migrate", filesConsulted: [] });
    expect(parseSurveyBacklog(markdown)).toEqual(survey.refactor_backlog);
  });

  it("parses all 12 fixture rows from the Markdown table", async () => {
    const markdown = await readFile(new URL("./fixtures/survey-luxus-app.md", import.meta.url), "utf8");
    const items = parseSurveyBacklog(markdown);
    expect(items.map(item => item.id)).toEqual(Array.from({ length: 12 }, (_, index) => `R${index + 1}`));
    expect(items.map(item => item.size)).toEqual(["S", "M", "L", "L", "L", "L", "L", "L", "L", "L", "L", "L"]);
    expect(items.map(item => item.depends_on)).toEqual([[], [], ["R2"], ["R3"], ["R4"], ["R2", "R4", "R5"], ["R3", "R4", "R5"], ["R2"], ["R4", "R7", "R8"], ["R3", "R4"], ["R3", "R5"], ["R3"]]);
  });

  it("adds the characterize-first paragraph to every task only when asked, within the prompt budget", async () => {
    const items = parseSurveyBacklog(await readFile(new URL("./fixtures/survey-luxus-app.md", import.meta.url), "utf8"));
    const plain = planFromBacklog(items, { projectId: "luxus", prefix: "LUX" });
    expect(plain.spec.tasks.every(task => !task.prompt.includes("CHARACTERIZE FIRST"))).toBe(true);
    const characterized = planFromBacklog(items, { projectId: "luxus", prefix: "LUX", characterize: true });
    for (const task of characterized.spec.tasks) {
      expect(task.prompt).toContain("CHARACTERIZE FIRST");
      expect(task.prompt).toContain(`docs/characterization/${task.taskId.replace("LUX-", "").toLowerCase()}.json`);
      expect(task.prompt).toContain("npm run check:parity");
      expect(task.prompt.length).toBeLessThan(3500);
    }
  });

  it("orders dependencies, excludes decision items, and writes bounded prompts", async () => {
    const markdown = await readFile(new URL("./fixtures/survey-luxus-app.md", import.meta.url), "utf8");
    const items = parseSurveyBacklog(markdown).map(item => item.id === "R2" ? { ...item, changes_behaviour: true } : item.id === "R1" ? { ...item, critical: true } : item);
    const result = planFromBacklog(items, { projectId: "luxus", prefix: "LUX" });
    const ids = result.spec.tasks.map(task => task.taskId);
    expect(ids).not.toContain("LUX-R2");
    expect(result.needsDecision.map(item => item.id)).toEqual(["R2"]);
    expect(ids.indexOf("LUX-R4")).toBeLessThan(ids.indexOf("LUX-R6"));
    expect(ids.indexOf("LUX-R4")).toBeLessThan(ids.indexOf("LUX-R9"));
    expect(ids.indexOf("LUX-R7")).toBeLessThan(ids.indexOf("LUX-R9"));
    expect(ids.indexOf("LUX-R8")).toBeLessThan(ids.indexOf("LUX-R9"));
    const first = result.spec.tasks.find(task => task.taskId === "LUX-R1")!;
    expect(first.prompt).toContain("pages/");
    expect(first.prompt).toContain("Target:");
    expect(first.prompt).toContain("CRITICAL AREA");
    expect(first.prompt.startsWith("Area: ")).toBe(true);
    expect(first.prompt.indexOf("Goal:")).toBeGreaterThan(first.prompt.indexOf("Area: "));
    expect(first.prompt).toContain("Critical: yes");
    expect(first.prompt.length).toBeLessThan(3500);
    expect(result.spec.tasks.every(task => Object.keys(task).sort().join(",") === "prompt,taskId,title")).toBe(true);
    expect(result.spec.projectId).toBe("luxus");
    expect(result.spec.tasks.find(task => task.taskId === "LUX-R3")!.prompt).toContain("pending a decision");
  });

  it("infers fixture areas and writes task directives", async () => {
    const markdown = await readFile(new URL("./fixtures/survey-luxus-app.md", import.meta.url), "utf8");
    const result = planFromBacklog(parseSurveyBacklog(markdown), { projectId: "luxus", prefix: "LUX" });
    const prompt = (id: string) => result.spec.tasks.find(task => task.taskId === `LUX-${id}`)!.prompt;
    expect(prompt("R4")).toMatch(/^Area: xtream-fetch\nCritical: yes\nGoal:/);
    expect(prompt("R8")).toMatch(/^Area: carousel\nCritical: yes\nGoal:/);
    expect(prompt("R3")).toMatch(/^Area: shell-auth\nGoal:/);
    expect(prompt("R3")).not.toContain("Critical: yes");
  });

  it("reports cycles and unknown dependencies with involved ids", () => {
    const item = (id: string, depends_on: string[]) => BacklogItemSchema.parse({ id, title: id, kind: "logic", old_paths: [`src/${id}.ts`], target: "module", tests: [], size: "S", depends_on, changes_behaviour: false });
    expect(() => planFromBacklog([item("A", ["B"]), item("B", ["A"])], { projectId: "p", prefix: "T" })).toThrow(/cycle.*A.*B/i);
    expect(() => planFromBacklog([item("A", ["Z"])], { projectId: "p", prefix: "T" })).toThrow(/unknown dependency Z.*A/i);
  });

  it("plans one milestone with --only, drops dependencies on the rest, and ties critical tasks to their approved design or says one is missing (B-159)", async () => {
    const items = parseSurveyBacklog(await readFile(new URL("./fixtures/survey-luxus-app.md", import.meta.url), "utf8"));
    const only = ["R3", "R4", "R5", "R12"];
    const bare = planFromBacklog(items, { projectId: "luxus", prefix: "LUX", only });
    const critical = bare.spec.tasks.filter(task => task.prompt.includes("Critical: yes")).map(task => ({ taskId: task.taskId, area: /^Area: (.+)$/m.exec(task.prompt)![1]! }));
    expect(critical.length).toBeGreaterThan(0);
    const area = critical[0]!.area;
    const withDesign = planFromBacklog(items, { projectId: "luxus", prefix: "LUX", only, designs: { [area]: `docs/design/${area}.md` } });
    expect(withDesign.spec.tasks.map(task => task.taskId).sort()).toEqual(only.map(id => `LUX-${id}`).sort());
    const prompts = Object.fromEntries(withDesign.spec.tasks.map(task => [task.taskId, task.prompt]));
    for (const task of critical) {
      const prompt = prompts[task.taskId]!;
      if (task.area === area) { expect(prompt).toContain(`Design: docs/design/${area}.md`); expect(prompt).toContain("build inside the approved design"); }
      else { expect(prompt).not.toContain("Design:"); expect(prompt).toContain("no approved design exists for area " + task.area); }
    }
    expect(withDesign.needsDesign).toEqual([...new Set(critical.filter(task => task.area !== area).map(task => task.area))].sort());
    expect(withDesign.plan.includes("## Needs an approved design first")).toBe(withDesign.needsDesign.length > 0);
    const forced = planFromBacklog(items, { projectId: "luxus", prefix: "LUX", only: ["R12"], areas: { R12: { area: "build-release", critical: true } }, designs: { "build-release": "docs/design/build.md" } });
    expect(forced.spec.tasks[0]!.prompt).toContain("Area: build-release");
    expect(forced.spec.tasks[0]!.prompt).toContain("Critical: yes");
    expect(forced.spec.tasks[0]!.prompt).toContain("Design: docs/design/build.md");
    expect(() => planFromBacklog(items, { projectId: "luxus", prefix: "LUX", only: ["R3", "R99"] })).toThrow("Unknown backlog id(s) in --only: R99");
  });

  describe("size gate (B-178)", () => {
    // The schema clamps old_paths to 1..8 entries, so set them after parsing: the gate must also cope with longer lists and with none.
    const mk = (id: string, old_paths: string[], extra: Record<string, unknown> = {}) => ({ ...BacklogItemSchema.parse({ id, title: "Item " + id, kind: "logic", old_paths: ["x"], target: "module", tests: ["t"], size: "S", depends_on: [], changes_behaviour: false, area: "core", ...extra }), old_paths });
    const wide = () => mk("W", [...Array.from({ length: 6 }, (_, i) => `src/a/f${i}.ts`), ...Array.from({ length: 4 }, (_, i) => `src/b/f${i}.ts`), ...Array.from({ length: 4 }, (_, i) => `src/c/f${i}.ts`)]);
    const base = { projectId: "p", prefix: "T" };
    it("leaves a too-large item out of the tasks and proposes parts under the limit; prototype keeps it", () => {
      const limits = DEFAULT_SIZE_LIMITS.production;
      const result = planFromBacklog([wide(), mk("B", ["src/z/one.ts"])], { ...base, limits });
      expect(result.spec.tasks.map(task => task.taskId)).toEqual(["T-B"]);
      const [split] = result.needsSplit;
      expect(split).toMatchObject({ id: "W", title: "Item W", files: 14, areas: 3 });
      expect(split!.reasons.length).toBeGreaterThan(0);
      expect(split!.proposal.length).toBeGreaterThan(1);
      expect(split!.proposal.every(part => part.files.length < limits.largeMinFiles)).toBe(true);
      expect(split!.proposal.flatMap(part => part.files)).toHaveLength(14);
      const proto = planFromBacklog([wide()], { ...base, limits: DEFAULT_SIZE_LIMITS.prototype });
      expect(proto.spec.tasks.map(task => task.taskId)).toEqual(["T-W"]);
      expect(proto.needsSplit).toEqual([]);
    });
    it("adds a Lane line for small items only, and none for normal, unknown or when no limits are given", () => {
      const limits = DEFAULT_SIZE_LIMITS.production;
      const prompt = (items: ReturnType<typeof mk>[], opts: object, id: string) => planFromBacklog(items, { ...base, ...opts }).spec.tasks.find(task => task.taskId === "T-" + id)!.prompt;
      expect(prompt([mk("S", ["src/a/x.ts"])], { limits }, "S")).toContain("Lane: light");
      expect(prompt([mk("N", ["src/a/x.ts", "src/a/y.ts", "src/a/z.ts"])], { limits }, "N")).not.toContain("Lane:");
      expect(prompt([mk("E", [])], { limits }, "E")).not.toContain("Lane:");
      expect(prompt([mk("S", ["src/a/x.ts"])], {}, "S")).not.toContain("Lane:");
    });
    it("merges consecutive small same-area items only with mergeSmall, keeps both acceptance lists, never merges critical or dependent items", () => {
      const limits = DEFAULT_SIZE_LIMITS.production;
      const a = mk("A", ["src/a/x.ts"]), b = mk("B", ["src/a/y.ts"]);
      expect(planFromBacklog([a, b], { ...base, limits }).spec.tasks.map(task => task.taskId)).toEqual(["T-A", "T-B"]);
      const merged = planFromBacklog([a, b], { ...base, limits, mergeSmall: true }).spec.tasks;
      expect(merged.map(task => task.taskId)).toEqual(["T-A+B"]);
      expect(merged[0]!.prompt).toContain("Lane: light");
      expect(merged[0]!.prompt).toContain("Item A");
      expect(merged[0]!.prompt).toContain("Item B");
      expect(merged[0]!.prompt.match(/^1\. The stated goal/gm)).toHaveLength(2);
      const crit = planFromBacklog([a, mk("C", ["src/a/z.ts"], { critical: true })], { ...base, limits, mergeSmall: true }).spec.tasks;
      expect(crit.map(task => task.taskId)).toEqual(["T-A", "T-C"]);
      const dep = planFromBacklog([a, mk("D", ["src/a/q.ts"], { depends_on: ["A"] })], { ...base, limits, mergeSmall: true }).spec.tasks;
      expect(dep.map(task => task.taskId)).toEqual(["T-A", "T-D"]);
    });
    it("treats a dependency on a split item like a pending decision", () => {
      const result = planFromBacklog([wide(), mk("B", ["src/z/one.ts"], { depends_on: ["W"] })], { ...base, limits: DEFAULT_SIZE_LIMITS.production });
      expect(result.spec.tasks.map(task => task.taskId)).toEqual(["T-B"]);
      expect(result.spec.tasks[0]!.prompt).toContain("Dependencies pending a decision: W");
    });
  });
});
