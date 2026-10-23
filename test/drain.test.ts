import { describe, expect, it } from "vitest";
import { formatDrain, waitForDrain } from "../src/drain.js";

function clock(activeSequence: string[][]) {
  let time = 0; let calls = 0;
  return {
    deps: { activeRuns: async () => activeSequence[Math.min(calls++, activeSequence.length - 1)]!, sleep: async (ms: number) => { time += ms; }, now: () => time },
    calls: () => calls,
  };
}

describe("waitForDrain", () => {
  it("returns immediately when nothing is running", async () => {
    const { deps } = clock([[]]);
    expect(await waitForDrain(deps, { waitMs: 0 })).toEqual({ drained: true, active: [], waitedMs: 0 });
  });
  it("refuses at once when runs are active and no wait is allowed", async () => {
    const { deps, calls } = clock([["wf-1"]]);
    const result = await waitForDrain(deps, { waitMs: 0 });
    expect(result).toMatchObject({ drained: false, active: ["wf-1"] });
    expect(calls()).toBe(1);
    expect(formatDrain(result)).toContain("refusing");
  });
  it("waits for a run to finish within the allowance", async () => {
    const { deps } = clock([["wf-1"], ["wf-1"], []]);
    const result = await waitForDrain(deps, { waitMs: 60_000, pollMs: 10_000 });
    expect(result).toEqual({ drained: true, active: [], waitedMs: 20_000 });
    expect(formatDrain(result)).toContain("drained");
  });
  it("refuses when a run outlasts the allowance", async () => {
    const { deps } = clock([["wf-1"]]);
    const result = await waitForDrain(deps, { waitMs: 30_000, pollMs: 10_000 });
    expect(result.drained).toBe(false);
    expect(result.waitedMs).toBe(30_000);
  });
});
