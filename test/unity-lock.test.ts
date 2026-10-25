import { describe, expect, it } from "vitest";
import { VisualConfigSchema } from "../src/contracts.js";
import { captureUnityScreenshots, waitForProjectUnlock } from "../src/unity.js";

describe("waiting for the Unity project lock", () => {
  const clock = () => { let now = 0; return { now: () => now, sleep: async (ms: number) => { now += ms; } }; };

  it("returns at once when nobody holds the lockfile, and when there is no lockfile", async () => {
    const time = clock();
    expect(await waitForProjectUnlock("C:\\w\\run-a", 90_000, { ...time, probe: async () => true })).toBe(0);
  });

  it("waits, polling every two seconds, until the previous Editor releases the lock", async () => {
    const time = clock(); const probes: string[] = [];
    let busyFor = 3;
    const waited = await waitForProjectUnlock("C:\\w\\run-a", 90_000, { ...time, probe: async lockfile => { probes.push(lockfile); return --busyFor < 0; } });
    expect(waited).toBe(6000);
    expect(probes).toHaveLength(4);
    expect(probes[0]).toContain("Temp");
    expect(probes[0]).toContain("UnityLockfile");
  });

  it("gives up at the timeout instead of blocking the run, and survives a probe that throws", async () => {
    const time = clock();
    expect(await waitForProjectUnlock("C:\\w\\run-a", 10_000, { ...time, probe: async () => false })).toBe(10_000);
    expect(await waitForProjectUnlock("C:\\w\\run-a", 10_000, { ...clock(), probe: async () => { throw new Error("denied"); } })).toBe(0);
  });

  it("checks the lock before the screenshot capture and reports a long wait", async () => {
    const config = VisualConfigSchema.parse({ engine: "unity", unityFilter: "CaptureTests" });
    const order: string[] = [];
    const result = await captureUnityScreenshots(config, { cwd: "C:\\w\\run-a", outDir: "C:\\w\\run-a-out" }, {
      stopEditors: async () => { order.push("stop"); return []; },
      waitUnlock: async () => { order.push("wait"); return 12_000; },
      run: async () => { order.push("run"); return { code: 0, output: "", stderr: "" }; },
    });
    expect(order).toEqual(["stop", "wait", "run"]);
    expect(result.warnings.join(" ")).toContain("waited 12s");
  });
});
