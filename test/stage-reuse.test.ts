import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeStage } from "../src/activities.js";
import type { StageInput } from "../src/contracts.js";

const dirs: string[] = [];
async function input(overrides: Partial<StageInput> = {}): Promise<StageInput> {
  const dir = dirs[0] ?? await mkdtemp(path.join(os.tmpdir(), "orch-reuse-")); if (!dirs.length) dirs.push(dir);
  return { runId: "r", taskId: "t", projectId: "p", profile: "research", stage: "research", prompt: "look at it", attempt: 1, provider: "fake", projectRoot: dir, artifactsDir: dir, plugins: [], ...overrides };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("stage reuse after a lost response", () => {
  it("returns the recorded result for identical input without calling the provider again", async () => {
    const first = await executeStage(await input());
    expect(first.metadata?.reused).toBeUndefined();
    const second = await executeStage(await input());
    expect(second.metadata?.reused).toBe(true);
    expect(second.summary).toBe(first.summary);
  });
  it("runs again when the prompt changes", async () => {
    await executeStage(await input());
    const changed = await executeStage(await input({ prompt: "different" }));
    expect(changed.metadata?.reused).toBeUndefined();
  });
});
