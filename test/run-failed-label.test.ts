// A failed run must not look like a success on the board: the `run-failed` label is set on failure, cleared when a later run reports, idempotent, and never breaks a report.
import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/contracts.js";
import type { ReconcileDeps } from "../src/reconcile.js";
import { reportResultTo } from "../src/result-report.js";
import { RUN_FAILED_LABEL, syncRunFailedLabel } from "../src/run-failed-label.js";

type Call = { method: string; path: string; body?: unknown };
/** A fake Paperclip: one issue, a label list, and a log of every call. */
function fake(over: { labels?: Array<{ id: string; name: string }>; issueLabelIds?: string[]; comments?: unknown[]; fail?: string } = {}) {
  const calls: Call[] = []; const labels = [...(over.labels ?? [])]; let issueLabels = [...(over.issueLabelIds ?? [])];
  const paperclip = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    calls.push({ method, path, body });
    if (over.fail && `${method} ${path}`.includes(over.fail)) throw new Error("paperclip down");
    if (method === "GET" && path === "/api/issues/I1") return { id: "I1", companyId: "C1", labelIds: issueLabels };
    if (method === "GET" && path === "/api/companies/C1/labels") return labels;
    if (method === "POST" && path === "/api/companies/C1/labels") { const created = { id: "L-new", name: (body as { name: string }).name }; labels.push(created); return created; }
    if (method === "PATCH" && path === "/api/issues/I1") { const patch = body as { labelIds?: string[] }; if (patch.labelIds) issueLabels = patch.labelIds; return {}; }
    if (method === "GET" && path.startsWith("/api/issues/I1/comments")) return over.comments ?? [];
    return {};
  };
  const writes = () => calls.filter(call => call.method !== "GET");
  return { paperclip: paperclip as unknown as ReconcileDeps["paperclip"], calls, writes, labels: () => issueLabels };
}

describe("syncRunFailedLabel", () => {
  it("sets the label (creating it once), is idempotent, and clears it again without creating anything", async () => {
    const server = fake();
    await syncRunFailedLabel(server.paperclip, "I1", true);
    expect(server.writes().map(call => `${call.method} ${call.path}`)).toEqual(["POST /api/companies/C1/labels", "PATCH /api/issues/I1"]);
    expect(server.writes()[0]!.body).toMatchObject({ name: RUN_FAILED_LABEL });
    expect(server.labels()).toEqual(["L-new"]);
    await syncRunFailedLabel(server.paperclip, "I1", true);
    expect(server.writes()).toHaveLength(2);
    await syncRunFailedLabel(server.paperclip, "I1", false);
    expect(server.labels()).toEqual([]);
    expect(server.writes().filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("keeps the issue's other labels, and clearing an absent label writes nothing", async () => {
    const server = fake({ labels: [{ id: "L-x", name: "milestone" }, { id: "L-f", name: RUN_FAILED_LABEL }], issueLabelIds: ["L-x"] });
    await syncRunFailedLabel(server.paperclip, "I1", true);
    expect(server.labels()).toEqual(["L-x", "L-f"]);
    await syncRunFailedLabel(server.paperclip, "I1", false);
    expect(server.labels()).toEqual(["L-x"]);
    const clean = fake({ labels: [{ id: "L-f", name: RUN_FAILED_LABEL }] });
    await syncRunFailedLabel(clean.paperclip, "I1", false);
    expect(clean.writes()).toEqual([]);
  });
  it.each([["the issue cannot be read", "GET /api/issues/I1"], ["the labels cannot be listed", "/labels"], ["the write fails", "PATCH"]])("never throws when %s", async (_name, fail) => {
    await expect(syncRunFailedLabel(fake({ labels: [{ id: "L-f", name: RUN_FAILED_LABEL }], fail }).paperclip, "I1", true)).resolves.toBeUndefined();
    await expect(syncRunFailedLabel(undefined, "I1", true)).resolves.toBeUndefined();
  });
});

describe("a later report clears the label", () => {
  const done = { runId: "r", status: "completed", message: "ok", stages: [], artifactRefs: [], publish: { branch: "b", baseSha: "a", headSha: "h", prUrl: "https://github.com/o/r/pull/1", prBaseBranch: "main" } } as unknown as RunResult;
  it("when the result is reported, and when it was already reported by another path", async () => {
    const first = fake({ labels: [{ id: "L-f", name: RUN_FAILED_LABEL }], issueLabelIds: ["L-f"] });
    expect((await reportResultTo(first.paperclip, { workflowId: "wf-1", issueId: "I1", result: done })).reason).toBe("reported");
    expect(first.labels()).toEqual([]);
    const again = fake({ labels: [{ id: "L-f", name: RUN_FAILED_LABEL }], issueLabelIds: ["L-f"], comments: [{ body: "Temporal workflow `wf-1` finished with status **completed**." }] });
    expect((await reportResultTo(again.paperclip, { workflowId: "wf-1", issueId: "I1", result: done })).reason).toBe("already_reported");
    expect(again.labels()).toEqual([]);
  });
  it("leaves the label alone when the result decides nothing (a failure is not reported by the worker)", async () => {
    const server = fake({ labels: [{ id: "L-f", name: RUN_FAILED_LABEL }], issueLabelIds: ["L-f"] });
    expect((await reportResultTo(server.paperclip, { workflowId: "wf-2", issueId: "I1", result: { ...done, status: "failed", publish: undefined } as unknown as RunResult })).reason).toBe("no_status");
    expect(server.labels()).toEqual(["L-f"]);
  });
});
