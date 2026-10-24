import path from "node:path";

/**
 * Where task worktrees live: ORCHESTRATOR_WORKTREES_DIR, else <data dir>/worktrees. A Unity Android build fails when the project path is long (ninja and Gradle hit
 * path limits, found by the Unity spike), so a Unity worker sets a short folder such as C:w.
 */
export function worktreesDir(dataDir: string = process.env.ORCHESTRATOR_DATA_DIR ?? "data", environment: NodeJS.ProcessEnv = process.env): string {
  return environment.ORCHESTRATOR_WORKTREES_DIR ? path.resolve(environment.ORCHESTRATOR_WORKTREES_DIR) : path.resolve(dataDir, "worktrees");
}
const SENSITIVE_NAME = /(?:^(?:ORCHESTRATOR|PAPERCLIP|OPENROUTER)_)|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|DATABASE_URL|^AWS_|_PAT$/i;

/** Environment for child processes that run or may be influenced by model-written code: service tokens and credential-like variables are removed unless named in `keep`. */
export function childEnv(environment: NodeJS.ProcessEnv = process.env, keep: readonly string[] = []): NodeJS.ProcessEnv {
  const kept = new Set(keep.map(name => name.toUpperCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) if (!SENSITIVE_NAME.test(name) || kept.has(name.toUpperCase())) result[name] = value;
  return result;
}
