// Pure (no Node built-ins) so workflow code and activities share one definition of "looks like a credential".
// publish-guard uses SECRET_CONTENT to block commits; research and context packs use redactSecrets so reports and model prompts never carry credentials.
export const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']/i,
];

const global = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
// Credential schemes come first so "Authorization: Bearer <token>" is redacted as a whole instead of leaving the token behind the scheme name.
const REDACTIONS = [...SECRET_CONTENT.map(global), /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\b\s*[:=]\s*\S+/gi];
/** Replaces anything that looks like a credential. Over-redaction is accepted; a leak is not. */
export function redactSecrets(value: string): string {
  return REDACTIONS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), value);
}
