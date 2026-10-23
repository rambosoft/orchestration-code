import { pathToFileURL } from "node:url";

// Operator CLI: wires the Project Bootstrap plugin to the bridge, which is what its "New AI project" page needs before it can show anything.
//   npm run build && node dist/src/plugin-setup.js [--company <id>] [--bridge-url <url>]
// It stores ORCHESTRATOR_API_TOKEN as a Paperclip company secret (once) and saves the plugin settings with a reference to it. The token never leaves the two
// services and is never printed. Needs PAPERCLIP_API_TOKEN (an instance admin key) and ORCHESTRATOR_API_TOKEN in the environment.
export const PLUGIN_KEY = "orchestrator.project-bootstrap";
export const SECRET_KEY = "orchestrator-bridge-token";
export const DEFAULT_BRIDGE_URL = "http://orchestrator:3101";
export type SecretRow = { id: string; key?: string | null; name?: string | null };
export type SecretRefBinding = { type: "secret_ref"; secretId: string; version: "latest" };

export function findBridgeSecret(rows: SecretRow[]): SecretRow | undefined { return rows.find(row => row.key === SECRET_KEY || row.name === SECRET_KEY); }

/** The settings object the plugin stores. Anything already configured (such as a custom bridge URL) is kept unless the operator passed a new one. */
export function buildPluginConfig(existing: Record<string, unknown> | undefined, secretId: string, bridgeUrl?: string): { bridgeUrl: string; bridgeToken: SecretRefBinding } {
  const current = typeof existing?.bridgeUrl === "string" && existing.bridgeUrl.trim() ? existing.bridgeUrl.trim() : DEFAULT_BRIDGE_URL;
  return { ...existing, bridgeUrl: bridgeUrl?.trim() || current, bridgeToken: { type: "secret_ref", secretId, version: "latest" } };
}

export type Call = <T>(method: "GET" | "POST", route: string, body?: unknown) => Promise<T>;

/** Idempotent: a second run finds the secret and the settings already in place and rewrites the same values. */
export async function configurePlugin(paperclip: Call, input: { companyId?: string; token: string; bridgeUrl?: string }): Promise<{ companyId: string; companyName: string; secretCreated: boolean; bridgeUrl: string }> {
  const companies = await paperclip<Array<{ id: string; name: string }>>("GET", "/api/companies");
  const company = input.companyId ? companies.find(item => item.id === input.companyId) : companies[0];
  if (!company) throw new Error(input.companyId ? `company ${input.companyId} was not found` : "Paperclip has no company yet; create one first");
  if (!input.companyId && companies.length > 1) throw new Error(`Paperclip has ${companies.length} companies (${companies.map(item => item.name).join(", ")}); pass --company <id> to choose`);
  const secrets = await paperclip<SecretRow[]>("GET", `/api/companies/${company.id}/secrets`);
  let secret = findBridgeSecret(secrets); let secretCreated = false;
  if (!secret) {
    secret = await paperclip<SecretRow>("POST", `/api/companies/${company.id}/secrets`, { name: SECRET_KEY, key: SECRET_KEY, value: input.token, description: "ORCHESTRATOR_API_TOKEN for the Project Bootstrap plugin" });
    secretCreated = true;
  }
  const existing = await paperclip<{ configJson?: Record<string, unknown> } | null>("GET", `/api/plugins/${PLUGIN_KEY}/config?companyId=${company.id}`).catch(() => null);
  const configJson = buildPluginConfig(existing?.configJson, secret.id, input.bridgeUrl);
  await paperclip("POST", `/api/plugins/${PLUGIN_KEY}/config`, { companyId: company.id, configJson });
  return { companyId: company.id, companyName: company.name, secretCreated, bridgeUrl: configJson.bridgeUrl };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const need = (name: string) => process.env[name] || (() => { throw new Error(`${name} must be set in this shell`); })();
  const base = (process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
  const apiToken = need("PAPERCLIP_API_TOKEN"); const bridgeToken = need("ORCHESTRATOR_API_TOKEN");
  const call: Call = async <T,>(method: "GET" | "POST", route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${apiToken}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} returned ${response.status}: ${text.replace(bridgeToken, "[redacted]").slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
  const result = await configurePlugin(call, { companyId: option("--company"), token: bridgeToken, bridgeUrl: option("--bridge-url") });
  console.log(`Project Bootstrap is configured for company "${result.companyName}": bridge ${result.bridgeUrl}, token ${result.secretCreated ? "stored as a new company secret" : "taken from the existing company secret"}. Reload the New AI project page.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
