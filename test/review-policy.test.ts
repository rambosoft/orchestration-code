// Specialist review (B-129) and rule-aware review (B-134): which changes earn a focused review, and which findings stand.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cp, readFile } from "node:fs/promises";
import { ProjectManifestSchema } from "../src/contracts.js";
import { executeStage } from "../src/activities.js";
import type { StageOutput } from "../src/contracts.js";
import { globToRegExp, matchSpecialists, specialistReasons, specialistReviewText, type SpecialistArea } from "../src/review-policy.js";
import { readRuleContext } from "../src/review-rules.js";
import { requireRuleCitations } from "../src/review.js";

const areas: SpecialistArea[] = [
  { id: "storage", paths: ["src/storage/**", "src/services/cache*.ts"], focus: "Catalogue data goes through the storage interface; check batching, eviction and quota failures." },
  { id: "input", paths: ["src/input/**"], focus: "Only src/input listens for keys; check focus restoration and modal containment." },
];

describe("globToRegExp", () => {
  it.each([
    ["src/storage/**", "src/storage/db.ts", true], ["src/storage/**", "src/storage/deep/er/db.ts", true], ["src/storage/**", "src/storage", false], ["src/storage/**", "src/storage2/db.ts", false],
    ["src/*.ts", "src/a.ts", true], ["src/*.ts", "src/x/a.ts", false], ["**/*.test.ts", "a.test.ts", true], ["**/*.test.ts", "src/x/a.test.ts", true],
    ["src/a?.ts", "src/ab.ts", true], ["src/a?.ts", "src/abc.ts", false], ["src/(x).ts", "src/(x).ts", true], ["src/a.ts", "src/aXts", false],
  ])("%s against %s is %s", (glob, file, expected) => { expect(globToRegExp(glob).test(file)).toBe(expected); });
});

describe("matchSpecialists", () => {
  it("returns the areas a change touches with the files that touched them, in manifest order, and nothing for a page change", () => {
    const matches = matchSpecialists(areas, ["src/pages/home/index.tsx", "src/input/keys.ts", "src/storage/db.ts", "src/services/cache-manager.ts"]);
    expect(matches.map(match => [match.area.id, match.files])).toEqual([["storage", ["src/storage/db.ts", "src/services/cache-manager.ts"]], ["input", ["src/input/keys.ts"]]]);
    expect(matchSpecialists(areas, ["src/pages/home/index.tsx", "docs/pages/home.md"])).toEqual([]);
    expect(matchSpecialists([], ["src/storage/db.ts"])).toEqual([]);
  });
  it("reads Windows separators and a leading ./", () => {
    expect(matchSpecialists(areas, ["src\\storage\\db.ts", "./src/input/keys.ts"]).map(match => match.area.id)).toEqual(["storage", "input"]);
  });
  it("words the reasons and the prompt section, and says nothing when nothing matched", () => {
    const matches = matchSpecialists(areas, Array.from({ length: 5 }, (_value, index) => `src/storage/file${index}.ts`));
    expect(specialistReasons(matches)).toEqual(["touches the storage area (src/storage/file0.ts, src/storage/file1.ts, src/storage/file2.ts, and 2 more)"]);
    const text = specialistReviewText(matches);
    expect(text).toContain("SPECIALIST REVIEW");
    expect(text).toContain("storage (src/storage/file0.ts");
    expect(text).toContain(areas[0]!.focus);
    expect(specialistReviewText([])).toBe("");
  });
});

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

describe("readRuleContext", () => {
  it("reads the pack's own rules: gates listed, prose rules spelled out, the citation duty stated", async () => {
    const context = await readRuleContext("templates/react-ts-vite");
    expect(context?.ids.has("R-021")).toBe(true);
    expect(context?.ids.size).toBeGreaterThanOrEqual(23);
    expect(context?.block).toContain("R-021 depcruise");
    expect(context?.block).toMatch(/- R-016 Every subscription, timer, observer/);
    expect(context?.block).not.toContain("R-016 prose");
    expect(context?.block).toContain("Every finding needs a \"rule\" field");
  });
  it("is undefined for a repository without a rule set or with a broken one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-rules-")); dirs.push(root);
    expect(await readRuleContext(root)).toBeUndefined();
    await mkdir(path.join(root, "docs/ai"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "- R-001 Strict.\n");
    await writeFile(path.join(root, "docs/ai/enforcement.json"), "{ nope");
    expect(await readRuleContext(root)).toBeUndefined();
    await writeFile(path.join(root, "docs/ai/enforcement.json"), JSON.stringify([{ id: "R-001", gate: "lint" }, { id: "R-002" }]));
    expect(await readRuleContext(root)).toBeUndefined();
    await writeFile(path.join(root, "docs/ai/enforcement.json"), JSON.stringify([{ id: "R-001", gate: "lint" }, { id: "R-002", gate: "prose" }]));
    expect((await readRuleContext(root))?.block).toContain("R-002");
  });
});

const finding = (over: Record<string, unknown> = {}) => ({ severity: "high" as const, category: "functional" as const, title: "Something is wrong", evidence: "because", fixableInCode: true, ...over });
const reviewOf = (findings: ReturnType<typeof finding>[], notes: ReturnType<typeof finding>[] = []): StageOutput => ({ stage: "review", ok: false, summary: "x", findings: [], artifactRefs: [], provider: "p", durationMs: 0, review: { verdict: "needs_changes", findings, notes } });
const known = new Set(["R-001", "R-021"]);

describe("requireRuleCitations", () => {
  it("keeps a finding that cites a defined rule, a case id, or BUG with a scenario, in the rule field or the title", () => {
    const out = requireRuleCitations(reviewOf([finding({ rule: "R-021" }), finding({ rule: "c-004" }), finding({ rule: "BUG", scenario: "Open the list with 5000 rows and the focus jumps to the first row." }), finding({ title: "R-001: any without a comment" })]), known);
    expect(out.review?.findings).toHaveLength(4);
    expect(out.metadata?.movedForNoRule).toBeUndefined();
  });
  it("moves a finding without a rule, with an unknown rule or with BUG and no scenario to the notes, and passes when none is left", () => {
    const out = requireRuleCitations(reviewOf([finding(), finding({ rule: "R-999" }), finding({ rule: "BUG", scenario: "short" })]), known);
    expect(out.review?.findings).toEqual([]);
    expect(out.review?.notes).toHaveLength(3);
    expect(out.review?.notes.every(note => note.severity === "medium")).toBe(true);
    expect(out.review?.verdict).toBe("pass");
    expect(out.ok).toBe(true);
    expect(out.metadata?.movedForNoRule).toEqual(["Something is wrong", "Something is wrong", "Something is wrong"]);
  });
  it("keeps the verdict failing while a cited blocker remains, and keeps earlier notes", () => {
    const out = requireRuleCitations(reviewOf([finding({ rule: "R-021" }), finding({ title: "Taste" })], [finding({ title: "Earlier note", severity: "low" })]), known);
    expect(out.review?.verdict).toBe("needs_changes");
    expect(out.ok).toBe(false);
    expect(out.review?.findings.map(item => item.title)).toEqual(["Something is wrong"]);
    expect(out.review?.notes.map(item => item.title)).toEqual(["Earlier note", "Taste"]);
  });
  it("leaves an output without an assessment untouched", () => {
    const bare = { ...reviewOf([]), review: undefined };
    expect(requireRuleCitations(bare, known)).toBe(bare);
  });
});

describe("the review stage in a repository with a rule set (B-134)", () => {
  const review = (root: string) => executeStage({ runId: `rr-${path.basename(root)}`, taskId: "t", projectId: "p", profile: "implementation", stage: "review", prompt: "[INJECT_REVIEW_FAILURE]\nReview the change.", attempt: 1, provider: "fake", projectRoot: root, artifactsDir: path.join(root, "artifacts"), plugins: [] });
  it("moves a finding that cites no rule to the notes, so the review passes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-rules-")); dirs.push(root);
    await mkdir(path.join(root, "docs/ai"), { recursive: true });
    await cp("templates/react-ts-vite/AGENTS.md", path.join(root, "AGENTS.md"));
    await cp("templates/react-ts-vite/docs/ai/enforcement.json", path.join(root, "docs/ai/enforcement.json"));
    const result = await review(root);
    expect(result.ok).toBe(true);
    expect(result.review?.findings).toEqual([]);
    expect(result.review?.notes.map(note => note.title)).toContain("Injected deterministic review failure");
    expect(result.metadata?.movedForNoRule).toEqual(["Injected deterministic review failure"]);
  }, 60_000);
  it("keeps the ordinary review for a repository without rules", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-rules-")); dirs.push(root);
    const result = await review(root);
    expect(result.ok).toBe(false);
    expect(result.review?.findings.map(finding => finding.title)).toEqual(["Injected deterministic review failure"]);
  }, 60_000);
});

describe("the luxus-app-react critical areas (B-129)", () => {
  it("send storage, input, adapter, carousel and player changes to a focused review and leave pages and shared UI alone", async () => {
    const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile("projects/luxus-app-react.json", "utf8")));
    const areas = manifest.review?.specialists ?? [];
    const touched = (file: string) => matchSpecialists(areas, [file]).map(match => match.area.id);
    expect(touched("src/storage/catalog-db.ts")).toEqual(["storage"]);
    expect(touched("src/services/cache-manager/index.ts")).toEqual(["storage"]);
    expect(touched("src/input/focus-engine.ts")).toEqual(["input"]);
    expect(touched("src/services/xtream/client.ts")).toEqual(["xtream"]);
    expect(touched("src/components/carousel/Row.tsx")).toEqual(["carousel"]);
    expect(touched("src/components/player/Controls.tsx")).toEqual(["player"]);
    for (const file of ["src/pages/home/index.tsx", "src/components/Button.tsx", "docs/pages/home.md", "src/styles/tokens.css"]) expect(touched(file), file).toEqual([]);
  });
});
