import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { heartbeating } from "../src/process-control.js";

describe("heartbeating", () => {
  it("heartbeats on a timer while the activity runs and stops afterwards", async () => {
    const env = new MockActivityEnvironment();
    let beats = 0;
    env.on("heartbeat", () => { beats++; });
    const slow = heartbeating(async (value: number) => { await new Promise(resolve => setTimeout(resolve, 120)); return value * 2; }, 20);
    expect(await env.run(slow, 21)).toBe(42);
    expect(beats).toBeGreaterThanOrEqual(3);
    const after = beats;
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(beats).toBe(after);
  });
  it("passes errors through and still stops the timer", async () => {
    const env = new MockActivityEnvironment();
    let beats = 0; env.on("heartbeat", () => { beats++; });
    await expect(env.run(heartbeating(async () => { await new Promise(resolve => setTimeout(resolve, 50)); throw new Error("boom"); }, 20))).rejects.toThrow("boom");
    const after = beats;
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(beats).toBe(after);
  });
  it("is a no-op outside an activity", async () => {
    expect(await heartbeating(async () => "ok", 10)()).toBe("ok");
  });
});
