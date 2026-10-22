/** Startup validation shared by the worker and the doctor: each returns an actionable message, or undefined when the value is fine. */
export function concurrencyError(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.ORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? undefined : `ORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY must be a positive integer, got '${raw}'`;
}

export function temporalAddressError(env: NodeJS.ProcessEnv): string | undefined {
  const address = env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  return /^[^:\s]+:\d+$/.test(address) ? undefined : `TEMPORAL_ADDRESS must be host:port, got '${address}'`;
}

export function workerEnvironmentErrors(env: NodeJS.ProcessEnv): string[] {
  return [concurrencyError(env), temporalAddressError(env)].filter((message): message is string => message !== undefined);
}
