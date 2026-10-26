import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeStage } from "../src/activities.js";
import { ProjectManifestSchema } from "../src/contracts.js";
import { classifyFailure } from "../src/failure-class.js";
import { budgetStatus, cacheHitRatio, costUnits, formatUsageReport, normalizeUsage, runUsage, usageReport } from "../src/usage.js";

const claude = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 200_000, output_tokens: 500 };
const codex = { input_tokens: 10_000, cached_input_tokens: 8_000, output_tokens: 300 };
const openrouter = { prompt_tokens: 4375, completion_tokens: 2497, total_tokens: 6872, prompt_tokens_details: { cached_tokens: 195, cache_write_tokens: 0 } };
const stageFile = (usage: unknown, where: "usage" | "telemetry" = "usage") => JSON.stringify({ ok: true, metadata: where === "usage" ? { usage } : { telemetry: { usage } } });

describe("normalizeUsage", () => {
  it("reads the three provider shapes into one", () => {
    expect(normalizeUsage(claude)).toEqual({ input: 2, cacheRead: 200_000, cacheWrite: 1000, output: 500 });
    expect(normalizeUsage(codex)).toEqual({ input: 2000, cacheRead: 8000, cacheWrite: 0, output: 300 });
    expect(normalizeUsage(openrouter)).toEqual({ input: 4180, cacheRead: 195, cacheWrite: 0, output: 2497 });
    expect(normalizeUsage({ input_tokens: 5, output_tokens: 7 })).toEqual({ input: 5, cacheRead: 0, cacheWrite: 0, output: 7 });
  });
  it("returns nothing for payloads without counts, and ignores bad numbers", () => {
    for (const raw of [undefined, null, "x", 3, {}, { cost: 0 }]) expect(normalizeUsage(raw)).toBeUndefined();
    expect(normalizeUsage({ input_tokens: -4, output_tokens: Number.NaN })).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });
});

describe("costUnits and cache hit", () => {
  it("weighs cache reads low and output high, and reports the cache hit rate of the prompt", () => {
    expect(costUnits({ input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(1000);
    expect(costUnits({ input: 0, cacheRead: 10_000, cacheWrite: 0, output: 0 })).toBe(1000);
    expect(costUnits({ input: 0, cacheRead: 0, cacheWrite: 800, output: 0 })).toBe(1000);
    expect(costUnits({ input: 0, cacheRead: 0, cacheWrite: 0, output: 200 })).toBe(1000);
    expect(cacheHitRatio({ input: 100, cacheRead: 800, cacheWrite: 100, output: 5 })).toBeCloseTo(0.8);
    expect(cacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 0, output: 5 })).toBe(0);
  });
});

describe("budgetStatus", () => {
  const budget = { maxCostUnits: 1000, warnAt: 0.8 };
  it("is ok below the warning level, warns from it and stops at the limit, naming the way out", () => {
    expect(budgetStatus(799, budget).state).toBe("ok");
    expect(budgetStatus(800, budget)).toMatchObject({ state: "warn", message: expect.stringContaining("80%") });
    const exceeded = budgetStatus(1000, budget);
    expect(exceeded.state).toBe("exceeded");
    expect(exceeded.message).toContain("TokenBudgetExceeded");
    expect(exceeded.message).toContain("resume-run --budget");
    expect(budgetStatus(10 ** 9, undefined).state).toBe("ok");
  });
  it("is classified as a budget failure that a person decides, not resumed on its own", () => {
    expect(classifyFailure({ message: budgetStatus(2000, budget).message! })).toMatchObject({ kind: "budget", action: "escalate" });
  });
});

describe("run folders", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "orch-usage-")); dirs.push(dir); return dir; }
  it("adds up the stage results of a run by stage and ignores failure files, quality files and garbage", async () => {
    const dir = await root();
    await writeFile(path.join(dir, "implement-1.json"), stageFile(claude));
    await writeFile(path.join(dir, "implement-2.json"), stageFile(claude));
    await writeFile(path.join(dir, "plan-1.json"), stageFile(openrouter));
    await writeFile(path.join(dir, "review-1.json"), stageFile(codex, "telemetry"));
    await writeFile(path.join(dir, "implement-1-activity-1-failure.json"), stageFile(claude));
    await writeFile(path.join(dir, "quality-1.json"), JSON.stringify({ passed: true }));
    await writeFile(path.join(dir, "brief-1.json"), "{ not json");
    const usage = await runUsage(dir);
    expect(usage.stages).toBe(4);
    expect(usage.byStage.implement).toMatchObject({ count: 2, cacheRead: 400_000, output: 1000 });
    expect(usage.total.output).toBe(1000 + 2497 + 300);
    expect(usage.units).toBe(costUnits(usage.total));
  });
  it("is empty for a missing folder", async () => {
    expect(await runUsage(path.join(await root(), "nope"))).toMatchObject({ units: 0, stages: 0 });
  });
  it("reports one row per run, newest last, filtered by date, with a total line", async () => {
    const artifacts = await root();
    for (const [task, run] of [["task-aaaa-1111", "run-aaaa-1111"], ["task-bbbb-2222", "run-bbbb-2222"]] as const) {
      await mkdir(path.join(artifacts, task, run), { recursive: true });
      await writeFile(path.join(artifacts, task, run, "implement-1.json"), stageFile(claude));
    }
    await mkdir(path.join(artifacts, "task-cccc", "run-empty"), { recursive: true });
    const rows = await usageReport(artifacts);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.task).toBe("task-aaa");
    expect(await usageReport(artifacts, { since: "2999-01-01" })).toEqual([]);
    const text = formatUsageReport(rows);
    expect(text).toContain("cache hit 100%");
    expect(text).toContain("(2 runs)");
    expect(formatUsageReport([])).toBe("no recorded token usage");
  });
});

describe("budget in the manifest and the activity", () => {
  const manifest = { id: "game-one", name: "G", root: "g", defaultProfile: "implementation" };
  it("accepts an optional budget with a default warning level and rejects nonsense", () => {
    expect(ProjectManifestSchema.parse(manifest).budget).toBeUndefined();
    expect(ProjectManifestSchema.parse({ ...manifest, budget: { maxCostUnits: 5_000_000 } }).budget).toEqual({ maxCostUnits: 5_000_000, warnAt: 0.8 });
    expect(() => ProjectManifestSchema.parse({ ...manifest, budget: { maxCostUnits: 0 } })).toThrow();
    expect(() => ProjectManifestSchema.parse({ ...manifest, budget: { maxCostUnits: 10, warnAt: 5 } })).toThrow();
  });
  it("stops a model stage before the call once the run has spent its budget, and never for the fake provider", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orch-budget-")); const runDir = path.join(dir, "r"); await mkdir(runDir);
    try {
      await writeFile(path.join(runDir, "implement-1.json"), stageFile(claude));
      const base = { runId: "r", taskId: "t", projectId: "p", profile: "research", stage: "research" as const, prompt: "look", attempt: 1, plugins: [], projectRoot: dir, artifactsDir: dir, budget: { maxCostUnits: 1000, warnAt: 0.8 } };
      await expect(executeStage({ ...base, provider: "openrouter", model: "x" })).rejects.toMatchObject({ type: "TokenBudgetExceeded", nonRetryable: true });
      expect((await executeStage({ ...base, provider: "fake" })).ok).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
