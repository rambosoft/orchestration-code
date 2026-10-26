import { stat } from "node:fs/promises";
import path from "node:path";
import { detectStack, isGeneratedPath, type StackInfo } from "./stack-traits.js";
import { runCommand, type CommandRunner } from "./command.js";
import { SECRET_CONTENT } from "./redact.js";
export { SECRET_CONTENT };

const MAX_FILE_BYTES = 5_000_000;
export const SENSITIVE_PATH = [
  /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)(\.envrc|\.netrc|\.npmrc|credentials\.json)$/i,
  /(^|\/)node_modules\//,
];
/** The stacks a worktree holds (Unity, JVM, Node… each with its folder), detected from its files: the workflow input carries no stack. */
export const worktreeStack = (worktree: string): StackInfo => detectStack(worktree);
/**
 * Takes build output and caches that this run ADDED (against the base) out of the index, including files the agent committed itself, and returns their paths. Files the base already tracks are never touched.
 * Dropping them is cheaper than failing the publish at the very end of a task.
 */
export async function excludeGeneratedPaths(worktree: string, baseRef: string, stack: StackInfo, runner: CommandRunner = runCommand): Promise<string[]> {
  const added = (await runner("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=A", baseRef], worktree)).split("\0").filter(Boolean);
  const generated = added.filter(name => isGeneratedPath(stack, name));
  for (let from = 0; from < generated.length; from += 100) await runner("git", ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...generated.slice(from, from + 100)], worktree);
  return generated;
}
/** Inspect staged changes before they are committed and pushed. Returns path-level violations; never echoes secret content. */
export async function findPublishViolations(worktree: string, baseRef: string, runner: CommandRunner = runCommand): Promise<string[]> {
  const names = (await runner("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=AMR", baseRef], worktree)).split("\0").filter(Boolean);
  const violations: string[] = [];
  for (const name of names) {
    if (SENSITIVE_PATH.some(pattern => pattern.test(name))) { violations.push(`${name}: credential or vendored-dependency path`); continue; }
    const size = await stat(path.join(worktree, name)).then(s => s.size, () => 0);
    if (size > MAX_FILE_BYTES) { violations.push(`${name}: file larger than ${MAX_FILE_BYTES} bytes`); continue; }
    const added = (await runner("git", ["diff", "--cached", "-U0", "--no-color", baseRef, "--", name], worktree)).split(/\r?\n/).filter(line => line.startsWith("+") && !line.startsWith("+++"));
    if (added.some(line => SECRET_CONTENT.some(pattern => pattern.test(line)))) violations.push(`${name}: content matches a secret pattern`);
  }
  return violations;
}
