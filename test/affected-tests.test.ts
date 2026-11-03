import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeStage } from "../src/activities.js";
import { CHANGED_TOKEN, commandHasChangedToken, expandChangedArgs } from "../src/affected-tests.js";
import { runCommand } from "../src/workspaces.js";

const dirs: string[] = [];
const temp = async (prefix: string) => { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("expandChangedArgs", () => {
  it("leaves arguments unchanged without the token", () => {
    const args = ["run", "test"];
    expect(expandChangedArgs(args, ["src/a.ts"]).args).toEqual(args);
    expect(commandHasChangedToken(args)).toBe(false);
  });
  it("expands changed sources in order and de-duplicates them", () => {
    expect(expandChangedArgs(["run", CHANGED_TOKEN], ["src/a.ts", "src/b.tsx", "src/a.ts"]).args).toEqual(["run", "src/a.ts", "src/b.tsx"]);
    expect(commandHasChangedToken([CHANGED_TOKEN])).toBe(true);
  });
  it("filters non-source, dash-leading, and unsafe names", () => {
    expect(expandChangedArgs([CHANGED_TOKEN], ["README.md", "-src/a.ts", "src/a.ts\n", "src/b.json", "src/c.vue", "src/d.css"]).args).toEqual(["src/b.json", "src/c.vue", "src/d.css"]);
    expect(expandChangedArgs([CHANGED_TOKEN], ["src/a\0.ts"]).skipped).toBe("none-changed");
  });
  it("skips when no changed source files remain", () => {
    expect(expandChangedArgs([CHANGED_TOKEN], ["README.md"])).toMatchObject({ skipped: "none-changed" });
  });
  it("skips when the de-duplicated list exceeds the limit", () => {
    expect(expandChangedArgs([CHANGED_TOKEN], ["a.ts", "b.ts", "c.ts"], 2).skipped).toBe("too-many");
  });
  it("replaces only a whole argument element", () => {
    expect(expandChangedArgs(["--include={changed}", CHANGED_TOKEN], ["a.ts"]).args).toEqual(["--include={changed}", "a.ts"]);
  });
});

describe("verify with changed-file arguments", () => {
  const base = { taskId: "t", projectId: "p", profile: "implementation", stage: "verify" as const, prompt: "task", attempt: 1, provider: "fake", plugins: [], verificationOnly: true };
  async function setup() {
    const root = await temp("orch-changed-repo-");
    await runCommand("git", ["init", "-b", "main"], root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/tracked.ts"), "export const value = 1;\n");
    await runCommand("git", ["add", "--all"], root);
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"], root);
    const outside = await temp("orch-changed-out-");
    const argvFile = path.join(outside, "argv.json");
    const script = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))";
    const command = (args: string[]) => ({ executable: "node" as const, args: ["-e", script, argvFile, ...args] });
    const verify = (runId: string, qualityCommands: Array<Record<string, unknown>>) => executeStage({ ...base, runId, projectRoot: root, artifactsDir: path.join(outside, "artifacts"), qualityCommands } as never);
    return { root, argvFile, command, verify };
  }
  it("passes modified tracked and new untracked source files to the command", async () => {
    const { root, argvFile, command, verify } = await setup();
    await writeFile(path.join(root, "src/tracked.ts"), "export const value = 2;\n");
    await writeFile(path.join(root, "src/new.tsx"), "export const New = () => null;\n");
    const result = await verify("run-changed", [command([CHANGED_TOKEN])]);
    expect(result.ok, result.summary).toBe(true);
    expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual(["src/tracked.ts", "src/new.tsx"]);
    const file = result.artifactRefs.find(ref => /quality/.test(ref));
    const recorded = JSON.parse(await readFile(file!, "utf8")) as { checks: Array<{ args: string[] }> };
    expect(recorded.checks[0]!.args.slice(-2)).toEqual(["src/tracked.ts", "src/new.tsx"]);
  }, 30_000);
  it("skips a token command on a clean tree with a clear warning and passing verify", async () => {
    const { argvFile, command, verify } = await setup();
    const result = await verify("run-clean", [command([CHANGED_TOKEN])]);
    expect(result.ok, result.summary).toBe(true);
    expect((result.metadata as { warnings: string[] }).warnings[0]).toContain("skipped, no changed source files");
    await expect(readFile(argvFile, "utf8")).rejects.toThrow();
  }, 30_000);
  it("runs commands without the token as before", async () => {
    const { argvFile, command, verify } = await setup();
    const result = await verify("run-no-token", [command(["src/manual.ts"])]);
    expect(result.ok, result.summary).toBe(true);
    expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual(["src/manual.ts"]);
  }, 30_000);
});
