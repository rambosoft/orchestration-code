const SENSITIVE_NAME = /(?:^(?:ORCHESTRATOR|PAPERCLIP|OPENROUTER)_)|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|DATABASE_URL|^AWS_|_PAT$/i;

/** Environment for child processes that run or may be influenced by model-written code: service tokens and credential-like variables are removed unless named in `keep`. */
export function childEnv(environment: NodeJS.ProcessEnv = process.env, keep: readonly string[] = []): NodeJS.ProcessEnv {
  const kept = new Set(keep.map(name => name.toUpperCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) if (!SENSITIVE_NAME.test(name) || kept.has(name.toUpperCase())) result[name] = value;
  return result;
}
