// The reuse index (B-137): existing shared code with a one-line purpose is put in front of the plan and implement stages, so a task reuses before it reinvents.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { intelligenceRegistry } from "../src/intelligence-registry.js";
import { prepareStageIntelligence } from "../src/intelligence-stage.js";

const git = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-reuse-")); dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  const run = (...args: string[]) => git("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  await run("init", "-q"); await run("add", "--all"); await run("commit", "-q", "-m", "init");
  return root;
}
const FILES = {
  "src/components/Button.tsx": "/**\n * A focusable button with the project's variants. Use it instead of a raw button.\n */\nexport function Button() { return null; }\nexport const buttonVariants = ['primary'];\n",
  "src/components/Button.test.tsx": "export const hidden = 1;\n",
  "src/components/index.ts": "export * from './Button.js';\n",
  "src/hooks/useFocus.ts": "export function useFocus() { return 1; }\n",
  "src/services/cache/README.md": "# cache\n\nBounded catalogue cache with eviction.\n\n## Interface\n",
  "src/services/cache/store.ts": "export class CacheStore {}\nexport type CacheKey = string;\n",
  "src/pages/home/index.tsx": "export default function Home() { return null; }\n",
  "src/types.d.ts": "export declare const nothing: number;\n",
};
const config = { enabled: true, tools: { "reuse-index": { mode: "advisory" as const } } };
const run = (root: string, prompt: string, over: Record<string, unknown> = {}) => prepareStageIntelligence({ stage: "plan", prompt, projectRoot: root, taskId: "LUX-1", intelligence: config, ...over }, { env: {} });

describe("the reuse index", () => {
  it("lists shared code with its purpose: a doc comment, or the folder's README", async () => {
    const result = await run(await repo(FILES), "Build the settings page.");
    const block = result!.block;
    expect(block).toContain("Existing shared code to reuse before writing new code (R-009):");
    expect(block).toContain("Button — A focusable button with the project's variants. (src/components/Button.tsx:4)");
    expect(block).toContain("buttonVariants (src/components/Button.tsx:5)");
    expect(block).toContain("useFocus (src/hooks/useFocus.ts:1)");
    expect(block).toContain("CacheStore — Bounded catalogue cache with eviction. (src/services/cache/store.ts:1)");
    expect(block).toContain("CacheKey — Bounded catalogue cache with eviction.");
  });
  it("leaves out tests, declaration files, index re-exports and pages", async () => {
    const block = (await run(await repo(FILES), "Build the settings page."))!.block;
    for (const hidden of ["hidden", "Button.test", "nothing", "src/components/index.ts", "Home"]) expect(block, hidden).not.toContain(hidden);
  });
  it("works before any file is named, which is when a new page is planned", async () => {
    const result = await run(await repo(FILES), "Add a brand new page for the profile menu.");
    expect(result!.block).not.toBe("");
    expect(result!.metadata.affected).toBe(0);
  });
  it("lists the code next to the files the task touches first", async () => {
    const many: Record<string, string> = { ...FILES };
    for (let index = 0; index < 40; index++) many[`src/components/Widget${String(index).padStart(2, "0")}.tsx`] = `export function Widget${index}() { return null; }\n`;
    const near = (await run(await repo(many), "Change src/services/cache/store.ts"))!.block;
    expect(near).toContain("CacheStore");
    const far = (await run(await repo(many), "Change src/components/Button.tsx"))!.block;
    expect(far).toContain("Widget00");
  });
  it("is bounded: a repository with hundreds of exports adds at most thirty rows and its own share of the block", async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 120; index++) many[`src/utils/helper${index}.ts`] = `export function helper${index}() { return ${index}; }\nexport function other${index}() { return 0; }\n`;
    const block = (await run(await repo(many), "Add something."))!.block;
    const rows = block.split("\n").filter(line => line.startsWith("- ") && line.includes("src/utils/"));
    expect(rows.length).toBeLessThanOrEqual(30);
    expect(block.length).toBeLessThanOrEqual(4_500);
  });
  it("is off by default and registered", async () => {
    expect(intelligenceRegistry.get("reuse-index")?.defaultMode).toBe("off");
    expect(await run(await repo(FILES), "Build the settings page.", { intelligence: undefined })).toBeUndefined();
  });
});
