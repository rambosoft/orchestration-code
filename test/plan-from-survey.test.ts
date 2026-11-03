import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BacklogItemSchema, formatSurveyMarkdown, validateSurvey } from "../src/survey.js";
import { parseSurveyBacklog, planFromBacklog } from "../src/plan-from-survey.js";

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
});
