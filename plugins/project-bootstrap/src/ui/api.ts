import type { IssueRow } from "./types.js";

// The page runs inside the Paperclip app with the signed-in board user's session, so the project and its first task are created by that user through Paperclip's
// own API. Nothing here needs a token.
export async function paperclip<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: body !== undefined ? { "content-type": "application/json" } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const rows = <T,>(value: unknown, key: string): T[] => Array.isArray(value) ? value as T[] : Array.isArray((value as Record<string, unknown> | null)?.[key]) ? (value as Record<string, T[]>)[key]! : [];

export async function findOrchestratorAgents(companyId: string): Promise<Array<{ id: string; name: string }>> {
  const agents = rows<{ id: string; name: string; adapterType?: string; status?: string }>(await paperclip("GET", `/api/companies/${companyId}/agents`), "agents");
  return agents.filter(agent => agent.adapterType === "temporal_orchestrator" && agent.status !== "terminated").map(({ id, name }) => ({ id, name }));
}

export async function ensureLabel(companyId: string, name: string, color: string): Promise<string> {
  const labels = rows<{ id: string; name: string }>(await paperclip("GET", `/api/companies/${companyId}/labels`), "labels");
  const existing = labels.find(label => label.name.toLowerCase() === name.toLowerCase());
  return existing?.id ?? (await paperclip<{ id: string }>("POST", `/api/companies/${companyId}/labels`, { name, color })).id;
}

export async function findBootstrapIssue(companyId: string, projectId: string): Promise<IssueRow | undefined> {
  const issues = rows<IssueRow & { projectId?: string }>(await paperclip("GET", `/api/companies/${companyId}/issues?projectId=${encodeURIComponent(projectId)}&limit=200`), "issues").filter(issue => !issue.projectId || issue.projectId === projectId);
  return issues.find(issue => issue.labels?.some(label => label.name.toLowerCase() === "type:bootstrap")) ?? issues.find(issue => issue.title.startsWith("Bootstrap:"));
}
