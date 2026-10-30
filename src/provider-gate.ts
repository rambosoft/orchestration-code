// Activity-side detection of a provider failure that is a pause, not a defect: a usage limit (with its reset time when the CLI says it) or a lost connection (ADR 0016).
// Detection reads what the CLIs print today, so it is a list of patterns that is easy to extend; the tests hold real wordings.
import type { PauseDetails } from "./pause-policy.js";

const QUOTA = /usage limit|limit reached|hit your (?:\w+ )?limit|reached your (?:\w+ )?limit|exceeded your (?:current )?quota|insufficient[_ ]quota|\bquota\b.{0,40}(?:exceeded|exhausted|reached)|rate[ -]?limit|too many requests|\b429\b|credit balance is too low|out of credits|overloaded_error|\b529\b/i;
const NETWORK = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|network (?:error|is unreachable)|fetch failed|getaddrinfo|unable to connect|connection (?:error|lost|reset|closed)|stream (?:disconnected|error)|error sending request|failed to (?:connect|lookup)|dns (?:error|failure)|\b50[234]\b|temporarily unavailable|service unavailable/i;
const AUTH = /\b(?:401|403)\b|unauthori[sz]ed|not logged in|please (?:run )?\/?login|invalid api key|authentication/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MINUTE = 60_000;

/** Milliseconds until the limit resets, from the wordings the Claude and Codex CLIs and HTTP providers use; undefined when the message gives no time. */
export function resetWaitMs(message: string, now: number): number | undefined {
  // Claude CLI (older): "Claude AI usage limit reached|1730000000" (epoch seconds).
  const epoch = /limit reached\|(\d{9,11})/i.exec(message);
  if (epoch) return Math.max(0, Number(epoch[1]) * 1000 - now);
  // "Retry-After: 120" / "retry after 120 seconds".
  const after = /retry[- ]after:?\s*(\d+)(?:\s*(?:s|sec|seconds))?\b/i.exec(message);
  if (after) return Number(after[1]) * 1000;
  // "try again in 4 days 3 hours 12 minutes", "resets in 2h 30m", "retry in 45 seconds".
  const relative = /(?:try again|retry|resets?|available)\s+(?:again\s+)?in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(message);
  if (relative) {
    let total = 0;
    for (const part of relative[1]!.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const unit = part[2]!.toLowerCase()[0]!;
      total += Number(part[1]) * ({ d: 86_400_000, h: 3_600_000, m: MINUTE, s: 1000 } as Record<string, number>)[unit]!;
    }
    if (total > 0) return total;
  }
  // "try again at Nov 3rd, 2026 9:05 PM" (worker local time).
  const dated = /(?:try again|resets?|available)\s+(?:again\s+)?(?:at|on)\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(message);
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.slice(0, 3).toLowerCase());
    if (month >= 0) {
      const base = new Date(now);
      let hour = Number(dated[4]); const meridiem = dated[6]?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12; if (meridiem === "am" && hour === 12) hour = 0;
      const target = new Date(Number(dated[3] ?? base.getFullYear()), month, Number(dated[2]), hour, Number(dated[5])).getTime();
      if (target > now) return target - now;
    }
  }
  // "resets 3pm", "resets at 3:30 pm": the next such time of day.
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(message);
  if (clock) {
    let hour = Number(clock[1]); const meridiem = clock[3]!.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12; if (meridiem === "am" && hour === 12) hour = 0;
    const next = new Date(now); next.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now;
  }
  return undefined;
}

/**
 * Whether a failed provider call should pause instead of fail. Authentication problems never pause (a person must log in). A call that timed out pauses only when the
 * connection is down (`online === false`); a timeout on a working connection is a slow task, not an outage.
 */
export function detectPause(message: string, options: { now: number; timedOut?: boolean; online?: boolean }): PauseDetails | undefined {
  if (AUTH.test(message) && !QUOTA.test(message)) return undefined;
  const reason = message.replace(/\s+/g, " ").slice(0, 300);
  if (QUOTA.test(message)) { const wait = resetWaitMs(message, options.now); return { kind: "quota", ...(wait !== undefined ? { waitMs: wait } : {}), reason }; }
  if (NETWORK.test(message) && options.online !== true) return { kind: "network", reason };
  if (options.timedOut && options.online === false) return { kind: "network", reason };
  return undefined;
}

const PROBE_URLS = ["https://api.anthropic.com", "https://api.openai.com", "https://github.com"];
/** True when any well-known endpoint answers (any HTTP status counts: the point is that the network works). */
export async function isOnline(fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<boolean> {
  const attempts = PROBE_URLS.map(url => fetcher(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) }).then(() => true, () => false));
  const results = await Promise.all(attempts);
  return results.some(Boolean);
}
