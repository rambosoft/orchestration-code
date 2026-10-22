import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { executeStage } from "../src/activities.js";
import type { StageInput } from "../src/contracts.js";

const dirs: string[] = [];
async function input(overrides: Partial<StageInput>): Promise<StageInput> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-nr-")); dirs.push(dir);
  return { runId: "r", taskId: "t", projectId: "p", profile: "research", stage: "research", prompt: "x", attempt: 1, provider: "fake", projectRoot: dir, artifactsDir: dir, plugins: [], ...overrides };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function failure(promise: Promise<unknown>): Promise<ApplicationFailure> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ApplicationFailure);
  return error as ApplicationFailure;
}

describe("non-retryable activity failures", () => {
  it("invalid provider results are not retried", async () => {
    const error = await failure(executeStage(await input({ prompt: "[INVALID_RESULT]" })));
    expect(error.nonRetryable).toBe(true);
  });
  it("missing required plugins are not retried", async () => {
    const error = await failure(executeStage(await input({ plugins: [{ id: "absent", required: true, enabled: true }] })));
    expect(error.nonRetryable).toBe(true);
  });
  it("provider configuration errors are not retried", async () => {
    const saved = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
    try {
      const error = await failure(executeStage(await input({ provider: "openrouter", model: "m/x" })));
      expect(error.nonRetryable).toBe(true);
      expect(error.type).toBe("ProviderConfigurationError");
    } finally { if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved; }
  });
  it("transient provider errors stay retryable", async () => {
    const error = await executeStage(await input({ prompt: "[TRANSIENT_ACTIVITY]" })).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof ApplicationFailure && error.nonRetryable).toBe(false);
  });
});
