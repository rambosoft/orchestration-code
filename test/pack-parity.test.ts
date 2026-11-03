// The characterization and parity gate of the react-ts-vite pack (B-110): a seeded behaviour gap fails, a complete slice passes, the migration map is checked.
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
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-parity-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
async function parity(root: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  try { const { stdout, stderr } = await run("node", [path.join(scripts, "check-parity.mjs"), root], { env: { ...process.env, ...env } }); return { code: 0, out: stdout + stderr }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}

const staticCase = { id: "C-001", page: "offline", behaviour: "Reconnect clears the redirect cookie", expected: "cookie cleared once", basis: "static", sources: ["pages/offline.vue:10-20"] };
const artifact = (cases: unknown[] = [staticCase], extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, slice: "offline", legacy: { revision: "abc1234" }, cases, ...extra }, null, 2);
const pageDoc = (cases = "- C-001 reconnect") => `# Offline\n\n## Purpose\nx\n\n## Cases\n${cases}\n`;
const good = {
  "docs/characterization/offline.json": artifact(),
  "docs/pages/offline.md": pageDoc(),
  "src/pages/offline/index.tsx": "export {};\n",
  "src/pages/offline/index.test.tsx": "it('C-001 reconnect clears the cookie', () => {});\n",
};
const map = (rows: string) => `# Migration map\n\n| old file | new file | status | tests |\n|---|---|---|---|\n${rows}`;

describe("check-parity characterization", () => {
  it("passes a complete slice and a project with nothing characterized yet", async () => {
    const result = await parity(await project(good));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("1 characterization(s)");
    expect((await parity(await project({ "package.json": "{}" }))).code).toBe(0);
  });
  it("fails the seeded gap: a characterized case no test cites (the parity test is missing)", async () => {
    const result = await parity(await project({ ...good, "src/pages/offline/index.test.tsx": "it('nothing', () => {});\n" }));
    expect(result.code).toBe(1);
    expect(result.out).toContain("no test in src/pages/offline/ or a shared test cites C-001");
  });
  it("counts a shared e2e test as the parity test and ignores another page's test", async () => {
    const shared = await parity(await project({ ...good, "src/pages/offline/index.test.tsx": "it('nothing', () => {});\n", "e2e/offline.spec.ts": "test('C-001 end to end', () => {});\n" }));
    expect(shared.code, shared.out).toBe(0);
    const other = await parity(await project({ ...good, "src/pages/offline/index.test.tsx": "it('nothing', () => {});\n", "src/pages/other/index.test.tsx": "it('C-001 other page', () => {});\n" }));
    expect(other.code).toBe(1);
  });
  it.each([
    ["invalid JSON", { "docs/characterization/offline.json": "{ nope" }, "is not valid JSON"],
    ["a wrong schema version", { "docs/characterization/offline.json": artifact([staticCase], { schemaVersion: 2 }) }, "schemaVersion must be 1"],
    ["a slice that differs from the file name", { "docs/characterization/offline.json": artifact([staticCase], { slice: "online" }) }, "slice must equal the file name 'offline'"],
    ["no legacy revision", { "docs/characterization/offline.json": artifact([staticCase], { legacy: {} }) }, "legacy.revision"],
    ["no cases", { "docs/characterization/offline.json": artifact([]) }, "cases must be a non-empty array"],
    ["a bad case id", { "docs/characterization/offline.json": artifact([{ ...staticCase, id: "case-1" }]) }, "id must look like C-001"],
    ["a duplicate case", { "docs/characterization/offline.json": artifact([staticCase, staticCase]) }, "duplicate case for page 'offline'"],
    ["an empty expected value", { "docs/characterization/offline.json": artifact([{ ...staticCase, expected: " " }]) }, "'expected' is required"],
    ["an unknown basis", { "docs/characterization/offline.json": artifact([{ ...staticCase, basis: "guess" }]) }, "basis must be 'static'"],
    ["an observed case without observation", { "docs/characterization/offline.json": artifact([{ ...staticCase, basis: "observed" }]) }, "needs 'observation'"],
    ["no sources", { "docs/characterization/offline.json": artifact([{ ...staticCase, sources: [] }]) }, "sources must list at least one legacy path"],
    ["a case the page document does not list", { "docs/pages/offline.md": pageDoc("- C-002 other") }, "does not list C-001 under Cases"],
    ["a page without a document", { "docs/pages/offline.md": "" , "docs/characterization/offline.json": artifact([{ ...staticCase, page: "ghost" }]) }, "page 'ghost' has no docs/pages/ghost.md"],
  ])("fails %s", async (_name, change, expected) => {
    const files: Record<string, string> = { ...good, ...change };
    if (files["docs/pages/offline.md"] === "") delete files["docs/pages/offline.md"];
    const result = await parity(await project(files));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it("accepts an observed case that names its capture", async () => {
    const observed = { ...staticCase, basis: "observed", observation: "captured 2026-11-03, tests/fixtures/offline.json" };
    expect((await parity(await project({ ...good, "docs/characterization/offline.json": artifact([observed]) }))).code).toBe(0);
  });
  it("with REFERENCE_ROOT, fails a cited legacy source that does not exist and accepts one that does", async () => {
    const reference = await project({ "pages/offline.vue": "<template/>\n" });
    expect((await parity(await project(good), { REFERENCE_ROOT: reference })).code).toBe(0);
    const empty = await project({ "README.md": "x\n" });
    const result = await parity(await project(good), { REFERENCE_ROOT: empty });
    expect(result.code).toBe(1);
    expect(result.out).toContain("legacy source 'pages/offline.vue:10-20' does not exist under REFERENCE_ROOT");
  });
});

describe("check-parity migration map", () => {
  const withMap = (rows: string) => ({ ...good, "docs/migration/map.md": map(rows), "src/pages/offline/offline.ts": "export {};\n" });
  it("accepts planned rows and ported rows with an existing new file and tests, and ignores the header", async () => {
    const rows = "| pages/offline.vue | src/pages/offline/offline.ts | verified | src/pages/offline/index.test.tsx |\n| pages/later.vue | - | planned | - |\n";
    const result = await parity(await project(withMap(rows)));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("2 map row(s)");
  });
  it.each([
    ["an unknown status", "| a.vue | src/a.ts | done | - |\n", "has status 'done'"],
    ["a ported row whose new file is missing", "| a.vue | src/missing.ts | ported | src/pages/offline/index.test.tsx |\n", "'src/missing.ts' does not exist"],
    ["a ported row without tests", "| a.vue | src/pages/offline/offline.ts | ported | - |\n", "is ported without tests"],
    ["a ported row citing a missing test", "| a.vue | src/pages/offline/offline.ts | verified | src/nope.test.ts |\n", "cites test 'src/nope.test.ts', which does not exist"],
  ])("fails %s", async (_name, rows, expected) => {
    const result = await parity(await project(withMap(rows)));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it("reads a hand-written map: backticks, several new files, a note after the old path, a status with a note, test file names alone", async () => {
    const rows = "| `pages/offline.vue` history note | `src/pages/offline/offline.ts`, `src/pages/offline/index.tsx` | page ported; wiring deferred | `index.test.tsx` |\n";
    const result = await parity(await project(withMap(rows)));
    expect(result.code, result.out).toBe(0);
    const missing = await parity(await project(withMap(rows.replace("src/pages/offline/index.tsx", "src/pages/offline/gone.tsx"))));
    expect(missing.out).toContain("'src/pages/offline/gone.tsx' does not exist");
  });
  it("fails a verified page without a characterization, and accepts the same row once a case characterizes the page, while a ported row may wait", async () => {
    const row = "| pages/offline.vue | src/pages/offline/offline.ts | verified | src/pages/offline/index.test.tsx |\n";
    const without: Record<string, string> = { ...withMap(row) };
    delete without["docs/characterization/offline.json"];
    const failing = await parity(await project(without));
    expect(failing.code).toBe(1);
    expect(failing.out).toContain("is verified but page 'offline' has no characterization");
    expect((await parity(await project(withMap(row)))).code).toBe(0);
    expect((await parity(await project({ ...without, "docs/migration/map.md": map(row.replace("verified", "ported")) }))).code).toBe(0);
  });
  it("with REFERENCE_ROOT, fails an old file that does not exist in the reference", async () => {
    const reference = await project({ "pages/offline.vue": "x\n" });
    const result = await parity(await project(withMap("| pages/gone.vue | - | planned | - |\n")), { REFERENCE_ROOT: reference });
    expect(result.code).toBe(1);
    expect(result.out).toContain("old file 'pages/gone.vue' does not exist under REFERENCE_ROOT");
  });
});
