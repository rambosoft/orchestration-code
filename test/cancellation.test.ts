import { describe, expect, it } from "vitest";
import { runCheck } from "../src/activities.js";

describe("runCheck cancellation", () => {
  it("kills a long-running child when the abort signal fires", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runCheck("node", ["-e", "setTimeout(() => {}, 60000)"], process.cwd(), 5000, controller.signal);
    setTimeout(() => controller.abort(), 500);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
  it("still returns normal results without a signal", async () => {
    const result = await runCheck("node", ["-e", "console.log('ok')"], process.cwd(), 5000, undefined);
    expect(result).toMatchObject({ code: 0 });
    expect(result.output.trim()).toBe("ok");
  });
});
