// One vocabulary for why a run or a gate failed, and what to do about it. The first Unity run showed that most failures were not about the code: licences, long paths, open Editors, timeouts.
// Repairing code for those is wasted work, and giving up on a transient one wastes the stages that already succeeded. Pure and deterministic (the workflow imports it).
export type FailureKind =
  | "environment" // the machine: licence, path length, disk, a locked project, an open Editor
  | "transient" // time or the network: a timeout, a rate limit, a lost connection
  | "gate" // a deterministic check failed because of the code (tests, build, hygiene, acceptance trace)
  | "model" // the model's answer could not be used or review findings remain after the last round
  | "external" // needs a person: an approval, a missing credential, a question
  | "budget" // a token budget was exceeded
  | "unknown";
export type FailureAction = "heal-and-resume" | "resume" | "repair" | "escalate";
export type FailureClass = { kind: FailureKind; action: FailureAction; reason: string };

const ENVIRONMENT: RegExp[] = [
  /instances cannot open the same project|another Unity instance is running|project is already open/i,
  /No valid Unity Editor license found|licen[cs]e.*(?:not found|invalid|expired)/i,
  /Filename too long|ninja: build\.ninja still dirty|path.{0,20}too long/i,
  /ENOSPC|no space left|disk.*full/i,
  /\bEBUSY\b|resource busy or locked|Temp[\\/]UnityLockfile/i,
  /Unity preflight failed|UnityPreflightError/i,
  /Unity import of the isolated task worktree failed/i,
];
const TRANSIENT: RegExp[] = [
  /timed out|ETIMEDOUT|deadline exceeded|startToClose|scheduleToClose/i,
  /ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network error|fetch failed/i,
  /\b429\b|rate.?limit|overloaded|\b50[234]\b|temporarily unavailable|service unavailable/i,
  /Activity failed after bounded retries|heartbeat timeout/i,
];
const EXTERNAL: RegExp[] = [/external prerequisite|operator action|approval/i, /needs_info/i, /\b(?:401|403)\b|unauthori[sz]ed|authentication|not logged in/i];
const BUDGET = /TokenBudgetExceeded|token budget/i;
const GATE: RegExp[] = [/quality check failed|quality gate failed|deterministic checks failed/i, /acceptance criteria without a test|acceptance-trace/i, /unity (?:test|build)|EditMode|PlayMode|exit \d+/i];

const first = (patterns: RegExp[], text: string): string | undefined => patterns.find(pattern => pattern.test(text))?.source;

/**
 * Classifies a failure from its message, the stop reason the workflow recorded and any finding text. Order matters: a licence or path problem inside a gate failure is an
 * environment problem (a code repair cannot fix it), and a timeout beats a generic gate failure.
 */
export function classifyFailure(input: { message?: string; stopReason?: string; findings?: string[] }): FailureClass {
  const text = [input.message ?? "", input.stopReason ?? "", ...(input.findings ?? [])].join("\n");
  if (BUDGET.test(text)) return { kind: "budget", action: "escalate", reason: "a token budget was exceeded; a person decides whether to raise it" };
  const environment = first(ENVIRONMENT, text);
  if (environment) return { kind: "environment", action: "heal-and-resume", reason: "the machine or the project lock is the problem, not the code; the preflight heals it when the run is resumed" };
  const stop = input.stopReason ?? "";
  if (/review_unparseable|_output_invalid|unclassified_review_failure|blocking_findings_remain|review_findings_unresolved/.test(stop)) return { kind: "model", action: "escalate", reason: "the model's answer was unusable or review findings remain after the last round" };
  if (EXTERNAL.some(pattern => pattern.test(text)) && !/quality check failed/i.test(text)) return { kind: "external", action: "escalate", reason: "a person has to supply an approval, a credential or an answer" };
  // A recorded gate stop reason is about the code: output that merely mentions a timeout or a 503 (a failing test about them) must not turn it into a transient failure.
  const gateStop = /quality_gate_failed|quality_check_failed|deterministic_checks_failed/.test(stop);
  if (!gateStop && first(TRANSIENT, text)) return { kind: "transient", action: "resume", reason: "a timeout or network problem; the stages that already succeeded are reused on resume" };
  if (gateStop || first(GATE, text)) return { kind: "gate", action: "repair", reason: "a deterministic check failed because of the code; one bounded repair pass can fix it" };
  if (/_activity_failed/.test(stop)) return { kind: "transient", action: "resume", reason: "an activity failed after its bounded retries without a code cause" };
  return { kind: "unknown", action: "escalate", reason: "no known pattern; a person should look at the failure" };
}

/** A resume is only attempted for these kinds, and at most `MAX_AUTO_RESUMES` times for the same run. */
export const MAX_AUTO_RESUMES = 1;
export const isResumable = (failure: FailureClass): boolean => failure.action === "resume" || failure.action === "heal-and-resume";
