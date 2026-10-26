import { describe, expect, it } from "vitest";
import { classifyFailure, isResumable, MAX_AUTO_RESUMES } from "../src/failure-class.js";

const kind = (input: Parameters<typeof classifyFailure>[0]) => classifyFailure(input).kind;

describe("classifyFailure", () => {
  it("treats the machine problems of the first Unity run as environment, to be healed and resumed", () => {
    for (const message of [
      "unity test failed: instances cannot open the same project",
      "Unity exited 198: No valid Unity Editor license found",
      "Gradle: ninja: build.ninja still dirty after 100 tries",
      "write failed: Filename too long",
      "ENOSPC: no space left on device",
      "Unity preflight failed: only 2.0 GB are free where the worktree lives",
      "Unity import of the isolated task worktree failed (editor 6000.3.11f1, exit 6)",
    ]) expect(classifyFailure({ message }), message).toMatchObject({ kind: "environment", action: "heal-and-resume" });
  });
  it("lets an environment cause inside a gate failure win over a code repair", () => {
    expect(kind({ stopReason: "verify_quality_gate_failed", findings: ["quality check failed: unity test", "instances cannot open the same project"] })).toBe("environment");
  });
  it("treats timeouts, lost connections and rate limits as transient and resumable", () => {
    for (const message of ["Activity failed after bounded retries: implement timed out after 7200000ms", "ECONNRESET while calling the bridge", "HTTP 429 rate limit", "503 service unavailable"]) expect(classifyFailure({ message }), message).toMatchObject({ kind: "transient", action: "resume" });
    expect(classifyFailure({ stopReason: "implement_activity_failed", message: "something went wrong" })).toMatchObject({ kind: "transient", action: "resume" });
  });
  it("asks for a code repair when a deterministic check failed on its own merits", () => {
    expect(classifyFailure({ message: "quality check failed: npm test", findings: ["1 test failed"] })).toMatchObject({ kind: "gate", action: "repair" });
    expect(classifyFailure({ stopReason: "verify_quality_gate_failed" }).kind).toBe("gate");
    expect(classifyFailure({ message: "quality check failed: acceptance-trace", findings: ["acceptance criteria without a test: T3-AC2"] }).kind).toBe("gate");
  });
  it("does not let output that merely mentions a timeout or a 503 turn a gate failure into a transient one", () => {
    expect(kind({ stopReason: "verify_quality_gate_failed", findings: ["FAIL retries after a 503 > it times out, timed out waiting"] })).toBe("gate");
  });
  it("escalates unusable model output, remaining review findings, approvals, credentials and budgets", () => {
    for (const input of [{ stopReason: "review_unparseable" }, { stopReason: "plan_output_invalid" }, { stopReason: "blocking_findings_remain_after_final_review" }] as const) expect(classifyFailure(input), JSON.stringify(input)).toMatchObject({ kind: "model", action: "escalate" });
    expect(classifyFailure({ stopReason: "external_or_approval_prerequisite" })).toMatchObject({ kind: "external", action: "escalate" });
    expect(classifyFailure({ message: "codex is not logged in" }).kind).toBe("external");
    expect(classifyFailure({ message: "TokenBudgetExceeded: 5000000 of 4000000" })).toMatchObject({ kind: "budget", action: "escalate" });
  });
  it("escalates what it does not recognise", () => {
    expect(classifyFailure({ message: "strange" })).toMatchObject({ kind: "unknown", action: "escalate" });
    expect(classifyFailure({})).toMatchObject({ kind: "unknown", action: "escalate" });
  });
  it("resumes only the transient and healable kinds, at most once per run", () => {
    expect(isResumable(classifyFailure({ message: "ETIMEDOUT" }))).toBe(true);
    expect(isResumable(classifyFailure({ message: "Filename too long" }))).toBe(true);
    expect(isResumable(classifyFailure({ message: "quality check failed: npm test" }))).toBe(false);
    expect(isResumable(classifyFailure({ stopReason: "review_unparseable" }))).toBe(false);
    expect(MAX_AUTO_RESUMES).toBe(1);
  });
});
