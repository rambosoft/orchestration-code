// The case matrix and the milestone e2e journey format of the react-ts-vite pack (B-132): both directions of the case/test link, and check-journeys.
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const scripts = path.resolve("templates/react-ts-vite/scripts");
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-journeys-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
async function script(name: string, root: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  try { const { stdout, stderr } = await run("node", [path.join(scripts, name), root], { env: { ...process.env, ...env } }); return { code: 0, out: stdout + stderr }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}

const doc = (cases: string) => `# Page\n\n## Purpose\nx\n\n## Visible content\nx\n\n## Actions\nx\n\n## Inputs\nx\n\n## Data\nx\n\n## Cases\n${cases}\n`;
const pageFiles = (name: string, cases: string, testBody: string, extra: Record<string, string> = {}) => ({ [`src/pages/${name}/index.tsx`]: "export {};\n", [`src/pages/${name}/index.test.tsx`]: testBody, [`docs/pages/${name}.md`]: doc(cases), ...extra });

describe("check-page-docs case matrix", () => {
  it("covers a case only from its own page folder or from a shared test, so another page's test with the same id does not count", async () => {
    const own = pageFiles("a", "- C-001 x", "it('C-001 a', () => {});\n");
    expect((await script("check-page-docs.mjs", await project(own))).code).toBe(0);
    const other = { ...pageFiles("a", "- C-001 x", "it('nothing', () => {});\n"), ...pageFiles("b", "- C-001 y", "it('C-001 b', () => {});\n") };
    const result = await script("check-page-docs.mjs", await project(other));
    expect(result.code).toBe(1);
    expect(result.out).toContain("docs/pages/a.md: case C-001 is not cited by a test in src/pages/a/");
    expect(result.out).not.toContain("docs/pages/b.md: case");
    const shared = { ...pageFiles("a", "- C-001 x", "it('nothing', () => {});\n"), "e2e/home.spec.ts": "test('C-001 end to end', () => {});\n" };
    expect((await script("check-page-docs.mjs", await project(shared))).code).toBe(0);
  });
  it("fails a test that cites a case its page document does not list, in a page folder and in a shared test", async () => {
    const page = await script("check-page-docs.mjs", await project(pageFiles("a", "- C-001 x", "it('C-001 and C-009', () => {});\n")));
    expect(page.code).toBe(1);
    expect(page.out).toContain("src/pages/a/index.test.tsx cites C-009, which docs/pages/a.md does not list");
    const sharedTest = await script("check-page-docs.mjs", await project(pageFiles("a", "- C-001 x", "it('C-001', () => {});\n", { "e2e/flow.spec.ts": "test('C-042 ghost case', () => {});\n" })));
    expect(sharedTest.code).toBe(1);
    expect(sharedTest.out).toContain("e2e/flow.spec.ts cites C-042, which no page document lists");
  });
});

describe("check-journeys", () => {
  const journey = (id = "J-001", extra = "") => `# Journey\n\nId: ${id}\nMilestone: M1\n\n## Steps\n1. Open the app.\n2. See the offline page.\n\n## Covers\n- a/C-001\n${extra}`;
  const base = { ...pageFiles("a", "- C-001 x", "it('C-001 a', () => {});\n"), "e2e/journeys/offline.md": journey(), "e2e/first.spec.ts": "test('J-001 offline journey', () => {});\n" };
  it("accepts a journey that has an id, a milestone, steps, valid covers and an e2e test, and ignores the template", async () => {
    const result = await script("check-journeys.mjs", await project({ ...base, "e2e/journeys/_TEMPLATE.md": "# t\n" }));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("1 journey(s)");
  });
  it("passes when there are no journeys yet", async () => {
    expect((await script("check-journeys.mjs", await project({ "package.json": "{}" }))).code).toBe(0);
  });
  it.each([
    ["no id", { "e2e/journeys/offline.md": journey().replace("Id: J-001\n", "") }, "has no 'Id: J-nnn' line"],
    ["a duplicate id", { "e2e/journeys/second.md": journey() }, "repeats the id J-001"],
    ["no milestone", { "e2e/journeys/offline.md": journey().replace("Milestone: M1\n", "") }, "has no 'Milestone:' line"],
    ["too few steps", { "e2e/journeys/offline.md": journey().replace("2. See the offline page.\n", "") }, "at least two steps"],
    ["a covers entry in the wrong format", { "e2e/journeys/offline.md": journey("J-001", "- somewhere\n") }, "is not '<page>/C-nnn'"],
    ["a covers entry for an unknown case", { "e2e/journeys/offline.md": journey("J-001", "- a/C-077\n") }, "docs/pages/a.md does not list"],
    ["no e2e test", { "e2e/first.spec.ts": "test('nothing', () => {});\n" }, "journey J-001 is not cited by an e2e test"],
    ["a test citing an unknown journey", { "e2e/ghost.spec.ts": "test('J-009 ghost', () => {});\n" }, "J-009, which has no journey document"],
  ])("fails %s", async (_name, change, expected) => {
    const result = await script("check-journeys.mjs", await project({ ...base, ...change }));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it("fails a milestone with more journeys than the limit", async () => {
    const many: Record<string, string> = {};
    for (let n = 1; n <= 3; n += 1) { const id = `J-00${n}`; many[`e2e/journeys/j${n}.md`] = journey(id); many[`e2e/j${n}.spec.ts`] = `test('${id} x', () => {});\n`; }
    const result = await script("check-journeys.mjs", await project({ ...pageFiles("a", "- C-001 x", "it('C-001 a', () => {});\n"), ...many }), { JOURNEY_LIMIT: "2" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("milestone M1 has 3 journeys (limit 2)");
  });
});
