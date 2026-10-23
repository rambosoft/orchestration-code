import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { historyFromJSON, historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import type { StageInput, StageOutput } from "../src/contracts.js";
import { projectWorkflow } from "../src/workflows.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/research-history.json", import.meta.url));

describe("workflow replay determinism", () => {
  it("replays a freshly recorded history and the committed fixture without non-determinism", async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `replay-${Date.now()}`;
    try {
      const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace, taskQueue, workflowsPath,
        activities: { executeStage: async (input: StageInput): Promise<StageOutput> => ({ stage: input.stage, ok: true, summary: `done ${input.stage}`, findings: [], artifactRefs: [], provider: "fake", durationMs: 0 }) } });
      const result = await worker.runUntil(environment.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: "replay-research", args: [{ runId: "r", taskId: "T", projectId: "p", profile: "research", prompt: "look", provider: "fake", projectRoot: ".", artifactsDir: "." }] }));
      expect(result.status).toBe("completed");
      const history = await environment.client.workflow.getHandle("replay-research").fetchHistory();
      await Worker.runReplayHistory({ workflowsPath }, history, "replay-research");
      // Regenerate deliberately with UPDATE_REPLAY_FIXTURE=1 after an intentional, patched() workflow change.
      if (process.env.UPDATE_REPLAY_FIXTURE === "1") await writeFile(fixture, historyToJSON(history));
      await Worker.runReplayHistory({ workflowsPath }, historyFromJSON(JSON.parse(await readFile(fixture, "utf8"))), "replay-research");
    } finally { await environment.teardown(); }
  }, 90_000);
});
