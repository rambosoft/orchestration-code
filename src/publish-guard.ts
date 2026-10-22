import { stat } from "node:fs/promises";
import path from "node:path";
import { runCommand, type CommandRunner } from "./workspaces.js";

const MAX_FILE_BYTES = 5_000_000;
const SENSITIVE_PATH = [
  /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)node_modules\//,
];
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']/i,
];

/** Inspect staged changes before they are committed and pushed. Returns path-level violations; never echoes secret content. */
export async function findPublishViolations(worktree: string, runner: CommandRunner = runCommand): Promise<string[]> {
  const names = (await runner("git", ["diff", "--cached", "--name-only", "--diff-filter=AMR"], worktree)).split(/\r?\n/).filter(Boolean);
  const violations: string[] = [];
  for (const name of names) {
    if (SENSITIVE_PATH.some(pattern => pattern.test(name))) { violations.push(`${name}: credential or vendored-dependency path`); continue; }
    const size = await stat(path.join(worktree, name)).then(s => s.size, () => 0);
    if (size > MAX_FILE_BYTES) { violations.push(`${name}: file larger than ${MAX_FILE_BYTES} bytes`); continue; }
    const added = (await runner("git", ["diff", "--cached", "-U0", "--no-color", "--", name], worktree)).split(/\r?\n/).filter(line => line.startsWith("+") && !line.startsWith("+++"));
    if (added.some(line => SECRET_CONTENT.some(pattern => pattern.test(line)))) violations.push(`${name}: content matches a secret pattern`);
  }
  return violations;
}
