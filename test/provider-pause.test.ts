// Provider limits and lost connections are pauses, not failures (ADR 0016). Unit tests hold the real wordings the CLIs print; workflow tests run the real workflow against stub activities on
// a time-skipping server, so a 3 hour wait costs nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { RunInput, StageInput, StageOutput } from "../src/contracts.js";
import { detectPause, resetWaitMs } from "../src/provider-gate.js";
import { MAX_PAUSE_TOTAL_MS, PROVIDER_PAUSE, pauseFrom, pauseWaitMs } from "../src/pause-policy.js";
import { classifyFailure } from "../src/failure-class.js";
import { cliFailureText, parseCodexTelemetry, stallLimitMs } from "../src/providers.js";
import { projectWorkflow } from "../src/workflows.js";

const NOW = new Date(2026, 9, 30, 10, 0, 0).getTime();
const HOUR = 3_600_000;

describe("detectPause", () => {
  it("reads a usage limit and its reset time from the wordings Codex, Claude and HTTP providers use", () => {
    expect(resetWaitMs("You've hit your usage limit. Try again in 4 days 3 hours 12 minutes.", NOW)).toBe(4 * 86_400_000 + 3 * HOUR + 12 * 60_000);
    expect(resetWaitMs("limit reached, resets in 2h 30m", NOW)).toBe(2.5 * HOUR);
    expect(resetWaitMs("Claude AI usage limit reached|" + Math.floor((NOW + 2 * HOUR) / 1000), NOW)).toBe(2 * HOUR);
    expect(resetWaitMs("429 Too Many Requests. Retry-After: 120", NOW)).toBe(120_000);
    expect(resetWaitMs("You've hit your limit · resets 3pm", NOW)).toBe(5 * HOUR);
    expect(resetWaitMs("you've hit your limit · resets 9am", NOW)).toBe(23 * HOUR);
    expect(resetWaitMs("Try again at Nov 3rd, 2026 9:05 PM", NOW)).toBe(new Date(2026, 10, 3, 21, 5).getTime() - NOW);
    expect(resetWaitMs("usage limit reached", NOW)).toBeUndefined();
  });
  it("pauses on a quota or a network failure and never on authentication", () => {
    expect(detectPause("codex exited 1: You've hit your usage limit. Try again in 2 hours.", { now: NOW })).toMatchObject({ kind: "quota", waitMs: 2 * HOUR });
    expect(detectPause("OpenRouter request failed (429 rate limit)", { now: NOW })).toMatchObject({ kind: "quota" });
    expect(detectPause("claude reported an error: Credit balance is too low", { now: NOW })).toMatchObject({ kind: "quota" });
    expect(detectPause("codex reported an error and no answer: stream disconnected before completion", { now: NOW })).toMatchObject({ kind: "network" });
    expect(detectPause("getaddrinfo ENOTFOUND api.openai.com", { now: NOW })).toMatchObject({ kind: "network" });
    expect(detectPause("codex exited 1: 401 Unauthorized, please run /login", { now: NOW })).toBeUndefined();
    expect(detectPause("claude exited 2: compile error in Game.cs", { now: NOW })).toBeUndefined();
  });
  it("treats a network-looking error as a defect when the connection is fine, and a timeout as an outage only when offline", () => {
    expect(detectPause("ECONNRESET", { now: NOW, online: true })).toBeUndefined();
    expect(detectPause("claude timed out after 900000ms", { now: NOW, timedOut: true, online: true })).toBeUndefined();
    expect(detectPause("claude timed out after 900000ms", { now: NOW, timedOut: true, online: false })).toMatchObject({ kind: "network" });
  });
});

describe("CLI failure text", () => {
  const warning = "Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n";
  it("drops the Claude stdin warning and reads the real error from the JSON answer, so a full disk is recognised instead of retried without end", () => {
    const answer = JSON.stringify({ type: "result", is_error: true, result: "ENOSPC: no space left on device, write" });
    const text = cliFailureText(warning, answer);
    expect(text).toBe("ENOSPC: no space left on device, write");
    expect(classifyFailure({ message: `claude exited 1: ${text}` })).toMatchObject({ kind: "environment", action: "heal-and-resume" });
    expect(cliFailureText(warning + "real stderr problem\n", answer)).toBe("real stderr problem");
    expect(cliFailureText(warning, "plain output tail")).toBe("plain output tail");
    expect(cliFailureText("", "", ["codex says: usage limit"])).toBe("codex says: usage limit");
  });
});

describe("pause policy", () => {
  it("waits as long as the provider said plus a margin (the caller enforces the cap), otherwise on a growing schedule", () => {
    expect(pauseWaitMs("quota", 2 * HOUR, 0)).toBe(2 * HOUR + 60_000);
    expect(pauseWaitMs("quota", 90 * HOUR, 0)).toBeGreaterThan(MAX_PAUSE_TOTAL_MS);
    expect([0, 1, 2, 9].map(index => pauseWaitMs("network", undefined, index))).toEqual([60_000, 120_000, 300_000, 1_800_000]);
    expect([0, 5].map(index => pauseWaitMs("quota", undefined, index))).toEqual([900_000, HOUR]);
  });
  it("finds the pause inside an activity failure chain", () => {
    const failure = ApplicationFailure.nonRetryable("paused", PROVIDER_PAUSE, { kind: "quota", waitMs: 5, reason: "r" });
    expect(pauseFrom(failure)).toEqual({ kind: "quota", waitMs: 5, reason: "r" });
    expect(pauseFrom({ type: "ActivityFailure", cause: failure })).toMatchObject({ kind: "quota" });
    expect(pauseFrom(new Error("plain"))).toBeUndefined();
  });
  it("sends a usage limit that outlasted the cap to a person and a long network outage to an automatic resume", () => {
    expect(classifyFailure({ message: "provider quota pause exceeded 24 hours in stage implement: usage limit" })).toMatchObject({ kind: "external", action: "escalate" });
    expect(classifyFailure({ message: "provider network pause exceeded 24 hours in stage review: ENOTFOUND" })).toMatchObject({ kind: "transient", action: "resume" });
  });
});

describe("CLI output", () => {
  it("reads Codex error events, which carry a usage limit with an empty answer", () => {
    const out = [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "error", message: "You've hit your usage limit." }), JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } })].join("\n");
    expect(parseCodexTelemetry(out).errors).toEqual(["You've hit your usage limit."]);
    expect(parseCodexTelemetry(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })).errors).toEqual([]);
  });
  it("gives build-running stages a longer silence limit and lets the environment change or disable it", () => {
    expect(stallLimitMs("review", {})).toBe(15 * 60_000);
    expect(stallLimitMs("implement", {})).toBe(45 * 60_000);
    expect(stallLimitMs("review", { ORCHESTRATOR_STALL_MINUTES: "0" })).toBe(0);
    expect(stallLimitMs("review", { ORCHESTRATOR_STALL_MINUTES: "bad" })).toBe(15 * 60_000);
  });
});

describe("workflow pause", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  async function run(script: Record<string, Array<ApplicationFailure | Error>>, online: boolean[] = [true], providerRouting: RunInput["providerRouting"] = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-pause-"));
    const worktree = path.join(root, "worktree"); await mkdir(worktree);
    const calls: string[] = []; const providers: string[] = []; let probes = 0;
    const activities = {
      checkDependencies: async () => undefined,
      prepareWorktree: async () => worktree,
      prepareProjectDependencies: async () => ({ installed: true, summary: "ready" }),
      probeConnectivity: async () => ({ online: online[Math.min(probes++, online.length - 1)]! }),
      executeStage: async (input: StageInput): Promise<StageOutput> => {
        calls.push(input.stage); providers.push(`${input.stage}:${input.provider}`);
        const next = script[input.stage]?.shift();
        if (next) throw next;
        return { stage: input.stage, ok: true, summary: input.stage === "review" ? "Review passed" : `Completed ${input.stage}`, findings: [], ...(input.stage === "review" ? { review: { verdict: "pass" as const, findings: [], notes: [] } } : {}), artifactRefs: [], provider: input.provider, durationMs: 0 };
      },
      collectWorktree: async () => path.join(root, "worktree.patch"),
      publishWorktree: async ({ repository }: { repository: { branch: string; baseSha: string; prBaseBranch: string } }) => ({ branch: repository.branch, baseSha: repository.baseSha, headSha: "b".repeat(40), prUrl: "https://github.com/o/r/pull/1", prBaseBranch: repository.prBaseBranch, draft: true }),
    };
    const taskQueue = `pause-${Math.random().toString(36).slice(2)}`;
    const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities });
    const input = {
      runId: `pause-${taskQueue}`, taskId: "PAUSE-1", taskRevision: "rev-1", projectId: "p", profile: "implementation", prompt: "Add a percentage button.", openSpec: false, provider: "fake", providerRouting,
      projectRoot: root, artifactsDir: path.join(root, "artifacts"), repository: { remote: "origin", targetBranch: "main", branch: "codex/pause-a1", baseSha: "a".repeat(40), prBaseBranch: "main", taskTitle: "Pause" },
      approval: false, plugins: [], qualityCommands: [{ executable: "npm", args: ["test"] }],
    } as unknown as RunInput;
    const result = await worker.runUntil(env.client.workflow.execute(projectWorkflow, { taskQueue, workflowId: `wf-${taskQueue}`, args: [input] }));
    return { result, calls, providers, probes: () => probes };
  }
  const quota = (waitMs?: number) => ApplicationFailure.nonRetryable("codex quota pause: usage limit", PROVIDER_PAUSE, { kind: "quota", ...(waitMs ? { waitMs } : {}), reason: "usage limit" });
  const network = () => ApplicationFailure.nonRetryable("claude network pause: ENOTFOUND", PROVIDER_PAUSE, { kind: "network", reason: "ENOTFOUND" });

  it("waits out a usage limit and runs the same stage again, then finishes the task", async () => {
    const { result, calls } = await run({ implement: [quota(3 * HOUR)] });
    expect(result.status, result.message).not.toBe("failed");
    expect(calls.filter(stage => stage === "implement")).toHaveLength(2);
    expect(calls.indexOf("implement")).toBeLessThan(calls.lastIndexOf("implement"));
  }, 60_000);
  it("waits for the connection to return before it spends another model call", async () => {
    const { result, calls, probes } = await run({ implement: [network()] }, [false, false, true]);
    expect(result.status, result.message).not.toBe("failed");
    expect(probes()).toBe(3);
    expect(calls.filter(stage => stage === "implement")).toHaveLength(2);
  }, 60_000);
  it("stops with a clear reason when a usage limit outlasts the longest wait a stage may take", async () => {
    const { result, calls } = await run({ implement: [quota(30 * HOUR)] });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("quota pause exceeded");
    expect(calls.filter(stage => stage === "implement")).toHaveLength(1);
  }, 60_000);
  it("moves a stage to its fallback route on a usage limit instead of waiting, and tells the user", async () => {
    const routing = { implement: { provider: "claude", fallback: [{ provider: "codex", model: "gpt-x" }] } } as RunInput["providerRouting"];
    const { result, providers } = await run({ implement: [quota(3 * HOUR)] }, [true], routing);
    expect(result.status, result.message).not.toBe("failed");
    expect(providers.filter(item => item.startsWith("implement:"))).toEqual(["implement:claude", "implement:codex"]);
    expect(result.message + JSON.stringify(result.metadata ?? {})).toContain("continues on codex");
  }, 60_000);
  it("waits as before when the route has no fallback, and never falls back on a lost connection", async () => {
    const plain = await run({ implement: [quota(2 * HOUR)] }, [true], { implement: { provider: "claude" } });
    expect(plain.providers.filter(item => item.startsWith("implement:"))).toEqual(["implement:claude", "implement:claude"]);
    const routing = { implement: { provider: "claude", fallback: [{ provider: "codex" }] } } as RunInput["providerRouting"];
    const offline = await run({ implement: [network()] }, [true], routing);
    expect(offline.providers.filter(item => item.startsWith("implement:"))).toEqual(["implement:claude", "implement:claude"]);
  }, 60_000);
  it("does not pause on an ordinary failure: it is not retried beyond the activity policy and the run fails", async () => {
    const { result, calls } = await run({ implement: [ApplicationFailure.nonRetryable("claude exited 2: compile error", "ProviderError")] });
    expect(result.status).toBe("failed");
    expect(calls.filter(stage => stage === "implement")).toHaveLength(1);
  }, 60_000);
});
