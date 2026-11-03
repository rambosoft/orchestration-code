// Living documentation checks of the react-ts-vite pack (B-123): route coverage in check-page-docs, the generated AI index with its drift check, and the pack wiring.
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const scripts = path.resolve("templates/react-ts-vite/scripts");
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-docs-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
async function script(name: string, root: string, ...extra: string[]): Promise<{ code: number; out: string }> {
  try { const { stdout, stderr } = await run("node", [path.join(scripts, name), root, ...extra]); return { code: 0, out: stdout + stderr }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}

const doc = (route: string, cases = "- C-001 shows the page") => `# Page\n\nRoute: ${route}\n\n## Purpose\nShows the offline notice.\n\n## Visible content\nx\n\n## Actions\nx\n\n## Inputs\nx\n\n## Data\nx\n\n## Cases\n${cases}\n`;
const page = (name: string) => ({ [`src/pages/${name}/index.tsx`]: "export {};\n", [`src/pages/${name}/index.test.tsx`]: "it('C-001 shows the page', () => {});\n" });
const router = (...routes: string[]) => ({ "src/router/router.ts": `const routes = {\n${routes.map(route => `  "${route}": "x",`).join("\n")}\n};\nexport const back = () => push("/elsewhere");\n` });

describe("check-page-docs route coverage", () => {
  it("accepts documents whose Route lines match the routes declared as keys in src/router, and ignores paths that are only call arguments", async () => {
    const result = await script("check-page-docs.mjs", await project({ ...page("offline"), ...page("blocked"), ...router("/offline", "/blocked"), "docs/pages/offline.md": doc("/offline"), "docs/pages/blocked.md": doc("/blocked") }));
    expect(result.code, result.out).toBe(0);
  });
  it("fails a declared route without a document, a document without a Route line, and a Route the router does not declare", async () => {
    const missingDoc = await script("check-page-docs.mjs", await project({ ...page("offline"), ...router("/offline", "/extra"), "docs/pages/offline.md": doc("/offline") }));
    expect(missingDoc.out).toContain("route '/extra' in src/router has no page document");
    const noLine = await script("check-page-docs.mjs", await project({ ...page("offline"), ...router("/offline"), "docs/pages/offline.md": doc("/offline").replace("Route: /offline\n\n", "") }));
    expect(noLine.out).toContain("has no 'Route:' line");
    const stale = await script("check-page-docs.mjs", await project({ ...page("offline"), ...router("/offline"), "docs/pages/offline.md": doc("/offline, /gone") }));
    expect(stale.out).toContain("declares 'Route: /gone', which is not declared in src/router");
  });
  it("accepts 'Route: none' for a page without a route and skips route checks when there is no src/router", async () => {
    expect((await script("check-page-docs.mjs", await project({ ...page("widget"), ...router("/offline"), ...page("offline"), "docs/pages/widget.md": doc("none"), "docs/pages/offline.md": doc("/offline") }))).code).toBe(0);
    expect((await script("check-page-docs.mjs", await project({ ...page("offline"), "docs/pages/offline.md": doc("/anything").replace("Route: /anything\n\n", "") }))).code).toBe(0);
  });
});

describe("generate-ai-index", () => {
  const base = { "docs/ai/INDEX.md": "# AI map\n\nHand written line.\n", ...page("offline"), "docs/pages/offline.md": doc("/offline"), "src/storage/README.md": "# storage\n\nKeeps data behind one interface.\n", "src/input/index.ts": "export {};\n" };
  it("appends a generated block with pages and modules, keeps hand-written lines, and is stable on a second run", async () => {
    const root = await project(base);
    expect((await script("generate-ai-index.mjs", root)).out).toContain("updated (1 page(s), 2 module(s))");
    const text = await readFile(path.join(root, "docs/ai/INDEX.md"), "utf8");
    expect(text).toContain("Hand written line.");
    expect(text).toContain("- `offline` (/offline): Shows the offline notice. -> `docs/pages/offline.md`");
    expect(text).toContain("- `src/storage/`: Keeps data behind one interface.");
    expect(text).toContain("- `src/input/`: no README.md yet");
    expect((await script("generate-ai-index.mjs", root)).out).toContain("unchanged");
    expect((await script("generate-ai-index.mjs", root, "--check")).code).toBe(0);
  });
  it("--check fails on a missing block and on drift after a page or module is added, without writing", async () => {
    const root = await project(base);
    const missing = await script("generate-ai-index.mjs", root, "--check");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("no generated block");
    await script("generate-ai-index.mjs", root);
    await mkdir(path.join(root, "src/hooks"), { recursive: true });
    await writeFile(path.join(root, "src/hooks/index.ts"), "export {};\n");
    const before = await readFile(path.join(root, "docs/ai/INDEX.md"), "utf8");
    const drift = await script("generate-ai-index.mjs", root, "--check");
    expect(drift.code).toBe(1);
    expect(drift.out).toContain("out of date");
    expect(await readFile(path.join(root, "docs/ai/INDEX.md"), "utf8")).toBe(before);
  });
  it("fails without docs/ai/INDEX.md", async () => {
    expect((await script("generate-ai-index.mjs", await project({ "src/a/index.ts": "export {};\n" }))).code).toBe(1);
  });
});

describe("pack wiring for living documentation", () => {
  it("copies the scripts and the drift workflow, exposes ai:index and check:index, and gates check:index", async () => {
    const pack = JSON.parse(await readFile(path.resolve("templates/react-ts-vite/pack.json"), "utf8")) as { copy: string[]; scripts: Record<string, string>; gates: Array<{ script: string }> };
    for (const file of ["scripts/generate-ai-index.mjs", ".github/workflows/drift.yml"]) expect(pack.copy).toContain(file);
    expect(pack.scripts["check:index"]).toContain("--check");
    expect(pack.scripts.verify).toContain("check:index");
    expect(pack.gates.map(gate => gate.script)).toContain("check:index");
    const workflow = await readFile(path.resolve("templates/react-ts-vite/.github/workflows/drift.yml"), "utf8");
    expect(workflow).toContain("schedule:");
    expect(workflow).not.toMatch(/git (?:commit|push)/);
  });
});

describe("check-page-docs with a slice that is not a page", () => {
  it("lets a shared test cite the cases of docs/areas/<name>.md, and still rejects an id no document lists", async () => {
    const files = { ...page("offline"), ...router("/offline"), "docs/pages/offline.md": doc("/offline"), "docs/areas/build.md": "# Build\n\n## Cases\n- C-007 the build keeps a legacy entry\n" };
    const ok = await script("check-page-docs.mjs", await project({ ...files, "tests/build.test.ts": "it('C-007 the build keeps a legacy entry', () => {});\n" }));
    expect(ok.code, ok.out).toBe(0);
    const bad = await script("check-page-docs.mjs", await project({ ...files, "tests/build.test.ts": "it('C-099 nothing lists this', () => {});\n" }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("C-099, which no page or area document lists");
  });
});

