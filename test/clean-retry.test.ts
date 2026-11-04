import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

describe("clean retry of the implement stage", () => {
  it("attempt 2 resets and cleans the worktree before the provider runs and records a warning", async () => {
    const git = recorder(); const order: string[] = [];
    provider.run = async () => { order.push(`provider after ${git.calls.length} git calls`); return ok(); };
    const out = await attempt(2, async () => executeStage(await input({}), git.run)) as { metadata?: { warnings?: string[] } };
    expect(git.calls).toEqual([["reset", "--hard", "HEAD"], ["clean", "-fd"]]);
    expect(order).toEqual(["provider after 2 git calls"]);
    expect(out.metadata?.warnings).toContain("clean-retry: discarded the previous attempt's edits");
  });
  it("attempt 1 of implement, and attempt 2 of review, do not reset", async () => {
    provider.run = ok; const git = recorder();
    await attempt(1, async () => executeStage(await input({}), git.run));
    await attempt(2, async () => executeStage(await input({ stage: "review" }), git.run));
    expect(git.calls).toEqual([]);
  });
});

describe("implement errors", () => {
  const fail = async (message: string, overrides: Partial<StageInput> = {}) => {
    provider.run = async () => { throw new Error(message); };
    return attempt(1, async () => executeStage(await input(overrides))).then(() => undefined, (e: unknown) => e as Error);
  };
  it.each(["codex no progress for 300s", "claude SizeSuspected: edits keep growing"])("size-suspected %s is prefixed and not retried", async message => {
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
    const error = await fail("codex no progress for 300s", { stage: "review" });
    expect(error!.message.startsWith("codex no progress")).toBe(true);
    expect(error instanceof ApplicationFailure && error.nonRetryable).toBe(false);
  });
});
