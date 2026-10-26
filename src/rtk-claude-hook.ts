// A PreToolUse hook for the Claude CLI that lets RTK shorten the output of build, test, version-control and listing commands, and nothing else. RTK's own hook (`rtk hook claude`) also rewrites file
// reads and searches into filtered forms; an agent that edits code needs exact text from those, so this wrapper asks RTK what it would rewrite (`rtk hook check`, a dry run) and only passes on the
// rewrites of commands whose output is noise by nature. RTK covers git, Maven, Gradle, pytest, Go, Cargo, dotnet, Vitest/Jest, tsc, npm/pnpm and lint, so this is not tied to one stack.
// It is handed to a run with `claude --settings` (src/providers.ts): nothing is written to the operator's global Claude configuration or to the repository.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The `rtk <word>` forms whose rewrite is accepted. Reads, searches, finds and file listings are deliberately absent. */
export const REWRITE_ALLOWED = new Set([
  "git", "mvn", "gradle", "gradlew", "pytest", "go", "cargo", "dotnet", "vitest", "jest", "tsc", "npm", "pnpm", "yarn", "lint", "prettier", "ctest", "next", "prisma", "format", "err",
]);

/** The rewritten command when every `rtk <word>` in it is allowed, else undefined (the original command runs untouched). */
export function acceptRewrite(original: string, rewritten: string | undefined): string | undefined {
  if (!rewritten || rewritten === original || /[\r\n]/.test(rewritten)) return undefined;
  const words = [...rewritten.matchAll(/\brtk\s+([A-Za-z][\w-]*)/g)].map(match => match[1]!);
  return words.length && words.every(word => REWRITE_ALLOWED.has(word)) ? rewritten : undefined;
}

export const hookJson = (command: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecisionReason: "RTK auto-rewrite (build, test and version-control commands only)", updatedInput: { command } } });

/** What `rtk hook check` says: the rewritten command, or undefined for "No rewrite for: ...". */
function askRtk(command: string): string | undefined {
  const result = spawnSync("rtk", ["hook", "check", command], { encoding: "utf8", timeout: 5000, windowsHide: true });
  const line = (result.stdout ?? "").split(/\r?\n/)[0]?.trim();
  return result.status === 0 && line && !/^No rewrite for:/i.test(line) ? line : undefined;
}

/** The hook's stdout for the JSON Claude sends on stdin: empty means "no change". Never throws: a hook problem must not stop the agent. */
export function runHook(stdin: string, check: (command: string) => string | undefined = askRtk): string {
  try {
    const payload = JSON.parse(stdin) as { tool_name?: string; tool_input?: { command?: unknown } };
    const command = payload.tool_input?.command;
    if (typeof command !== "string" || !command.trim() || !/^(Bash|PowerShell)$/.test(payload.tool_name ?? "")) return "";
    const accepted = acceptRewrite(command, check(command));
    return accepted ? hookJson(accepted) : "";
  } catch { return ""; }
}

/** The settings JSON for `claude --settings`: this hook on the Bash and PowerShell tools. */
export function claudeHookSettings(scriptPath: string, nodePath = process.execPath): string {
  const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: `${quote(nodePath)} ${quote(scriptPath)}` }] }] } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", chunk => chunks.push(chunk as Buffer));
  process.stdin.on("end", () => { const out = runHook(Buffer.concat(chunks).toString("utf8")); if (out) process.stdout.write(out); });
}
