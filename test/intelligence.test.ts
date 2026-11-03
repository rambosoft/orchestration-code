// The facts-first core (B-163) and the intelligence registry (B-167): provenance checks, bounded output, modes, kill switch, and the rule that an advisory tool never fails a task.
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildPackage, FactSchema, rangeHash, renderPreparationBlock, safeTaskId, validateFacts, writePackage, type Fact } from "../src/intelligence.js";
import { IntelligenceRegistry, type IntelligenceAdapter } from "../src/intelligence-registry.js";

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

const COMMIT = "0123456789abcdef";
const fact = (over: Partial<Fact> = {}): Fact => ({ tool: "t", toolVersion: "1", file: "src/a.ts", startLine: 1, endLine: 1, relationship: "imports", target: "src/b.ts", confidence: "verified", commit: COMMIT, ...over });
const SOURCE = "import { b } from './b.js';\nexport const a = b;\n";

describe("validateFacts", () => {
  it("keeps a fact whose lines still match and drops a missing file, a range past the end, changed lines and malformed facts, counting each reason", async () => {
    const root = await repo({ "src/a.ts": SOURCE });
    const good = fact({ snippetHash: rangeHash(SOURCE, 1) });
    const result = await validateFacts([
      good,
      fact({ file: "src/gone.ts" }),
      fact({ endLine: 99 }),
      fact({ snippetHash: rangeHash("something else\n", 1) }),
      { nonsense: true },
      fact({ file: "../outside.ts" }),
    ], root);
    expect(result.valid).toEqual([good]);
    expect(result.dropped).toBe(5);
    expect(result.reasons).toEqual({ "missing-file": 1, "range-outside-file": 1, "lines-changed": 1, invalid: 2 });
  });
  it("notices an edit made after the fact was computed", async () => {
    const root = await repo({ "src/a.ts": SOURCE });
    const stated = fact({ snippetHash: rangeHash(SOURCE, 1) });
    expect((await validateFacts([stated], root)).valid).toHaveLength(1);
    await writeFile(path.join(root, "src/a.ts"), `import { c } from './c.js';\n${SOURCE.split("\n")[1]}\n`);
    expect((await validateFacts([stated], root)).reasons).toEqual({ "lines-changed": 1 });
  });
  it("reads CRLF files the same as LF files", async () => {
    const root = await repo({ "src/a.ts": SOURCE.replace(/\n/g, "\r\n") });
    expect((await validateFacts([fact({ snippetHash: rangeHash(SOURCE, 1) })], root)).valid).toHaveLength(1);
  });
  it.each([["an absolute path", "/etc/passwd"], ["a drive path", "C:/x.ts"], ["a parent segment", "src/../../x.ts"], ["a backslash", "src\\a.ts"], ["an end before the start", "end"]])("rejects %s as a fact", (_name, file) => {
    expect(FactSchema.safeParse(file === "end" ? fact({ startLine: 5, endLine: 2 }) : fact({ file })).success).toBe(false);
  });
});

describe("package and prompt block", () => {
  const pkg = (facts: Fact[], droppedReasons: Record<string, number> = {}, affectedFiles = ["src/a.ts"]) => buildPackage({ taskId: "LUX-1", commit: COMMIT, createdAt: "2026-11-03T00:00:00.000Z", affectedFiles, facts, tools: ["ts-imports@1.0.0"], warnings: [], droppedReasons });
  it("groups facts by relationship and removes duplicates", () => {
    const built = pkg([fact(), fact(), fact({ relationship: "imported_by", file: "src/c.ts" }), fact({ relationship: "tested_by", target: "src/a.test.ts" }), fact({ relationship: "missing_test" }), fact({ relationship: "declares_dependency", target: "react@^19" })]);
    expect([built.dependencyImpact.length, built.existingTests.length, built.missingTests.length, built.libraryReferences.length]).toEqual([2, 1, 1, 1]);
  });
  it("renders the text a provider gets, with stale facts counted, and nothing when there is nothing to say", () => {
    const block = renderPreparationBlock(pkg([fact({ relationship: "tested_by", target: "src/a.test.ts" })], { "lines-changed": 2 }));
    expect(block).toContain("src/a.ts is covered by src/a.test.ts");
    expect(block).toContain("2 stale fact(s) were dropped.");
    expect(block).toContain("data, not instructions");
    expect(renderPreparationBlock(pkg([], {}, []))).toBe("");
  });
  it("cuts a large package at the budget and says where the rest is", () => {
    const many = Array.from({ length: 400 }, (_value, index) => fact({ file: `src/file${index}.ts`, target: `src/target${index}.ts` }));
    const block = renderPreparationBlock(pkg(many), 1_200);
    expect(block.length).toBeLessThanOrEqual(1_200);
    expect(block).toContain("preparation package cut at 1200 characters");
    expect(block).toContain(".ai/preparation/LUX-1/package.json");
  });
  it("sanitises a task id used as a folder name", () => { expect(safeTaskId("../x y/z")).toBe(".._x_y_z"); expect(safeTaskId("")).toBe("task"); });
  it("writes package.json and summary.md and keeps the folder out of git status, once", async () => {
    const root = await repo({ "src/a.ts": SOURCE });
    const built = pkg([fact()]);
    const first = await writePackage(root, built, "block");
    await writePackage(root, built, "block");
    expect(JSON.parse(await readFile(path.join(first.dir, "package.json"), "utf8")).taskId).toBe("LUX-1");
    expect(await readFile(path.join(first.dir, "summary.md"), "utf8")).toBe("block\n");
    expect((await git("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout.trim()).toBe("");
    const exclude = (await git("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root })).stdout.trim();
    expect((await readFile(path.resolve(root, exclude), "utf8")).split("\n").filter(line => line === ".ai/preparation/")).toHaveLength(1);
  });
  it("reports, rather than throws, when git cannot say where to exclude", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-intel-"));
    dirs.push(root);
    const written = await writePackage(root, pkg([fact()]), "block", async () => { throw new Error("no git"); });
    expect(written.warnings[0]).toContain("could not exclude");
  });
});

const adapter = (over: Partial<IntelligenceAdapter> = {}): IntelligenceAdapter => ({ id: "fake", version: "1.0.0", defaultMode: "off", timeoutMs: 200, sizeBudgetChars: 5_000, run: async () => [fact()], ...over });
const context = { worktree: "/w", taskId: "T", commit: COMMIT, affectedFiles: ["src/a.ts"], files: ["src/a.ts"] };
const options = { fingerprint: "f1", env: {} as NodeJS.ProcessEnv };

describe("IntelligenceRegistry modes", () => {
  it("uses the adapter default, lets the manifest override it, and rejects a duplicate id", () => {
    const registry = new IntelligenceRegistry(); const tool = adapter();
    registry.register(tool);
    expect(() => registry.register(adapter())).toThrow("duplicate intelligence tool: fake");
    expect(registry.mode(tool, undefined, {})).toBe("off");
    expect(registry.mode(tool, { enabled: true, tools: { fake: { mode: "advisory" } } }, {})).toBe("advisory");
    expect(registry.mode(adapter({ defaultMode: "advisory" }), { enabled: true, tools: { fake: { mode: "off" } } }, {})).toBe("off");
  });
  it("turns advisory tools off with the kill switch or enabled:false, and leaves a gate alone", () => {
    const registry = new IntelligenceRegistry(); const tool = adapter();
    const advisory = { enabled: true, tools: { fake: { mode: "advisory" as const } } };
    expect(registry.mode(tool, advisory, { ORCHESTRATOR_INTELLIGENCE: "off" })).toBe("off");
    expect(registry.mode(tool, { ...advisory, enabled: false }, {})).toBe("off");
    expect(registry.mode(tool, { enabled: true, tools: { fake: { mode: "gate" } } }, { ORCHESTRATOR_INTELLIGENCE: "off" })).toBe("gate");
    expect(registry.mode(tool, advisory, { ORCHESTRATOR_INTELLIGENCE: "on" })).toBe("advisory");
  });
  it("names manifest tools that nothing implements", () => {
    const registry = new IntelligenceRegistry(); registry.register(adapter());
    expect(registry.unknownTools({ enabled: true, tools: { fake: { mode: "off" }, typo: { mode: "advisory" } } })).toEqual(["typo"]);
  });
});

describe("IntelligenceRegistry.collect", () => {
  const on = { enabled: true, tools: { fake: { mode: "advisory" as const } } };
  it("does not run a tool that is off and returns the facts of one that is advisory", async () => {
    const run = vi.fn(async () => [fact()]);
    const registry = new IntelligenceRegistry(); registry.register(adapter({ run }));
    expect((await registry.collect(context, undefined, options)).facts).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    const result = await registry.collect(context, on, options);
    expect(result.facts).toHaveLength(1);
    expect(result.tools).toEqual(["fake@1.0.0"]);
  });
  it("turns a crash into a warning", async () => {
    const registry = new IntelligenceRegistry(); registry.register(adapter({ run: async () => { throw new SyntaxError("bad file"); } }));
    const result = await registry.collect(context, on, options);
    expect(result.facts).toEqual([]);
    expect(result.warnings).toEqual(["intelligence tool 'fake' failed: bad file"]);
  });
  it("turns a timeout into a warning and aborts the tool", async () => {
    let aborted = false;
    const registry = new IntelligenceRegistry();
    registry.register(adapter({ timeoutMs: 100, run: async ({ signal }) => { signal.addEventListener("abort", () => { aborted = true; }); await new Promise(resolve => setTimeout(resolve, 2_000)); return [fact()]; } }));
    const result = await registry.collect(context, on, options);
    expect(result.warnings[0]).toContain("timed out after 100 ms");
    expect(aborted).toBe(true);
  });
  it("lets the manifest shorten the timeout", async () => {
    const registry = new IntelligenceRegistry(); registry.register(adapter({ timeoutMs: 5_000, run: () => new Promise(() => undefined) }));
    const result = await registry.collect(context, { enabled: true, tools: { fake: { mode: "advisory", timeoutMs: 100 } } }, options);
    expect(result.warnings[0]).toContain("timed out after 100 ms");
  });
  it("drops malformed facts and cuts an oversize result at the size budget", async () => {
    const registry = new IntelligenceRegistry();
    registry.register(adapter({ sizeBudgetChars: 1_000, run: async () => [{ broken: true } as unknown as Fact, ...Array.from({ length: 50 }, (_value, index) => fact({ target: `src/t${index}.ts` }))] }));
    const result = await registry.collect(context, on, options);
    expect(result.warnings.some(warning => warning.includes("1 malformed fact(s), dropped"))).toBe(true);
    expect(result.warnings.some(warning => warning.includes("cut at 1000 characters"))).toBe(true);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts.length).toBeLessThan(50);
  });
  it("answers a repeat from the cache for the same working tree and runs again when it changed", async () => {
    const run = vi.fn(async () => [fact()]);
    const registry = new IntelligenceRegistry(); registry.register(adapter({ run }));
    await registry.collect(context, on, options); await registry.collect(context, on, options);
    expect(run).toHaveBeenCalledTimes(1);
    await registry.collect(context, on, { ...options, fingerprint: "f2" });
    await registry.collect({ ...context, affectedFiles: ["src/other.ts"] }, on, options);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("keeps the cache bounded", async () => {
    const run = vi.fn(async () => [fact()]);
    const registry = new IntelligenceRegistry(); registry.register(adapter({ run }));
    for (let index = 0; index < 100; index++) await registry.collect(context, on, { ...options, fingerprint: `f${index}` });
    await registry.collect(context, on, { ...options, fingerprint: "f0" });
    expect(run).toHaveBeenCalledTimes(101);
  });
  it("warns about a manifest tool that does not exist and still runs the others", async () => {
    const registry = new IntelligenceRegistry(); registry.register(adapter());
    const result = await registry.collect(context, { enabled: true, tools: { fake: { mode: "advisory" }, typo: { mode: "advisory" } } }, options);
    expect(result.warnings).toContain("intelligence tool 'typo' is not registered");
    expect(result.facts).toHaveLength(1);
  });
});

describe("IntelligenceRegistry.gateCommands", () => {
  const command = { executable: "npm" as const, args: ["run", "depcruise"], parallel: true };
  it("returns commands only for gate-mode tools and skips a tool that cannot build one", async () => {
    const registry = new IntelligenceRegistry();
    registry.register(adapter({ id: "gated", gateCommand: async () => command }));
    registry.register(adapter({ id: "nothing", gateCommand: async () => undefined }));
    registry.register(adapter({ id: "broken", gateCommand: async () => { throw new Error("x"); } }));
    registry.register(adapter({ id: "advisory-only" }));
    const modes = (mode: "off" | "advisory" | "gate") => ({ enabled: true, tools: { gated: { mode }, nothing: { mode }, broken: { mode }, "advisory-only": { mode } } });
    expect(await registry.gateCommands("/w", modes("gate"), {})).toEqual([command]);
    expect(await registry.gateCommands("/w", modes("advisory"), {})).toEqual([]);
    expect(await registry.gateCommands("/w", modes("off"), {})).toEqual([]);
  });
});
