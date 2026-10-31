import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/contracts.js";
import { autoResumeDecision, formatFindings, latestRun, reconcile, resultComment, statusFor, type IssueRow, type ReconcileDeps, type RunDetail, type RunRow } from "../src/reconcile.js";

// The case that motivated it: the machine was off, Temporal finished the workflow, Paperclip marked the task blocked because the adapter never reported.
const publish = { branch: "codex/x-a1", baseSha: "a".repeat(40), headSha: "b".repeat(40), prUrl: "https://github.com/me/shop/pull/7", prBaseBranch: "codex/prev" };
const result = (overrides: Partial<RunResult> = {}): RunResult => ({ runId: "r", status: "needs_review", stages: [], artifactRefs: [], message: "quality gates passed; draft PR published with 1 unresolved review finding", publish, metadata: { review: { maxReviewRounds: 1, reviewCount: 1, repairCount: 0, findingsFixed: 0, reviewRuns: [], nonBlockingNotes: [], unresolvedFindings: [{ severity: "high", category: "functional", title: "Checkout total ignores shipping", evidence: "e", fixableInCode: true }] } }, ...overrides });

type World = { issues: Array<IssueRow & { identifier: string }>; runs: RunRow[]; paperclipRuns: Record<string, Array<{ status?: string; startedAt?: string; execution?: { phase?: string; cause?: string }; errorCode?: string }>>; details: Record<string, RunDetail>; comments: Record<string, string[]>; writes: Array<{ method: string; route: string; body?: Record<string, unknown> }> };
function world(overrides: Partial<World> = {}): { deps: ReconcileDeps; state: World } {
  const state: World = { issues: [], runs: [], paperclipRuns: {}, details: {}, comments: {}, writes: [], ...overrides };
  const deps: ReconcileDeps = {
    listRuns: async () => state.runs,
    inspect: async id => state.details[id] ?? { status: "FAILED" },
    paperclip: async <T,>(method: "GET" | "POST" | "PATCH", route: string, body?: unknown) => {
      if (method === "GET" && route === "/api/companies") return [{ id: "C1" }] as T;
      if (method === "GET" && route.startsWith("/api/companies/C1/issues")) return state.issues as T;
      const comments = /^\/api\/issues\/([^/?]+)\/comments/.exec(route);
      if (method === "GET" && comments) return (state.comments[comments[1]!] ?? []).map(text => ({ body: text })) as T;
      const issueRuns = /^\/api\/issues\/([^/?]+)\/runs$/.exec(route);
      if (method === "GET" && issueRuns) return (state.paperclipRuns[issueRuns[1]!] ?? []) as T;
      const issue = /^\/api\/issues\/([^/?]+)$/.exec(route);
      if (method === "GET" && issue) return state.issues.find(item => item.id === issue[1] || item.identifier === issue[1]) as T;
      state.writes.push({ method, route, ...(body ? { body: body as Record<string, unknown> } : {}) });
      return {} as T;
    },
  };
  return { deps, state };
}
const wf = "pc-I65-2026-10-23T17-52-34.015Z-a1";

describe("statusFor", () => {
  it("maps results to the status the adapter would set", () => {
    expect(statusFor(result({ status: "completed" }))).toBe("done");
    expect(statusFor(result({ status: "needs_review" }))).toBe("in_review");
    // Never "blocked": Paperclip wakes a blocked task whose blockers are all done at once, so a task that needs a person would be started again and again (ADR 0022).
    expect(statusFor(result({ status: "needs_info", publish: undefined }))).toBe("in_review");
    expect(statusFor(result({ status: "completed", publish: undefined, bootstrap: { projectRoot: "p", commit: "c", manifestPath: "m", template: "t", verified: true, issues: [], warnings: [] } }))).toBe("done");
    expect(statusFor(result({ status: "rejected", publish: undefined, metadata: { taskType: "bootstrap" } as RunResult["metadata"] }))).toBe("cancelled");
  });
  it("leaves the status alone when the result does not decide it", () => {
    expect(statusFor(result({ status: "failed", publish: undefined }))).toBeUndefined();
    expect(statusFor(result({ status: "completed", publish: undefined }))).toBeUndefined();
    expect(statusFor(undefined)).toBeUndefined();
  });
});

describe("resultComment", () => {
  it("carries the publication marker the next task's dependency check reads, the PR and the open findings", () => {
    const comment = resultComment(wf, "COMPLETED", result());
    expect(comment).toContain(`Temporal workflow \`${wf}\` finished with status **needs_review**`);
    expect(comment).toContain("Draft PR: https://github.com/me/shop/pull/7");
    expect(comment).toContain("Checkout total ignores shipping");
    expect(comment).toMatch(/<!-- orchestration-publish \{.*"headSha":"b{40}".*\} -->/);
    expect(comment).toContain("reconcile step");
  });
});

describe("reconcile", () => {
  it("reports a finished workflow to a blocked task: comment and status in one update", async () => {
    const { deps, state } = world({ issues: [{ id: "I65", identifier: "LOC-65", status: "blocked" }], runs: [{ workflowId: wf, status: "COMPLETED" }], details: { [wf]: { status: "COMPLETED", result: result() } } });
    const findings = await reconcile(deps, { apply: true });
    expect(findings).toMatchObject([{ issue: "LOC-65", action: "reported", status: "in_review" }]);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ method: "PATCH", route: "/api/issues/I65", body: { status: "in_review" } });
    expect(String(state.writes[0]!.body!.comment)).toContain("orchestration-publish");
  });
  it("changes nothing in a dry run, and says what it would do", async () => {
    const { deps, state } = world({ issues: [{ id: "I65", identifier: "LOC-65", status: "blocked" }], runs: [{ workflowId: wf, status: "COMPLETED" }], details: { [wf]: { status: "COMPLETED", result: result() } } });
    const findings = await reconcile(deps, { apply: false });
    expect(findings[0]).toMatchObject({ action: "would_report", status: "in_review" });
    expect(state.writes).toEqual([]);
    expect(formatFindings(findings, false)).toContain("--apply");
  });
  it("is idempotent: a result already reported is not reported again", async () => {
    const { deps, state } = world({ issues: [{ id: "I65", identifier: "LOC-65", status: "blocked" }], runs: [{ workflowId: wf, status: "COMPLETED" }], details: { [wf]: { status: "COMPLETED", result: result() } }, comments: { I65: [`Temporal workflow \`${wf}\` finished with status **needs_review**.`] } });
    expect((await reconcile(deps, { apply: true }))[0]).toMatchObject({ action: "already_reported" });
    expect(state.writes).toEqual([]);
  });
  it("leaves old history alone: only runs that ended within the window are considered", async () => {
    const now = new Date("2026-10-23T18:00:00Z");
    const old = { status: "COMPLETED", closeTime: "2026-10-01T10:00:00Z", result: result() };
    const { deps, state } = world({ issues: [{ id: "I65", identifier: "LOC-65", status: "blocked" }], runs: [{ workflowId: wf, status: "COMPLETED" }], details: { [wf]: old } });
    expect(await reconcile(deps, { apply: true, now })).toEqual([]);
    expect(state.writes).toEqual([]);
    state.details[wf] = { ...old, closeTime: "2026-10-23T17:00:00Z" };
    expect(await reconcile(deps, { apply: true, now })).toMatchObject([{ action: "reported" }]);
    state.details[wf] = { ...old, closeTime: "2026-10-01T10:00:00Z" };
    expect(await reconcile(deps, { apply: false, days: 30, now })).toMatchObject([{ action: "would_report" }]);
  });
  it("can be limited to one task, by identifier or id, and also catches a task parked in review whose result nobody reported", async () => {
    const { deps, state } = world({
      issues: [{ id: "I65", identifier: "LOC-65", status: "in_review" }, { id: "I1", identifier: "LOC-1", status: "blocked" }],
      runs: [{ workflowId: wf, status: "COMPLETED" }, { workflowId: "pc-I1-x-a1", status: "COMPLETED" }],
      details: { [wf]: { status: "COMPLETED", result: result() }, "pc-I1-x-a1": { status: "COMPLETED", result: result({ status: "failed", publish: undefined }) } },
    });
    expect((await reconcile(deps, { apply: true, only: "loc-65" })).map(finding => finding.issue)).toEqual(["LOC-65"]);
    expect(state.writes.map(write => write.route)).toEqual(["/api/issues/I65"]);
    expect((await reconcile(deps, { apply: false, only: "I1" })).map(finding => finding.issue)).toEqual(["LOC-1"]);
  });
  it("never touches a workflow that is still running", async () => {
    const { deps, state } = world({ issues: [{ id: "I65", identifier: "LOC-65", status: "in_progress" }], runs: [{ workflowId: wf, status: "RUNNING" }] });
    expect((await reconcile(deps, { apply: true }))[0]).toMatchObject({ action: "running" });
    expect(state.writes).toEqual([]);
  });
  it("retries a lost Paperclip dependency wake when every blocker is done and no Temporal run started", async () => {
    const { deps, state } = world({ issues: [{ id: "I92", identifier: "LOC-92", status: "blocked", assigneeAgentId: "A1", assigneeUserId: null, blockedBy: [{ id: "I91", status: "done" }] }], comments: { I91: [`<!-- orchestration-publish {"branch":"codex/loc-91","headSha":"${"b".repeat(40)}","prUrl":"https://github.com/me/game/pull/91"} -->`] } });
    const findings = await reconcile(deps, { apply: true });
    expect(findings).toMatchObject([{ issue: "LOC-92", action: "retried_dependency_wake", status: "blocked" }]);
    expect(state.writes).toMatchObject([{ method: "PATCH", route: "/api/issues/I92", body: { status: "blocked", blockedByIssueIds: ["I91"] } }]);
  });
  it("does not retry a dependency wake while any blocker is unresolved, or in dry-run mode", async () => {
    const { deps, state } = world({ issues: [{ id: "I92", identifier: "LOC-92", status: "blocked", assigneeAgentId: "A1", assigneeUserId: null, blockedBy: [{ id: "I91", status: "in_progress" }] }] });
    expect(await reconcile(deps, { apply: true })).toEqual([]);
    state.issues[0]!.blockedBy = [{ id: "I91", status: "done" }];
    state.comments.I91 = [`<!-- orchestration-publish {"branch":"codex/loc-91","headSha":"${"b".repeat(40)}","prUrl":"https://github.com/me/game/pull/91"} -->`];
    expect(await reconcile(deps, { apply: false })).toMatchObject([{ action: "would_retry_dependency_wake" }]);
    expect(state.writes).toEqual([]);
  });
  it("surfaces a ready dependency whose completed blocker has no orchestration publication", async () => {
    const { deps, state } = world({ issues: [{ id: "I92", identifier: "LOC-92", status: "blocked", assigneeAgentId: "A1", assigneeUserId: null, blockedBy: [{ id: "I91", status: "done" }] }] });
    expect(await reconcile(deps, { apply: true })).toMatchObject([{ action: "dependency_ready_missing_publication", issue: "LOC-92" }]);
    expect(state.writes).toEqual([]);
  });
  it("does not repeat dependency wakes while Paperclip requires execution reconciliation", async () => {
    const { deps, state } = world({
      issues: [{ id: "I92", identifier: "LOC-92", status: "blocked", assigneeAgentId: "A1", assigneeUserId: null, blockedBy: [{ id: "I91", status: "done" }] }],
      paperclipRuns: { I92: [{ status: "failed", errorCode: "adapter_failed", execution: { phase: "recovery_needed", cause: "legacy_execution_requires_reconciliation" } }] },
      comments: { I91: [`<!-- orchestration-publish {"branch":"codex/loc-91","headSha":"${"b".repeat(40)}","prUrl":"https://github.com/me/game/pull/91"} -->`] },
    });
    expect(await reconcile(deps, { apply: true })).toMatchObject([{ issue: "LOC-92", action: "dependency_ready_recovery_required" }]);
    expect(state.writes).toEqual([]);
  });
  it("tells the user to retry when the workflow itself failed, without inventing a result", async () => {
    const { deps, state } = world({ issues: [{ id: "I65", identifier: "LOC-65", status: "blocked" }], runs: [{ workflowId: wf, status: "FAILED" }], details: { [wf]: { status: "FAILED" } } });
    const [finding] = await reconcile(deps, { apply: true });
    expect(finding).toMatchObject({ action: "failed_run" });
    expect(finding!.detail).toContain("retry the task");
    expect(state.writes).toEqual([]);
  });
  it("posts only a comment when the result does not decide the status, and ignores tasks that are not stuck or have no run", async () => {
    const { deps, state } = world({
      issues: [{ id: "I1", identifier: "LOC-1", status: "blocked" }, { id: "I2", identifier: "LOC-2", status: "done" }, { id: "I3", identifier: "LOC-3", status: "blocked" }],
      runs: [{ workflowId: "pc-I1-x-a1", status: "COMPLETED" }, { workflowId: "pc-I2-x-a1", status: "COMPLETED" }],
      details: { "pc-I1-x-a1": { status: "COMPLETED", result: result({ status: "failed", publish: undefined, message: "review failed closed" }) } },
    });
    const findings = await reconcile(deps, { apply: true });
    expect(findings.map(finding => finding.issue)).toEqual(["LOC-1"]);
    expect(state.writes).toMatchObject([{ method: "POST", route: "/api/issues/I1/comments" }]);
  });
  it("picks the running workflow of a task, else the newest, and never another task's", () => {
    const rows = [{ workflowId: "pc-I1-2026-10-22-a1", status: "COMPLETED" }, { workflowId: "pc-I1-2026-10-23-a1", status: "FAILED" }, { workflowId: "pc-I2-2026-10-24-a1", status: "RUNNING" }];
    expect(latestRun(rows, "I1")?.workflowId).toBe("pc-I1-2026-10-23-a1");
    expect(latestRun(rows, "I3")).toBeUndefined();
    expect(formatFindings([], true)).toContain("nothing to reconcile");
  });
});

describe("automatic resume of a failed run", () => {
  const failed = (message: string, stopReason?: string, findings: string[] = []): RunResult => result({ status: "failed", publish: undefined, message, stages: [{ stage: "implement", ok: false, summary: message, findings, artifactRefs: [], provider: "claude", durationMs: 1 }], ...(stopReason ? { metadata: { review: { maxReviewRounds: 1, reviewCount: 0, repairCount: 0, findingsFixed: 0, reviewRuns: [], nonBlockingNotes: [], unresolvedFindings: [], stopReason } } } : {}) });
  const closed = "2026-10-23T17:30:00Z"; const now = new Date("2026-10-23T18:00:00Z");
  const setup = (run: RunResult, id = wf) => {
    const resumed: string[] = [];
    const base = world({ issues: [{ id: "I65", identifier: "LOC-65", status: "blocked" }], runs: [{ workflowId: id, status: "COMPLETED" }], details: { [id]: { status: "COMPLETED", closeTime: closed, result: run } } });
    base.deps.resume = async workflowId => { resumed.push(workflowId); return `${workflowId}-resume1`; };
    return { ...base, resumed };
  };

  it("resumes a run that failed for a transient reason, once, and posts nothing to the task", async () => {
    const { deps, state, resumed } = setup(failed("implement Activity failed after bounded retries: timed out after 7200000ms", "implement_activity_failed"));
    const findings = await reconcile(deps, { apply: true, autoResume: true, now });
    expect(findings).toMatchObject([{ issue: "LOC-65", action: "auto_resumed" }]);
    expect(findings[0]!.detail).toContain(`${wf}-resume1`);
    expect(resumed).toEqual([wf]);
    expect(state.writes).toEqual([]);
  });
  it("resumes a machine-caused failure too (the preflight heals it on the way)", async () => {
    const { deps, resumed } = setup(failed("quality check failed: unity test", "verify_quality_gate_failed", ["instances cannot open the same project"]));
    expect(await reconcile(deps, { apply: true, autoResume: true, now })).toMatchObject([{ action: "auto_resumed" }]);
    expect(resumed).toHaveLength(1);
  });
  it("never resumes or reposts a stale failure while Paperclip has an execution-recovery hold", async () => {
    const { deps, state, resumed } = setup(failed("ETIMEDOUT", "implement_activity_failed"));
    state.issues[0]!.executionBlocker = { recoveryActionId: "hold-1", runId: "paperclip-run-1", cause: "legacy_execution_requires_reconciliation" };
    expect(await reconcile(deps, { apply: true, autoResume: true, now })).toMatchObject([{ action: "recovery_required", status: "blocked" }]);
    expect(resumed).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it("does not revive a stale failed workflow or post a duplicate comment after the task reaches review", async () => {
    const { deps, state, resumed } = setup(failed("ETIMEDOUT", "implement_activity_failed"));
    state.issues[0]!.status = "in_review";
    expect(await reconcile(deps, { apply: true, autoResume: true, now })).toMatchObject([{ action: "stale_failure_suppressed", status: "in_review" }]);
    expect(resumed).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it("suppresses an older Temporal failure when a later Paperclip recovery run already succeeded", async () => {
    const { deps, state, resumed } = setup(failed("ETIMEDOUT", "implement_activity_failed"));
    state.paperclipRuns.I65 = [{ status: "succeeded", startedAt: "2026-10-23T17:45:00Z" }];
    expect(await reconcile(deps, { apply: true, autoResume: true, now })).toMatchObject([{ action: "stale_failure_suppressed" }]);
    expect(resumed).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it("only says what it would do in a dry run", async () => {
    const { deps, state, resumed } = setup(failed("ETIMEDOUT calling the provider", "implement_activity_failed"));
    expect(await reconcile(deps, { apply: false, autoResume: true, now })).toMatchObject([{ action: "would_resume" }]);
    expect(resumed).toEqual([]); expect(state.writes).toEqual([]);
  });
  it("does not resume when the option is off, and reports the failure as before", async () => {
    const { deps, state, resumed } = setup(failed("ETIMEDOUT calling the provider", "implement_activity_failed"));
    expect(await reconcile(deps, { apply: true, now })).toMatchObject([{ action: "reported" }]);
    expect(resumed).toEqual([]); expect(state.writes).toHaveLength(1);
  });
  it("resumes a code (gate) failure and unusable model output once, because the resume repairs and reviews again (ADR 0027)", async () => {
    for (const run of [failed("quality check failed: npm test", "verify_quality_gate_failed", ["1 test failed"]), failed("review output could not be read", "review_unparseable")]) {
      const { deps, resumed } = setup(run);
      expect((await reconcile(deps, { apply: true, autoResume: true, now }))[0]).toMatchObject({ action: "auto_resumed" });
      expect(resumed).toEqual([wf]);
    }
  });
  it("leaves failures that need a person alone: approvals, budgets, failures nobody can classify", async () => {
    for (const run of [failed("review stopped: external prerequisite requires operator action", "external_or_approval_prerequisite"), failed("token budget exceeded for the run", "budget_exceeded"), failed("something nobody has seen before", "mystery")]) {
      const { deps, resumed } = setup(run);
      expect((await reconcile(deps, { apply: true, autoResume: true, now }))[0]).toMatchObject({ action: "reported" });
      expect(resumed).toEqual([]);
    }
  });
  it("resumes a run only once: a failed resume is reported, not resumed again", async () => {
    const { deps, resumed } = setup(failed("ETIMEDOUT", "implement_activity_failed"), `${wf}-resume1`);
    expect((await reconcile(deps, { apply: true, autoResume: true, now }))[0]).toMatchObject({ action: "reported" });
    expect(resumed).toEqual([]);
  });
  it("does not revive an old failure", async () => {
    const { deps, state, resumed } = setup(failed("ETIMEDOUT", "implement_activity_failed"));
    state.details[wf] = { status: "COMPLETED", closeTime: "2026-10-23T09:00:00Z", result: state.details[wf]!.result! };
    expect((await reconcile(deps, { apply: true, autoResume: true, now }))[0]).toMatchObject({ action: "reported" });
    expect(resumed).toEqual([]);
  });
  it("reports a resume that could not be started instead of failing the whole cycle", async () => {
    const { deps } = setup(failed("ETIMEDOUT", "implement_activity_failed"));
    deps.resume = async () => { throw new Error("temporal unavailable"); };
    expect((await reconcile(deps, { apply: true, autoResume: true, now }))[0]).toMatchObject({ action: "failed_run" });
  });
  it("leaves the resumed run alone while it is running", async () => {
    const { deps, resumed } = setup(failed("ETIMEDOUT", "implement_activity_failed"));
    deps.listRuns = async () => [{ workflowId: wf, status: "COMPLETED" }, { workflowId: `${wf}-resume1`, status: "RUNNING" }];
    expect((await reconcile(deps, { apply: true, autoResume: true, now }))[0]).toMatchObject({ action: "running" });
    expect(resumed).toEqual([]);
  });
  it("resumes once more a failure that ended before the current worker started, because a deploy may have fixed it, and ignores the age window then (ADR 0027)", () => {
    const gate = failed("quality check failed: npm test", "verify_quality_gate_failed", ["1 test failed"]);
    const started = new Date("2026-10-23T17:50:00Z");
    expect(autoResumeDecision(`${wf}-resume1`, gate, closed, now)).toMatchObject({ resume: false });
    expect(autoResumeDecision(`${wf}-resume1`, gate, closed, now, undefined, started)).toMatchObject({ resume: true });
    expect(autoResumeDecision(`${wf}-resume2`, gate, closed, now, undefined, started)).toMatchObject({ resume: false });
    expect(autoResumeDecision(wf, gate, "2026-10-23T09:00:00Z", now, undefined, started)).toMatchObject({ resume: true });
    expect(autoResumeDecision(wf, gate, closed, now, undefined, new Date("2026-10-23T16:00:00Z"))).toMatchObject({ resume: true });
    expect(autoResumeDecision(`${wf}-resume1`, gate, closed, now, undefined, new Date("2026-10-23T16:00:00Z"))).toMatchObject({ resume: false });
    expect(autoResumeDecision(wf, failed("token budget exceeded for the run", "budget_exceeded"), closed, now, undefined, started)).toMatchObject({ resume: false });
  });
  it("autoResumeDecision names the reason", () => {
    expect(autoResumeDecision(wf, failed("ETIMEDOUT", "implement_activity_failed"), closed, now)).toMatchObject({ resume: true });
    expect(autoResumeDecision(wf, result(), closed, now)).toMatchObject({ resume: false, reason: "the run did not fail" });
  });
});
