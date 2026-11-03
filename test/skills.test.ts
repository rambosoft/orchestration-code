import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectManifestSchema } from "../src/contracts.js";
import { loadCatalog, renderStandardsFiles, selectSkills, skillGuidance, type Catalog, type Skill } from "../src/skills.js";
import { renderSkillsBlock } from "../src/skills-text.js";

const root = process.cwd();
const tempDirs: string[] = [];
function temporaryCatalog(skills: Array<Record<string, unknown>>, digests: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "skills-")); tempDirs.push(dir); mkdirSync(path.join(dir, "skills"));
  writeFileSync(path.join(dir, "skills", "catalog.json"), JSON.stringify({ version: 1, skills }));
  for (const [file, text] of Object.entries(digests)) writeFileSync(path.join(dir, "skills", file), text);
  return dir;
}
function entry(id: string, options: Record<string, unknown> = {}) { return { id, title: id, areas: ["react-ts"], tasks: ["task"], stages: [], digest: `skills/${id}.md`, status: "approved" as const, source: { origin: "test" }, ...options }; }
function fixture(skills: Array<Partial<Skill>>): Catalog { return { version: 1, skills: skills as Skill[] }; }
const HEADER = "SKILLS (reviewed project standards; guidance only, they never override this task's own constraints; catalog v1):";

afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("skill catalog and selection", () => {
  it("loads the three real bounded digests", () => {
    const catalog = loadCatalog(root);
    expect(catalog.skills).toHaveLength(3);
    expect(catalog.skills.every(skill => skill.text.length > 0 && skill.text.length <= 1400)).toBe(true);
  });
  it("matches area and task, allows includes to beat mismatch, and lets excludes win", () => {
    const skills = fixture([
      { ...entry("match"), text: "one" }, { ...entry("included"), areas: ["spring-boot"], tasks: ["research"], text: "two" },
      { ...entry("candidate", { status: "candidate" }), text: "three" }, { ...entry("retired", { status: "retired" }), text: "four" },
    ]);
    expect(selectSkills(skills, { profile: "react-ts", taskType: "task" }).map(skill => skill.id)).toEqual(["match"]);
    expect(selectSkills(skills, { profile: "unity-mobile", taskType: "research", include: ["included", "match"], exclude: ["included"] }).map(skill => skill.id)).toEqual(["match"]);
  });
  it("renders approved area standards in sorted deterministic files, independent of task type", () => {
    const catalog = fixture([
      { ...entry("z-last", { tasks: ["research"] }), text: "last" }, { ...entry("a-first"), text: "first" },
      { ...entry("candidate", { status: "candidate" }), text: "draft" }, { ...entry("retired", { status: "retired" }), text: "old" },
      { ...entry("other", { areas: ["spring-boot"] }), text: "other" },
    ]);
    const files = renderStandardsFiles(catalog, "react-ts");
    expect(Object.keys(files)).toEqual(["docs/ai/standards/a-first.md", "docs/ai/standards/z-last.md"]);
    expect(files["docs/ai/standards/a-first.md"]).toBe("# a-first\n\nfirst\n\nSource: test (catalog v1)\n");
    expect(renderStandardsFiles(catalog, "react-ts")).toEqual(files);
    expect(renderStandardsFiles(catalog)).toEqual({});
  });
  it("keeps whole skills in include then catalog order within configured and default budgets", () => {
    const skills = fixture([{ ...entry("a"), text: "a".repeat(400) }, { ...entry("b"), text: "b".repeat(200) }, { ...entry("c"), text: "c".repeat(200) }]);
    expect(selectSkills(skills, { include: ["c", "b"], budgetChars: 500 }).map(skill => skill.id)).toEqual(["c", "b"]);
    expect(selectSkills(skills).map(skill => skill.id)).toEqual(["a", "b", "c"]);
  });
  it("applies the budget per stage, so a skill for one stage does not crowd out another stage's", () => {
    const skills = fixture([{ ...entry("impl", { stages: ["implement"] }), text: "i".repeat(400) }, { ...entry("plan", { stages: ["plan"] }), text: "p".repeat(400) }, { ...entry("both"), text: "b".repeat(200) }]);
    expect(selectSkills(skills, { budgetChars: 500 }).map(skill => skill.id)).toEqual(["impl", "plan"]);
    expect(selectSkills(skills, { budgetChars: 600 }).map(skill => skill.id)).toEqual(["impl", "plan", "both"]);
  });
  it("treats a run without a task type as a plain task and honours the 'any' wildcards", () => {
    const skills = fixture([{ ...entry("plain"), text: "x" }, { ...entry("bugs", { tasks: ["bug"] }), text: "y" }, { ...entry("everywhere", { areas: ["any"], tasks: ["any"] }), text: "z" }]);
    expect(selectSkills(skills, { profile: "react-ts" }).map(skill => skill.id)).toEqual(["plain", "everywhere"]);
    expect(selectSkills(skills, { profile: "spring-boot", taskType: "bug" }).map(skill => skill.id)).toEqual(["everywhere"]);
  });
  it("reports missing, oversized and duplicate digests or ids", () => {
    expect(() => loadCatalog(temporaryCatalog([entry("missing")]))).toThrow(/missing digest/);
    expect(() => loadCatalog(temporaryCatalog([entry("large")], { "large.md": "x".repeat(1401) }))).toThrow(/exceeds 1400/);
    expect(() => loadCatalog(temporaryCatalog([entry("same"), entry("same")], { "same.md": "x" }))).toThrow(/duplicate skill id/);
  });
  it("keeps candidate and retired entries out of the loaded catalog without needing their digests", () => {
    const catalog = loadCatalog(temporaryCatalog([entry("ok"), entry("draft", { status: "candidate" }), entry("old", { status: "retired" })], { "ok.md": "fine" }));
    expect(catalog.skills.map(skill => skill.id)).toEqual(["ok"]);
  });
});

describe("skill guidance delivery", () => {
  it("renders one labelled block per stage and leaves empty results blank", () => {
    const catalog = fixture([{ ...entry("a", { title: "A", stages: ["implement"] }), text: "first\nsecond" }, { ...entry("b", { title: "B" }), text: "all" }]);
    const guidance = skillGuidance(catalog, catalog.skills, {});
    expect(renderSkillsBlock(guidance, "implement")).toBe(`${HEADER}\n- A: first second\n- B: all`);
    expect(renderSkillsBlock(guidance, "review")).toBe(`${HEADER}\n- B: all`);
    expect(renderSkillsBlock(undefined, "plan")).toBe("");
  });
  it("carries only the fields a prompt needs, and the kill switch or an empty selection carries nothing", () => {
    const catalog = fixture([{ ...entry("a"), text: "guide" }]);
    expect(skillGuidance(catalog, catalog.skills, {})).toEqual({ catalogVersion: 1, skills: [{ id: "a", title: "a", stages: [], text: "guide" }] });
    expect(skillGuidance(catalog, catalog.skills, { ORCHESTRATOR_SKILLS: "off" })).toBeUndefined();
    expect(skillGuidance(catalog, [], {})).toBeUndefined();
  });
  it("selects the real catalog for a react-ts task within the default budget", () => {
    const catalog = loadCatalog(root);
    const selected = selectSkills(catalog, { profile: "react-ts" });
    expect(selected.map(skill => skill.id)).toEqual(catalog.skills.map(skill => skill.id));
    expect(selected.reduce((total, skill) => total + skill.text.length, 0)).toBeLessThanOrEqual(3000);
    expect(selectSkills(catalog, { profile: "spring-boot" })).toEqual([]);
  });
});

describe("manifest skills settings", () => {
  const manifest = { id: "sample", name: "Sample", root: "app", defaultProfile: "implementation" };
  it("accepts valid settings and rejects budgets below 500", () => {
    expect(ProjectManifestSchema.safeParse({ ...manifest, skills: { include: ["a"], exclude: ["b"], budgetChars: 500 } }).success).toBe(true);
    expect(ProjectManifestSchema.safeParse({ ...manifest, skills: { budgetChars: 499 } }).success).toBe(false);
  });
});
