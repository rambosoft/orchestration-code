// Survey stage (ADR 0032, B-108): schema rules, the deterministic inventory on a real temp repository, the fallback and the rendered document.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deterministicSurvey, formatSurveyMarkdown, surveyModeFromText, surveyPrompt, validateSurvey } from "../src/survey.js";
import { buildSurveyInventory } from "../src/survey-inventory.js";
import { resolveTaskType } from "../src/task-types.js";

const item = (over: Record<string, unknown> = {}) => ({ id: "R1", title: "Offline page", kind: "route", old_paths: ["pages/no-internet/index.vue"], target: "A page component", tests: ["parity"], size: "S", depends_on: [], changes_behaviour: false, ...over });
const survey = (over: Record<string, unknown> = {}) => ({ summary: "Small app.", stack: "Vue 2", modules: [{ name: "Offline", paths: ["pages/no-internet/index.vue"], purpose: "offline screen" }], refactor_backlog: [item()], ...over });
const parse = (value: unknown) => validateSurvey(JSON.stringify(value));

describe("validateSurvey", () => {
  it("accepts a grounded survey, also inside a fence, and defaults the optional lists", () => {
    expect(parse(survey()).refactor_backlog[0]!.id).toBe("R1");
    expect(validateSurvey("```json\n" + JSON.stringify(survey()) + "\n```").modules).toHaveLength(1);
    expect(parse(survey()).todos).toEqual([]);
  });
  it("drops backlog items that name no old files instead of keeping an ungrounded one", () => {
    const parsed = parse(survey({ refactor_backlog: [item(), item({ id: "R2", old_paths: [] }), item({ id: "R3", old_paths: "   " }), { id: "R4", title: "no paths field" }] }));
    expect(parsed.refactor_backlog.map(entry => entry.id)).toEqual(["R1"]);
  });
  it("accepts a single old path written as a string and normalises the size and the behaviour flag", () => {
    const parsed = parse(survey({ refactor_backlog: [item({ old_paths: "pages/a.vue", size: " m ", changes_behaviour: "true" })] })).refactor_backlog[0]!;
    expect(parsed.old_paths).toEqual(["pages/a.vue"]);
    expect(parsed.size).toBe("M");
    expect(parsed.changes_behaviour).toBe(true);
  });
  it("refuses duplicate ids, unknown dependencies and a survey with neither modules nor grounded items", () => {
    expect(() => parse(survey({ refactor_backlog: [item(), item()] }))).toThrow("used twice");
    expect(() => parse(survey({ refactor_backlog: [item({ depends_on: ["R9"] })] }))).toThrow("unknown dependencies");
    expect(() => parse(survey({ modules: [], refactor_backlog: [item({ old_paths: [] })] }))).toThrow("no modules and no backlog");
    expect(() => validateSurvey("no json here")).toThrow("not valid JSON");
  });
});

describe("mode and task type", () => {
  it("reads the mode line and falls back to the harmless audit mode", () => {
    expect(surveyModeFromText("Mode: migrate\nrest")).toBe("migrate");
    expect(surveyModeFromText("intro\n  mode : Refactor")).toBe("refactor");
    expect(surveyModeFromText("Mode: delete everything")).toBe("audit");
    expect(surveyModeFromText("no mode")).toBe("audit");
  });
  it("resolves survey and audit labels to the survey type", () => {
    expect(resolveTaskType({ labels: ["type:survey"] }).type).toBe("survey");
    expect(resolveTaskType({ apiType: "audit" }).type).toBe("survey");
  });
  it("puts the inventory, the context and the mode guidance into the prompt, and tells the model to reconsider the old structure", () => {
    const prompt = surveyPrompt("Survey it", "migrate", "INV", "CTX");
    for (const expected of ["INV", "CTX", "MIGRATE:", "Do not assume the existing code follows good practice", "changes_behaviour", "open_questions"]) expect(prompt).toContain(expected);
  });
});

describe("fallback and document", () => {
  const inventory = { text: "x", routes: [{ file: "pages/a.vue", lines: 40 }, { file: "pages/b.vue", lines: 300 }, { file: "pages/c.vue", lines: 900 }], stores: ["store/a.js"], files: 20 };
  it("builds a valid survey from the route list alone, sized by line count", () => {
    const fallback = deterministicSurvey(inventory, "Unreadable.");
    expect(fallback.refactor_backlog.map(entry => [entry.id, entry.size])).toEqual([["R1", "S"], ["R2", "M"], ["R3", "L"]]);
    expect(parse(fallback).refactor_backlog).toHaveLength(3);
  });
  it("renders the backlog, the items that need a decision and the todo list, and redacts secrets", () => {
    const markdown = formatSurveyMarkdown(parse(survey({ refactor_backlog: [item(), item({ id: "R2", changes_behaviour: true, notes: "moves session storage" })], todos: ["Measure on a TV"], open_questions: ["token sk-abcdefghijklmnopqrstuvwxyz123456"] })), { project: "luxus", mode: "migrate", filesConsulted: ["AGENTS.md"] });
    expect(markdown).toContain("# Survey: luxus");
    expect(markdown).toContain("| R1 | Offline page | route | S |");
    expect(markdown).toMatch(/Needs a decision[\s\S]*R2 Offline page: moves session storage/);
    expect(markdown).toContain("Measure on a TV");
    expect(markdown).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});

describe("buildSurveyInventory", () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  it("counts routes, store modules, dependencies and guidance documents from the tracked files only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-survey-")); dirs.push(root);
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", engines: { node: "14.x" }, dependencies: { vue: "^2.6.0", nuxt: "^2.15.0" }, devDependencies: { eslint: "7" }, scripts: { dev: "nuxt", build: "nuxt build" } }),
      "pages/index.vue": "<template/>\n".repeat(50), "pages/no-internet/index.vue": "<template/>\n".repeat(100), "pages/test/dev.vue": "x", "store/session.js": "export default {}", "components/Button.vue": "<template/>",
      "AGENTS.md": "# rules", "docs/devices.md": "Chrome 38", ".env": "TOKEN=sk-abcdefghijklmnopqrstuvwxyz123456", "node_modules/pkg/index.js": "x", "tests/a.spec.js": "x",
    };
    for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
    execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["add", "-f", "-A"], { cwd: root });
    const inventory = await buildSurveyInventory(root);
    expect(inventory.routes.map(route => route.file).sort()).toEqual(["pages/index.vue", "pages/no-internet/index.vue"]);
    expect(inventory.routes.find(route => route.file === "pages/index.vue")!.lines).toBeGreaterThan(40);
    expect(inventory.stores).toEqual(["store/session.js"]);
    for (const expected of ["vue@^2.6.0", "nuxt@^2.15.0", "\"node\":\"14.x\"", "AGENTS.md", "docs/devices.md", "1 test files"]) expect(inventory.text).toContain(expected);
    expect(inventory.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(inventory.text).not.toContain("node_modules");
    expect(inventory.text).not.toContain(".env");
    expect(inventory.text.length).toBeLessThanOrEqual(12_000);
  });
  it("returns an empty inventory, not an error, for a folder that is not a repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-survey-empty-")); dirs.push(root);
    expect(await buildSurveyInventory(root)).toMatchObject({ routes: [], stores: [], files: 0 });
  });
});
