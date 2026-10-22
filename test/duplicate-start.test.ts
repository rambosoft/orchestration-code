import { describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { startOrAttach } from "../src/client.js";
import type { RunInput } from "../src/contracts.js";

describe("startOrAttach", () => {
  it("returns the live execution's runId for a duplicate start instead of a new unrelated one", async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    try {
      const base: RunInput = { runId: "first", taskId: "T-1", projectId: "p", profile: "research", prompt: "x", projectRoot: ".", artifactsDir: "." };
      const first = await startOrAttach(environment.client, "pc-T-1-1-a1", base);
      const second = await startOrAttach(environment.client, "pc-T-1-1-a1", { ...base, runId: "second" });
      expect(first.alreadyStarted).toBe(false);
      expect(second).toEqual({ runId: first.runId, alreadyStarted: true });
    } finally { await environment.teardown(); }
  }, 60_000);
});
