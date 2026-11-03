// The component contract format of the react-ts-vite pack (B-161, B-112): check-module-contracts, and the pack's own AI map stays complete.
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
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-contracts-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
async function script(name: string, root: string, ...extra: string[]): Promise<{ code: number; out: string }> {
  try { const { stdout, stderr } = await run("node", [path.join(scripts, name), root, ...extra]); return { code: 0, out: stdout + stderr }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}

const readme = (interfaceText = "`load()` returns the items", invariants = "at most 50 items are kept", sideEffects = "none") => `# storage\n\nKeeps data behind one interface.\n\n## Interface\n${interfaceText}\n\n## Invariants\n${invariants}\n\n## Side Effects\n${sideEffects}\n`;
const source = { "src/storage/index.ts": "export {};\n" };

describe("check-module-contracts", () => {
  it("accepts a module with a purpose and the three sections, and ignores pages, styles, assets, empty folders and test-only folders", async () => {
    const result = await script("check-module-contracts.mjs", await project({ ...source, "src/storage/README.md": readme(), "src/pages/home/index.tsx": "export {};\n", "src/styles/tokens.css": ":root {}\n", "src/assets/logo.svg": "<svg/>\n", "src/hooks/.gitkeep": "", "src/testing/a.test.ts": "it('x', () => {});\n" }));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("1 module(s)");
  });
  it("fails a module folder with source files but no README", async () => {
    const result = await script("check-module-contracts.mjs", await project(source));
    expect(result.code).toBe(1);
    expect(result.out).toContain("src/storage/ has no README.md");
  });
  it.each([
    ["a missing Interface", readme().replace("## Interface\n`load()` returns the items\n\n", ""), "missing the section '## Interface'"],
    ["a missing Invariants", readme().replace("## Invariants\nat most 50 items are kept\n\n", ""), "missing the section '## Invariants'"],
    ["a missing Side Effects", readme().replace("\n## Side Effects\nnone\n", ""), "missing the section '## Side Effects'"],
    ["an empty Invariants", readme("`load()`", "", "none"), "empty '## Invariants'"],
    ["a comment-only Side Effects", readme("`load()`", "kept small", "<!-- todo -->"), "empty '## Side Effects'"],
    ["no purpose line", readme().replace("Keeps data behind one interface.\n\n", ""), "no purpose line"],
  ])("fails %s", async (_name, text, expected) => {
    const result = await script("check-module-contracts.mjs", await project({ ...source, "src/storage/README.md": text }));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it("also checks a nested folder that has its own README, and leaves nested folders without one alone", async () => {
    const files = { ...source, "src/storage/README.md": readme(), "src/storage/cache/index.ts": "export {};\n", "src/storage/cache/README.md": "# cache\n\nOnly a title.\n", "src/storage/util/index.ts": "export {};\n" };
    const result = await script("check-module-contracts.mjs", await project(files));
    expect(result.code).toBe(1);
    expect(result.out).toContain("src/storage/cache/README.md is missing the section '## Interface'");
    expect(result.out).not.toContain("src/storage/util");
  });
});

describe("the AI map stays complete with the contract gate", () => {
  it("lists a module with its README purpose in the generated index, so a module missing from the map fails check:index", async () => {
    const root = await project({ "docs/ai/INDEX.md": "# map\n", ...source, "src/storage/README.md": readme() });
    await script("generate-ai-index.mjs", root);
    expect(await readFile(path.join(root, "docs/ai/INDEX.md"), "utf8")).toContain("- `src/storage/`: Keeps data behind one interface.");
    await mkdir(path.join(root, "src/input"), { recursive: true });
    await writeFile(path.join(root, "src/input/index.ts"), "export {};\n");
    const drift = await script("generate-ai-index.mjs", root, "--check");
    expect(drift.code).toBe(1);
    expect(drift.out).toContain("out of date");
  });
  it("is wired: rule R-022 maps to the gate, the template exists and the script is a pack script", async () => {
    const pack = JSON.parse(await readFile(path.resolve("templates/react-ts-vite/pack.json"), "utf8")) as { copy: string[]; scripts: Record<string, string>; gates: Array<{ script: string }> };
    for (const file of ["scripts/check-module-contracts.mjs", "docs/ai/MODULE_README_TEMPLATE.md"]) expect(pack.copy).toContain(file);
    expect(pack.scripts.verify).toContain("check:contracts");
    expect(pack.gates.map(gate => gate.script)).toContain("check:contracts");
    const enforcement = JSON.parse(await readFile(path.resolve("templates/react-ts-vite/docs/ai/enforcement.json"), "utf8")) as Array<{ id: string; gate: string }>;
    expect(enforcement).toContainEqual({ id: "R-022", gate: "check:contracts" });
  });
});
