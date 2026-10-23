import { readFile } from "node:fs/promises";
import { embedBootstrapForm } from "./bootstrap-form.js";
import { BootstrapFormSchema } from "./bootstrap-options.js";

// Operator CLI: does what the Paperclip wizard does (project, label, bootstrap task) through Paperclip's REST API, then follows the run through the bridge.
//   node dist/src/bootstrap-e2e.js examples/aurora-store.bootstrap.json [--approve]
// Needs PAPERCLIP_API_TOKEN and ORCHESTRATOR_API_TOKEN in the environment; neither is ever printed.
type Spec = { name: string; description: string; options?: Record<string, string | boolean>; repoName?: string; repoOwner?: string };
const paperclipUrl = (process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const bridgeUrl = (process.env.ORCHESTRATOR_BRIDGE_URL ?? "http://127.0.0.1:3101").replace(/\/$/, "");
const need = (name: string) => process.env[name] ?? (() => { throw new Error(`${name} must be set`); })();

async function call<T>(base: string, token: string, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function main() {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) throw new Error("usage: bootstrap-e2e <spec.json> [--approve]");
  const spec = JSON.parse(await readFile(file, "utf8")) as Spec;
  const paperclip = <T>(method: string, route: string, body?: unknown) => call<T>(paperclipUrl, need("PAPERCLIP_API_TOKEN"), method, route, body);
  const bridge = <T>(method: string, route: string, body?: unknown) => call<T>(bridgeUrl, need("ORCHESTRATOR_API_TOKEN"), method, route, body);

  const [company] = await paperclip<Array<{ id: string; name: string }>>("GET", "/api/companies");
  if (!company) throw new Error("no Paperclip company");
  const agents = await paperclip<Array<{ id: string; name: string; adapterType?: string }>>("GET", `/api/companies/${company.id}/agents`);
  const agent = agents.find(item => item.adapterType === "temporal_orchestrator");
  if (!agent) throw new Error("no agent with the temporal_orchestrator adapter in the company");
  const project = await paperclip<{ id: string }>("POST", `/api/companies/${company.id}/projects`, { name: spec.name, description: spec.description.slice(0, 4000), status: "in_progress" });
  const labels = await paperclip<Array<{ id: string; name: string }>>("GET", `/api/companies/${company.id}/labels`);
  const labelId = labels.find(label => label.name.toLowerCase() === "type:bootstrap")?.id ?? (await paperclip<{ id: string }>("POST", `/api/companies/${company.id}/labels`, { name: "type:bootstrap", color: "#8b5cf6" })).id;
  const form = BootstrapFormSchema.parse({ name: spec.name, description: spec.description, options: spec.options ?? {}, ...(spec.repoName ? { repoName: spec.repoName } : {}), ...(spec.repoOwner ? { repoOwner: spec.repoOwner } : {}), paperclip: { companyId: company.id, projectId: project.id, agentId: agent.id } });
  const issue = await paperclip<{ id: string; identifier?: string }>("POST", `/api/companies/${company.id}/issues`, { projectId: project.id, title: `Bootstrap: ${spec.name}`, description: `Plan and create the project "${spec.name}".\n\n${spec.description}\n\n${embedBootstrapForm(form)}`, status: "todo", priority: "high", assigneeAgentId: agent.id, labelIds: [labelId] });
  console.log(JSON.stringify({ event: "created", company: company.name, projectId: project.id, issueId: issue.id, identifier: issue.identifier, agent: agent.name }));

  let workflowId: string | undefined; let lastStage = ""; let approved = false;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    workflowId ??= (await bridge<Array<{ workflowId: string }>>("GET", "/v1/runs")).filter(row => row.workflowId.startsWith(`pc-${issue.id}-`)).map(row => row.workflowId).sort().at(-1);
    if (!workflowId) continue;
    const run = await bridge<{ status: string; progress?: { currentStage: string | null }; bootstrap?: { phase: string; warnings: string[] }; result?: { status: string; message: string; bootstrap?: unknown } }>("GET", `/v1/runs/${encodeURIComponent(workflowId)}`);
    const stage = run.progress?.currentStage ?? run.bootstrap?.phase ?? run.status;
    if (stage !== lastStage) { lastStage = stage; console.log(JSON.stringify({ event: "stage", stage, status: run.status })); }
    if (run.bootstrap?.phase === "awaiting_approval" && !approved) {
      console.log(JSON.stringify({ event: "awaiting_approval", workflowId, warnings: run.bootstrap.warnings }));
      if (!flags.includes("--approve")) { console.log("Approve it in the project's Bootstrap tab, or re-run with --approve."); return; }
      await bridge("POST", `/v1/runs/${encodeURIComponent(workflowId)}/approve`); approved = true;
    }
    if (["COMPLETED", "FAILED", "CANCELED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(run.status)) { console.log(JSON.stringify({ event: "finished", ...run.result }, null, 2)); process.exitCode = run.result?.status === "completed" ? 0 : 1; return; }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
