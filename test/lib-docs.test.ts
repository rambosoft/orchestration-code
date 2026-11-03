// Version-matched library notes (B-165): only declared dependencies are requested, a cached note makes no network call, and a stage uses reviewed notes of the right major version only.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { declaredVersion, fetchDeclared, fetchLibNote, libFile, majorOf, parseLibNote, renderLibNote, type Fetcher, type LibNote } from "../src/lib-docs.js";
import { prepareStageIntelligence } from "../src/intelligence-stage.js";

const git = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function repo(files: Record<string, string>, commit = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-libs-")); dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  if (commit) { const run = (...args: string[]) => git("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root }); await run("init", "-q"); await run("add", "--all"); await run("commit", "-q", "-m", "init"); }
  return root;
}
const PACKAGE = JSON.stringify({ name: "x", dependencies: { react: "^19.3.1", "@tanstack/react-query": "~5.1.0" }, devDependencies: { vitest: "^4.1.0" } });

/** A fake Context7: records the URLs it was asked for and answers the search and context endpoints. */
function fakeContext7(over: { searchStatus?: number; contextStatus?: number; results?: unknown[]; info?: string[]; version?: string } = {}) {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetcher: Fetcher = async (url, sent) => {
    urls.push(url); headers.push(sent);
    const answer = (status: number, body: unknown, extra: Record<string, string> = {}) => ({ status, headers: { get: (name: string) => extra[name] ?? null }, json: async () => body });
    if (url.includes("/libs/search")) return over.searchStatus ? answer(over.searchStatus, {}, { "Retry-After": "30" }) : answer(200, { results: over.results ?? [{ id: "/facebook/react", title: "React" }] });
    return over.contextStatus ? answer(over.contextStatus, {}) : answer(200, { infoSnippets: (over.info ?? ["React 19 adds Actions and the use hook. Server Components are optional here."]).map(content => ({ content })), codeSnippets: [{ codeTitle: "useActionState", codeList: [{ code: "const [state, run] = useActionState(fn, null);" }] }], ...(over.version ? { version: { version: over.version } } : {}) });
  };
  return { fetcher, urls, headers };
}

describe("version helpers", () => {
  it.each([["^19.3.1", "19.3.1"], ["~5.1.0", "5.1.0"], [">=2 <3", "2.0.0"], ["4", "4.0.0"], ["latest", undefined], ["git+https://x", undefined]])("%s names %s", (range, expected) => { expect(declaredVersion(range)).toBe(expected); });
  it("reads the major version and maps scoped names to a file", () => {
    expect(majorOf("19.3.1")).toBe(19);
    expect(majorOf("v5.0.0")).toBe(5);
    expect(majorOf("next")).toBeUndefined();
    expect(libFile("@tanstack/react-query")).toBe("docs/ai/libs/tanstack__react-query.md");
    expect(libFile("react")).toBe("docs/ai/libs/react.md");
  });
  it("writes a note and reads it back", () => {
    const note: LibNote = { name: "react", version: "19.3.1", libraryId: "/facebook/react", fetchedAt: "2026-11-03", status: "unreviewed", summary: "React 19 adds Actions.", body: "Body text.\n\n### Example" };
    expect(parseLibNote(renderLibNote(note))).toEqual(note);
    expect(parseLibNote("# not a note")).toBeUndefined();
  });
});

describe("fetchLibNote", () => {
  it("asks for the declared version, sends only the name, the version and a generic question, and returns an unreviewed note", async () => {
    const server = fakeContext7();
    const note = await fetchLibNote("react", "^19.3.1", { fetcher: server.fetcher, apiKey: "ctx7sk-test", now: () => new Date("2026-11-03T10:00:00Z") });
    expect(note).toMatchObject({ name: "react", version: "19.3.1", libraryId: "/facebook/react", fetchedAt: "2026-11-03", status: "unreviewed" });
    expect(note.body).toContain("useActionState");
    expect(server.urls[0]).toContain("/api/v2/libs/search?libraryName=react");
    expect(server.urls[1]).toContain(`libraryId=${encodeURIComponent("/facebook/react/19.3.1")}`);
    expect(server.urls[1]).toContain("type=json");
    expect(server.headers[0]!.Authorization).toBe("Bearer ctx7sk-test");
    for (const url of server.urls) expect(url).not.toMatch(/src\/|secret|password/i);
  });
  it("records the version Context7 actually served", async () => {
    expect((await fetchLibNote("react", "^19.3.1", { fetcher: fakeContext7({ version: "19.2.0" }).fetcher })).version).toBe("19.2.0");
  });
  it("works without a key", async () => {
    const server = fakeContext7();
    await fetchLibNote("react", "^19.3.1", { fetcher: server.fetcher });
    expect(server.headers[0]!.Authorization).toBeUndefined();
  });
  it.each([
    ["a rate limit", { searchStatus: 429 }, "rate limit reached (retry after 30 seconds)"],
    ["no documentation", { searchStatus: 404 }, "no documentation for this library"],
    ["a server error", { contextStatus: 500 }, "answered 500"],
    ["no search match", { results: [] }, "found no library for 'react'"],
  ])("fails clearly on %s", async (_name, over, expected) => {
    const server = fakeContext7(over as never);
    await expect(fetchLibNote("react", "^19.3.1", { fetcher: server.fetcher })).rejects.toThrow(expected);
  });
  it("refuses a name that is not a package name and a range it cannot read", async () => {
    await expect(fetchLibNote("../etc/passwd", "1.0.0")).rejects.toThrow("is not a package name");
    await expect(fetchLibNote("react", "latest", { fetcher: fakeContext7().fetcher })).rejects.toThrow("cannot tell which version");
  });
});

describe("fetchDeclared", () => {
  it("requests only declared dependencies, writes unreviewed notes, and makes no network call for a cached one", async () => {
    const root = await repo({ "package.json": PACKAGE });
    const server = fakeContext7();
    const first = await fetchDeclared(root, ["react", "left-pad"], { fetcher: server.fetcher });
    expect(first.map(result => [result.name, result.outcome])).toEqual([["react", "written"], ["left-pad", "failed"]]);
    expect(first[1]!.detail).toContain("only declared dependencies are requested");
    const calls = server.urls.length;
    expect(calls).toBe(2);
    expect(parseLibNote(await readFile(path.join(root, libFile("react")), "utf8"))).toMatchObject({ name: "react", status: "unreviewed" });
    const second = await fetchDeclared(root, ["react"], { fetcher: server.fetcher });
    expect(second[0]!.outcome).toBe("cached");
    expect(server.urls.length).toBe(calls);
    expect((await fetchDeclared(root, ["react"], { fetcher: server.fetcher, force: true }))[0]!.outcome).toBe("written");
    expect(server.urls.length).toBe(calls + 2);
  });
  it("reports a failure per package and keeps going", async () => {
    const root = await repo({ "package.json": PACKAGE });
    const results = await fetchDeclared(root, ["react", "vitest"], { fetcher: fakeContext7({ searchStatus: 429 }).fetcher });
    expect(results.map(result => result.outcome)).toEqual(["failed", "failed"]);
  });
  it("handles a project without a package.json", async () => {
    expect((await fetchDeclared(await repo({ "a.txt": "x" }), ["react"], { fetcher: fakeContext7().fetcher }))[0]!.outcome).toBe("failed");
  });
});

describe("the lib-docs tool", () => {
  const note = (over: Partial<LibNote> = {}) => renderLibNote({ name: "react", version: "19.3.1", libraryId: "/facebook/react", fetchedAt: "2026-11-03", status: "reviewed", summary: "React 19 adds Actions and the use hook.", body: "Notes.", ...over });
  const config = { enabled: true, tools: { "lib-docs": { mode: "advisory" as const } } };
  const run = (root: string, prompt: string) => prepareStageIntelligence({ stage: "plan", prompt, projectRoot: root, taskId: "LUX-2", intelligence: config }, { env: {} });
  it("points the stage at a reviewed note for a library the task names or imports", async () => {
    const root = await repo({ "package.json": PACKAGE, [libFile("react")]: note(), "src/a.tsx": "import { useState } from 'react';\nexport const a = useState;\n", "src/b.ts": "export const b = 1;\n" });
    const byPrompt = await run(root, "Use react carefully in the new page.");
    expect(byPrompt!.block).toContain("react@19.3.1 notes in docs/ai/libs/react.md: React 19 adds Actions and the use hook.");
    const byImport = await run(root, "Change src/a.tsx");
    expect(byImport!.block).toContain("react@19.3.1 notes in docs/ai/libs/react.md");
  });
  it("does not use an unreviewed note, a note for another major version, or a library nothing names", async () => {
    const files = { "package.json": PACKAGE, "src/a.tsx": "export const a = 1;\n" };
    expect((await run(await repo({ ...files, [libFile("react")]: note({ status: "unreviewed" }) }), "Use react."))!.block).toBe("");
    expect((await run(await repo({ ...files, [libFile("react")]: note({ version: "18.2.0" }) }), "Use react."))!.block).toBe("");
    expect((await run(await repo({ ...files, [libFile("react")]: note() }), "Build a page without any library."))!.block).toBe("");
  });
  it("matches whole package names only", async () => {
    const root = await repo({ "package.json": PACKAGE, [libFile("react")]: note(), "src/a.tsx": "export const a = 1;\n" });
    expect((await run(root, "Add a react-router style page and a preact widget."))!.block).toBe("");
  });
});
