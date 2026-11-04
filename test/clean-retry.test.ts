import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockActivityEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/activity";
import { executeStage } from "../src/activities.js";
import type { StageInput } from "../src/contracts.js";

const provider = vi.hoisted(() => ({ run: undefined as undefined | ((input: unknown) => Promise<unknown>) }));
vi.mock("../src/providers.js", () => ({ getProvider: () => ({ run: (input: unknown) => provider.run!(input) }) }));

const dirs: string[] = [];
async function input(overrides: Partial<StageInput>): Promise<StageInput> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-cr-")); dirs.push(dir);
  return { runId: "r", taskId: "t", projectId: "p", profile: "research", stage: "implement", prompt: "x", attempt: 1, provider: "fake", projectRoot: dir, artifactsDir: dir, plugins: [], ...overrides };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const ok = async () => ({ stage: "implement", ok: true, summary: "done", findings: [], artifactRefs: [], provider: "fake", durationMs: 1 });
function recorder() { const calls: string[][] = []; return { calls, run: async (_exe: string, args: string[]) => { calls.push(args); return { code: 0, output: "", stderr: "" }; } }; }
const attempt = (n: number, work: () => Promise<unknown>) => new MockActivityEnvironment({ attempt: n }).run(work);

// A real repository: HEAD is the base, the worktree carries what earlier stages wrote (OpenSpec output, a tracked edit) when implement starts.
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" }).toString();
async function repo(): Promise<{ root: string; artifacts: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-crr-")); const artifacts = await mkdtemp(path.join(os.tmpdir(), "orch-cra-")); dirs.push(root, artifacts);
  sh(root, "init", "-q"); await writeFile(path.join(root, "a.ts"), "base\n"); await writeFile(path.join(root, ".gitignore"), "node_modules/\n"); sh(root, "add", "-A"); sh(root, "commit", "-qm", "base");
  await mkdir(path.join(root, "openspec", "changes", "x"), { recursive: true }); await writeFile(path.join(root, "openspec", "changes", "x", "file"), "spec\n");
  await writeFile(path.join(root, "a.ts"), "before implement\n");
  return { root, artifacts };
}
const read = (file: string) => readFile(file, "utf8").then(text => text.replace(/\r\n/g, "\n"), () => undefined);

describe("clean retry of the main implement execution (real git)", () => {
  it("attempt 2 restores the pre-implement state: earlier stage output survives, the failed attempt's file is removed and its edit undone", async () => {
    const { root, artifacts } = await repo(); const seen: Record<string, string | undefined> = {};
    const base = { projectRoot: root, artifactsDir: artifacts, cleanRetry: true };
    provider.run = async () => {
      await writeFile(path.join(root, "a.ts"), "attempt 1 edit\n"); await mkdir(path.join(root, "src", "new"), { recursive: true }); await writeFile(path.join(root, "src", "new", "b.ts"), "attempt 1 file\n");
      await writeFile(path.join(root, "openspec", "changes", "x", "file"), "spec\n"); sh(root, "add", "-A");
      throw new Error("codex exited 1");
    };
    await attempt(1, async () => executeStage(await input(base))).catch(() => undefined);
    provider.run = async () => { for (const name of ["a.ts", "src/new/b.ts", "openspec/changes/x/file"]) seen[name] = await read(path.join(root, name)); return ok(); };
    const out = await attempt(2, async () => executeStage(await input(base))) as { metadata?: { warnings?: string[] } };
    expect(seen).toEqual({ "a.ts": "before implement\n", "src/new/b.ts": undefined, "openspec/changes/x/file": "spec\n" });
    expect(existsSync(path.join(root, "src"))).toBe(false);
    expect(out.metadata?.warnings).toContain("clean-retry: discarded the previous attempt's edits");
  });
  it("an implement call without cleanRetry (a repair round) never resets, even at attempt 2", async () => {
    const { root, artifacts } = await repo(); const git = recorder();
    await writeFile(path.join(root, "repair.ts"), "earlier implementation\n");
    provider.run = ok;
    const out = await attempt(2, async () => executeStage(await input({ projectRoot: root, artifactsDir: artifacts }), git.run)) as { metadata?: { warnings?: string[] } };
    expect(git.calls).toEqual([]);
    expect(await read(path.join(root, "a.ts"))).toBe("before implement\n"); expect(await read(path.join(root, "repair.ts"))).toBe("earlier implementation\n");
    expect(out.metadata?.warnings ?? []).not.toContain("clean-retry: discarded the previous attempt's edits");
  });
  it("a missing snapshot at attempt 2 resets nothing and says so", async () => {
    const { root, artifacts } = await repo();
    await writeFile(path.join(root, "left.ts"), "left by attempt 1\n");
    provider.run = ok;
    const out = await attempt(2, async () => executeStage(await input({ projectRoot: root, artifactsDir: artifacts, cleanRetry: true }))) as { metadata?: { warnings?: string[] } };
    expect(await read(path.join(root, "left.ts"))).toBe("left by attempt 1\n"); expect(await read(path.join(root, "a.ts"))).toBe("before implement\n");
    expect(out.metadata?.warnings).toContain("clean-retry skipped: no pre-implement snapshot");
  });
  it("review never snapshots or resets, even with cleanRetry at attempt 2", async () => {
    provider.run = ok; const git = recorder();
    await attempt(2, async () => executeStage(await input({ stage: "review", cleanRetry: true }), git.run));
    expect(git.calls).toEqual([]);
  });
});

describe("a failed worktree restore", () => {
  it.each([["reset -q", 0], ["reset --hard", 1], ["ls-files", 2], ["apply", 3]])("stops the retry when git %s exits non-zero", async (_failing, index) => {
    let called = false; const calls: string[][] = [];
    provider.run = async () => { called = true; return ok(); };
    const run = async (_exe: string, args: string[]) => { calls.push(args); return { code: calls.length - 1 === index ? 128 : 0, output: "", stderr: "fatal: index.lock exists" }; };
    const stage = await input({ cleanRetry: true });
    await mkdir(path.join(stage.artifactsDir, stage.runId), { recursive: true });
    await writeFile(path.join(stage.artifactsDir, stage.runId, "implement-1-snapshot.patch"), "diff --git a/a b/a\n"); await writeFile(path.join(stage.artifactsDir, stage.runId, "implement-1-snapshot.json"), JSON.stringify({ untracked: [] }));
    const error = await attempt(2, async () => executeStage(stage, run)).then(() => undefined, (e: unknown) => e);
    expect(called).toBe(false);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as ApplicationFailure).type).toBe("WorktreeResetError");
    expect((error as Error).message).toContain("implement: could not discard the previous attempt's edits");
    expect(calls.length).toBe(index + 1);
  });
});

describe("implement errors", () => {
  const fail = async (message: string, overrides: Partial<StageInput> = {}) => {
    provider.run = async () => { throw new Error(message); };
    return attempt(1, async () => executeStage(await input(overrides))).then(() => undefined, (e: unknown) => e as Error);
  };
  it.each(["codex no progress: no file change in 15 minutes", "claude SizeSuspected: edits keep growing"])("size-suspected %s is prefixed and not retried", async message => {
    const error = await fail(message);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as ApplicationFailure).type).toBe("SizeSuspected");
    expect(error!.message.startsWith(`implement: ${message}`)).toBe(true);
  });
  it("a plain provider failure stays retryable and is prefixed", async () => {
    const error = await fail("codex exited 1");
    expect(error!.message.startsWith("implement: codex exited 1")).toBe(true);
    expect(error instanceof ApplicationFailure && error.nonRetryable).toBe(false);
  });
  it("other stages are neither prefixed nor size-classified", async () => {
    const error = await fail("codex no progress: no file change in 15 minutes", { stage: "review" });
    expect(error!.message.startsWith("codex no progress")).toBe(true);
    expect(error instanceof ApplicationFailure && error.nonRetryable).toBe(false);
  });
});
