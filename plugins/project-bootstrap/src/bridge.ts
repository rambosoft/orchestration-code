// Talking to the orchestrator bridge. Pure helpers around fetch so they are testable without the Paperclip host.
export type BridgeConfig = { url: string; token: string };
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type RunRow = { workflowId: string; status: string };

export async function bridgeCall<T>(config: BridgeConfig, fetcher: Fetcher, method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const response = await fetcher(`${config.url.replace(/\/$/, "")}${route}`, {
    method,
    headers: { authorization: `Bearer ${config.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try { detail = (JSON.parse(text) as { error?: string }).error ?? detail; } catch { /* plain text error */ }
    throw new Error(`orchestrator bridge ${method} ${route} returned ${response.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * The bridge names a workflow `pc-<taskId>-<revision>-a<attempt>`, so the runs of one Paperclip task share a prefix. A running one wins; otherwise the newest
 * (the revision is a timestamp, which sorts as text).
 */
export function pickRun(rows: RunRow[], issueId: string): RunRow | undefined {
  const mine = rows.filter(row => row.workflowId.startsWith(`pc-${issueId}-`));
  return mine.find(row => row.status === "RUNNING") ?? [...mine].sort((a, b) => b.workflowId.localeCompare(a.workflowId))[0];
}

/** Settings as stored by the plugin config form; the token is a secret reference resolved at call time. */
export function readBridgeSettings(config: Record<string, unknown>): { url: string; tokenRef: unknown } {
  const url = typeof config.bridgeUrl === "string" && config.bridgeUrl.trim() ? config.bridgeUrl.trim() : "http://orchestrator:3101";
  if (!config.bridgeToken) throw new Error("the Project Bootstrap plugin has no bridge token yet: open the plugin settings and choose the secret that holds ORCHESTRATOR_API_TOKEN");
  return { url, tokenRef: config.bridgeToken };
}
