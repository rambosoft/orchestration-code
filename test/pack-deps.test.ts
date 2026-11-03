// Dependency hygiene of the react-ts-vite pack (B-113, R-014): an unlisted dependency without a recorded reason fails, and the pack's references point at things that exist.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../src/skills.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const script = path.resolve("templates/react-ts-vite/scripts/check-deps.mjs");
const allowlist = path.resolve("templates/react-ts-vite/docs/ai/dependency-allowlist.json");

async function project(files: Record<string, string>, withAllowlist = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-deps-")); dirs.push(root);
  const all = { ...(withAllowlist ? { "docs/ai/dependency-allowlist.json": await readFile(allowlist, "utf8") } : {}), ...files };
  for (const [name, content] of Object.entries(all)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
async function check(root: string): Promise<{ code: number; out: string }> {
  try { const { stdout, stderr } = await run("node", [script, root]); return { code: 0, out: stdout + stderr }; }
  catch (error) { const failure = error as { code?: number; stdout?: string; stderr?: string }; return { code: failure.code ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` }; }
}
const pkg = (dependencies: Record<string, string> = {}, devDependencies: Record<string, string> = {}) => JSON.stringify({ name: "x", dependencies, devDependencies });

describe("check-deps", () => {
  it("passes dependencies that are on the allow-list", async () => {
    const result = await check(await project({ "package.json": pkg({ react: "^19", "react-dom": "^19" }, { vite: "^8", vitest: "^4" }) }));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("4 dependencies: 4 allow-listed, 0 with a decision");
  });
  it("fails an unlisted dependency without a recorded decision, and names how to fix it", async () => {
    const result = await check(await project({ "package.json": pkg({ react: "^19", "left-pad": "^1" }) }));
    expect(result.code).toBe(1);
    expect(result.out).toContain("dependency 'left-pad' is not on the allow-list and has no recorded decision");
    expect(result.out).toContain("'Dependency: left-pad' and 'Reason: <why>'");
  });
  it("accepts the same dependency once a decision records a reason, including scoped names and several per file", async () => {
    const decision = "# 0002 Libraries\n\nDependency: @tanstack/react-query\nReason: catalogue requests need caching and cancellation that we would otherwise rewrite.\n\nDependency: zustand\nReason: small client store, 1 KB, no provider tree on low-memory devices.\n";
    const result = await check(await project({ "package.json": pkg({ react: "^19", "@tanstack/react-query": "^5", zustand: "^5" }), "docs/decisions/0002-libraries.md": decision }));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("2 with a decision");
  });
  it.each([
    ["a decision without a reason line", "Dependency: zustand\n", "'Dependency: zustand' has no 'Reason:' line"],
    ["a reason too short to be one", "Dependency: zustand\nReason: need it\n", "the reason for 'zustand' is too short"],
    ["a reason that belongs to the next dependency", "Dependency: zustand\nDependency: jotai\nReason: smaller than the alternatives for this catalogue.\n", "'Dependency: zustand' has no 'Reason:' line"],
  ])("does not count %s", async (_name, decision, expected) => {
    const result = await check(await project({ "package.json": pkg({ zustand: "^5" }), "docs/decisions/0003-store.md": decision }));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
    expect(result.out).toContain("dependency 'zustand' is not on the allow-list");
  });
  it("covers devDependencies and optionalDependencies too", async () => {
    const root = await project({ "package.json": JSON.stringify({ name: "x", devDependencies: { "left-pad": "1" }, optionalDependencies: { fsevents: "2" } }) });
    const result = await check(root);
    expect(result.out).toContain("'left-pad'");
    expect(result.out).toContain("'fsevents'");
  });
  it("fails a missing or malformed allow-list and an entry without a reason", async () => {
    expect((await check(await project({ "package.json": pkg({ react: "^19" }) }, false))).out).toContain("docs/ai/dependency-allowlist.json is missing");
    const bad = await check(await project({ "package.json": pkg({ react: "^19" }), "docs/ai/dependency-allowlist.json": JSON.stringify({ allow: [{ name: "react" }] }) }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("'react' needs a 'reason'");
  });
  it("fails a project without a readable package.json", async () => {
    const result = await check(await project({}));
    expect(result.code).toBe(1);
    expect(result.out).toContain("package.json is missing or not valid JSON");
  });
});

describe("the pack's allow-list and references", () => {
  it("allow-lists every tool the pack installs, and every entry has a reason", async () => {
    const pack = JSON.parse(await readFile("templates/react-ts-vite/pack.json", "utf8")) as { devDependencies: string[]; references: { skills: string[]; libraries: string[]; allowList: string } };
    const list = JSON.parse(await readFile(allowlist, "utf8")) as { allow: Array<{ name: string; reason: string }> };
    const names = new Set(list.allow.map(entry => entry.name));
    for (const spec of pack.devDependencies) expect(names.has(spec.replace(/^(@?[^@]+)@.*$/, "$1")), spec).toBe(true);
    expect(list.allow.every(entry => entry.reason.length >= 5)).toBe(true);
    expect(new Set(list.allow.map(entry => entry.name)).size).toBe(list.allow.length);
  });
  it("references only approved catalog skills and allow-listed libraries", async () => {
    const pack = JSON.parse(await readFile("templates/react-ts-vite/pack.json", "utf8")) as { references: { skills: string[]; libraries: string[]; allowList: string } };
    const catalog = loadCatalog(process.cwd());
    for (const id of pack.references.skills) expect(catalog.skills.map(skill => skill.id), id).toContain(id);
    const list = JSON.parse(await readFile(allowlist, "utf8")) as { allow: Array<{ name: string }> };
    for (const library of pack.references.libraries) expect(list.allow.map(entry => entry.name), library).toContain(library);
    await expect(readFile(path.join("templates/react-ts-vite", pack.references.allowList), "utf8")).resolves.toContain("allow");
  });
});
