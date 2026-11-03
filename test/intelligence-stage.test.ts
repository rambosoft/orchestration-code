// The first intelligence tools and the stage glue (B-163, B-167): real git repositories, the preparation block a model stage receives, and the rule that nothing here can fail a stage.
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { IntelligenceConfigSchema, ProjectManifestSchema } from "../src/contracts.js";
import { rangeHash, type Fact } from "../src/intelligence.js";
import { resolveImport } from "../src/intelligence-adapters.js";
import { IntelligenceRegistry, intelligenceRegistry } from "../src/intelligence-registry.js";
import { intelligenceGates, prepareStageIntelligence } from "../src/intelligence-stage.js";

const git = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-intel-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  const run = (...args: string[]) => git("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  await run("init", "-q"); await run("add", "--all"); await run("commit", "-q", "-m", "init");
  return root;
}
const FILES = {
  "package.json": JSON.stringify({ name: "x", dependencies: { react: "^19.3.0" }, devDependencies: { vitest: "^4.0.0" }, scripts: { depcruise: "depcruise src" } }, null, 2),
  "src/a.ts": "import { b } from './b.js';\nimport { useState } from 'react';\nexport const a = b + useState;\n",
  "src/b.ts": "export const b = 1;\n",
  "src/c.ts": "import { a } from './a.js';\nexport const c = a;\n",
  "src/a.test.ts": "import { a } from './a.js';\nit('a', () => { expect(a).toBe(1); });\n",
};
const ALL = { enabled: true, tools: { "ts-imports": { mode: "advisory" as const }, "affected-tests": { mode: "advisory" as const }, "pkg-deps": { mode: "advisory" as const } } };
const task = (root: string, over: Record<string, unknown> = {}) => ({ stage: "implement", prompt: "Change src/a.ts to export two values.", projectRoot: root, taskId: "LUX-7", intelligence: ALL, ...over });

describe("resolveImport", () => {
  const known = new Set(["src/a.ts", "src/b.tsx", "src/lib/index.ts", "src/c.js"]);
  it.each([
    ["./b", "src/b.tsx"], ["./a.js", "src/a.ts"], ["./a", "src/a.ts"], ["./lib", "src/lib/index.ts"], ["./c.js", "src/c.js"], ["../src/a.ts", "src/a.ts"],
  ])("resolves %s", (specifier, expected) => { expect(resolveImport("src/x.ts", specifier, known)).toBe(expected); });
  it.each([["react"], ["@scope/pkg"], ["./missing"]])("does not resolve %s", specifier => { expect(resolveImport("src/x.ts", specifier, known)).toBeUndefined(); });
});

describe("prepareStageIntelligence", () => {
  it("states dependency impact, tests, missing tests and libraries for the files the prompt names, and writes the package outside git", async () => {
    const root = await repo(FILES);
    const result = await prepareStageIntelligence(task(root));
    expect(result?.warnings).toEqual([]);
    const block = result!.block;
    expect(block).toContain("Files this task touches or names:\n- src/a.ts");
    expect(block).toContain("src/a.ts:1 imports src/b.ts");
    expect(block).toContain("src/c.ts:1 imports src/a.ts (a dependent that must keep working)");
    expect(block).toContain("src/a.ts is covered by src/a.test.ts");
    expect(block).toContain("react@^19.3.0");
    expect(block).not.toContain("vitest");
    expect(result!.metadata).toMatchObject({ tools: ["ts-imports@1.0.0", "affected-tests@1.0.0", "pkg-deps@1.0.0"], affected: 1, droppedStale: 0, package: ".ai/preparation/LUX-7" });
    expect(JSON.parse(await readFile(path.join(root, ".ai/preparation/LUX-7/package.json"), "utf8")).affectedFiles).toEqual(["src/a.ts"]);
    expect((await git("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout.trim()).toBe("");
  });
  it("names a file without a test as inferred, and treats uncommitted work as affected", async () => {
    const root = await repo(FILES);
    await writeFile(path.join(root, "src/new.ts"), "import { b } from './b.js';\nexport const n = b;\n");
    const result = await prepareStageIntelligence(task(root, { prompt: "Add a new module." }));
    expect(result!.block).toContain("No test found (inferred):\n- src/new.ts");
    expect(result!.block).toContain("src/new.ts:1 imports src/b.ts");
  });
  it("sees an edit made after an earlier call", async () => {
    const root = await repo(FILES);
    await prepareStageIntelligence(task(root));
    await writeFile(path.join(root, "src/a.ts"), "import { c } from './c.js';\nexport const a = c;\n");
    const second = await prepareStageIntelligence(task(root));
    expect(second!.block).toContain("src/a.ts:1 imports src/c.ts");
    expect(second!.block).not.toContain("src/a.ts:1 imports src/b.ts");
  });
  it("gives the plan, implement and review stages the same block, and no other stage any", async () => {
    const root = await repo(FILES);
    const blocks = await Promise.all(["plan", "implement", "review"].map(async stage => (await prepareStageIntelligence(task(root, { stage })))!.block));
    expect(new Set(blocks).size).toBe(1);
    expect(blocks[0]).not.toBe("");
    for (const stage of ["verify", "brief", "analyze", "openspec"]) expect(await prepareStageIntelligence(task(root, { stage }))).toBeUndefined();
  });
  it("does nothing when no advisory tool is on, when the kill switch is set, or when the manifest disables intelligence", async () => {
    const root = await repo(FILES);
    expect(await prepareStageIntelligence(task(root, { intelligence: undefined }), { env: {} })).toBeUndefined();
    expect(await prepareStageIntelligence(task(root), { env: { ORCHESTRATOR_INTELLIGENCE: "off" } })).toBeUndefined();
    expect(await prepareStageIntelligence(task(root, { intelligence: { ...ALL, enabled: false } }), { env: {} })).toBeUndefined();
  });
  it("adds nothing when the prompt names no file of the repository and nothing changed", async () => {
    const root = await repo(FILES);
    const result = await prepareStageIntelligence(task(root, { prompt: "Improve things in src/ghost.ts" }));
    expect(result?.block).toBe("");
  });
  it("never fails the stage: a directory that is not a repository becomes a warning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-intel-"));
    dirs.push(root);
    const result = await prepareStageIntelligence(task(root));
    expect(result?.block).toBe("");
    expect(result?.warnings[0]).toContain("preparation package skipped");
    expect(result?.metadata.failed).toBe(true);
  });
  it("drops a fact whose lines changed and reports it, so a stale tool result never reaches a model", async () => {
    const root = await repo(FILES);
    const registry = new IntelligenceRegistry();
    const stale: Fact = { tool: "fake", toolVersion: "1", file: "src/a.ts", startLine: 1, endLine: 1, relationship: "imports", target: "src/old.ts", confidence: "verified", commit: "0123456789", snippetHash: rangeHash("not the line\n", 1) };
    const fresh: Fact = { ...stale, target: "src/b.ts", snippetHash: rangeHash(FILES["src/a.ts"], 1) };
    registry.register({ id: "fake", version: "1", defaultMode: "advisory", timeoutMs: 1_000, sizeBudgetChars: 5_000, run: async () => [stale, fresh] });
    const result = await prepareStageIntelligence(task(root, { intelligence: undefined }), { registry, env: {} });
    expect(result!.block).toContain("src/a.ts:1 imports src/b.ts");
    expect(result!.block).not.toContain("src/old.ts");
    expect(result!.block).toContain("1 stale fact(s) were dropped.");
    expect(result!.metadata.droppedStale).toBe(1);
  });
  it("honours the character budget from the manifest", async () => {
    const root = await repo(FILES);
    const result = await prepareStageIntelligence(task(root, { intelligence: { ...ALL, budgetChars: 500 } }));
    expect(result!.block.length).toBeLessThanOrEqual(500);
  });
});

describe("the built-in registry", () => {
  it("registers the four first tools, all off until a project turns them on", () => {
    expect(intelligenceRegistry.list().map(adapter => [adapter.id, adapter.defaultMode])).toEqual([["ts-imports", "off"], ["affected-tests", "off"], ["pkg-deps", "off"], ["depcruise", "off"]]);
  });
  it("adds the depcruise gate when the project asks for it and has the script, without duplicating a command the manifest already holds", async () => {
    const root = await repo(FILES);
    const gate = { enabled: true, tools: { depcruise: { mode: "gate" as const } } };
    expect(await intelligenceGates(root, [], gate, { env: {} })).toEqual([{ executable: "npm", args: ["run", "depcruise"], parallel: true }]);
    expect(await intelligenceGates(root, [{ executable: "npm", args: ["run", "depcruise"] }], gate, { env: {} })).toEqual([]);
    expect(await intelligenceGates(root, [], { enabled: true, tools: { depcruise: { mode: "advisory" } } }, { env: {} })).toEqual([]);
    const without = await repo({ "package.json": JSON.stringify({ name: "y", scripts: {} }) });
    expect(await intelligenceGates(without, [], gate, { env: {} })).toEqual([]);
  });
  it("keeps the gate when the advisory kill switch is set", async () => {
    const root = await repo(FILES);
    expect(await intelligenceGates(root, [], { enabled: true, tools: { depcruise: { mode: "gate" } } }, { env: { ORCHESTRATOR_INTELLIGENCE: "off" } })).toHaveLength(1);
  });
});

describe("manifest intelligence block", () => {
  it("accepts modes and limits, rejects an unknown mode and a bad tool id, and is optional", () => {
    expect(IntelligenceConfigSchema.parse({ tools: { "ts-imports": { mode: "advisory", timeoutMs: 5_000, sizeBudgetChars: 8_000 } } }).enabled).toBe(true);
    expect(IntelligenceConfigSchema.safeParse({ tools: { "ts-imports": { mode: "sometimes" } } }).success).toBe(false);
    expect(IntelligenceConfigSchema.safeParse({ tools: { "Bad Id": { mode: "off" } } }).success).toBe(false);
    expect(IntelligenceConfigSchema.safeParse({ budgetChars: 100 }).success).toBe(false);
  });
  it("is carried by a project manifest", async () => {
    const manifest = JSON.parse(await readFile("projects/luxus-app-react.json", "utf8"));
    expect(Object.keys(ProjectManifestSchema.parse(manifest).intelligence?.tools ?? {}).sort()).toEqual(["affected-tests", "pkg-deps", "ts-imports"]);
    expect(ProjectManifestSchema.parse({ ...manifest, intelligence: undefined }).intelligence).toBeUndefined();
    expect(ProjectManifestSchema.parse({ ...manifest, intelligence: { tools: { "ts-imports": { mode: "advisory" } } } }).intelligence?.tools["ts-imports"]?.mode).toBe("advisory");
  });
});
