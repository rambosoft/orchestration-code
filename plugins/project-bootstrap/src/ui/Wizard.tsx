import { useEffect, useMemo, useState } from "react";
import { useHostNavigation, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { ensureLabel, findOrchestratorAgents, paperclip } from "./api.js";
import { formProblems, projectSlug, taskDescription, type BootstrapForm } from "../form.js";
import { PLUGIN_ID, TAB_SLOT_ID } from "../manifest.js";
import type { Catalog, OptionDef, OptionValue, Resolved } from "./types.js";

const MULTILINE = new Set(["constraints", "out_of_scope"]);
const readView = (): boolean => { try { return window.localStorage.getItem("pb-advanced") === "1"; } catch { return false; } };
const saveView = (advanced: boolean) => { try { window.localStorage.setItem("pb-advanced", advanced ? "1" : "0"); } catch { /* private window */ } };
const describe = (value: OptionValue | undefined, option: OptionDef) => typeof value === "boolean" ? (value ? "on" : "off") : option.choices?.find(choice => choice.value === value)?.label ?? String(value ?? "");

function Chip({ provenance, maturityLabel, onReset }: { provenance: string | undefined; maturityLabel: string; onReset?: () => void }) {
  if (!provenance || provenance === "default") return <span className="pb-chip">default</span>;
  if (provenance === "preset") return <span className="pb-chip">from the {maturityLabel} preset</span>;
  if (provenance === "derived") return <span className="pb-chip">adjusted for your platform</span>;
  return <><span className="pb-chip user">set by you</span>{onReset ? <button type="button" className="pb-link" onClick={onReset}>reset</button> : null}</>;
}

function Control({ option, value, onChange }: { option: OptionDef; value: OptionValue | undefined; onChange: (value: OptionValue) => void }) {
  const id = `pb-${option.id}`;
  if (option.kind === "toggle") return <label className="pb-toggle"><input id={id} type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} /><span>{option.help}</span></label>;
  if (option.kind === "select") return <select id={id} value={String(value ?? "")} onChange={event => onChange(event.target.value)} aria-describedby={`${id}-help`}>{option.choices!.map(choice => <option key={choice.value} value={choice.value}>{choice.label}{choice.help ? ` - ${choice.help}` : ""}</option>)}</select>;
  return MULTILINE.has(option.id)
    ? <textarea id={id} value={String(value ?? "")} onChange={event => onChange(event.target.value)} aria-describedby={`${id}-help`} />
    : <input id={id} type="text" value={String(value ?? "")} onChange={event => onChange(event.target.value)} aria-describedby={`${id}-help`} placeholder="Let the stack stage recommend one" />;
}

export function Wizard({ context }: { context: PluginHostContext }) {
  const companyId = context.companyId ?? "";
  const nav = useHostNavigation();
  const catalog = usePluginData<Catalog>("catalog", { companyId });
  const resolveAction = usePluginAction("resolve");
  const [advanced, setAdvanced] = useState(readView);
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [touched, setTouched] = useState<Record<string, OptionValue>>({});
  const [repoName, setRepoName] = useState(""); const [repoOwner, setRepoOwner] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null); const [resolveError, setResolveError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }> | null>(null); const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false); const [step, setStep] = useState(""); const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const touchedKey = JSON.stringify(touched);
  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    resolveAction({ companyId, options: touched }).then(result => { if (alive) { setResolved(result as Resolved); setResolveError(null); } }).catch(failure => { if (alive) setResolveError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchedKey, companyId]);
  useEffect(() => {
    if (!companyId) return;
    findOrchestratorAgents(companyId).then(found => { setAgents(found); if (found[0]) setAgentId(found[0].id); }).catch(failure => { setAgents([]); setError(failure instanceof Error ? failure.message : String(failure)); });
  }, [companyId]);

  const options = catalog.data?.options ?? [];
  const maturity = useMemo(() => options.find(option => option.id === "maturity"), [options]);
  const maturityValue = String(resolved?.values.maturity ?? maturity?.default ?? "mvp");
  const maturityLabel = maturity?.choices?.find(choice => choice.value === maturityValue)?.label ?? maturityValue;
  const effects = catalog.data?.maturities.find(item => item.id === maturityValue)?.effects ?? [];
  const problems = formProblems({ name, description, repoName, repoOwner });
  const slug = projectSlug(repoName.trim() || name || "project");
  const setOption = (id: string, value: OptionValue) => setTouched(current => ({ ...current, [id]: value }));
  const reset = (id: string) => setTouched(current => { const next = { ...current }; delete next[id]; return next; });

  async function create() {
    setBusy(true); setError(null);
    try {
      setStep("Creating the Paperclip project");
      const id = projectId ?? (await paperclip<{ id: string }>("POST", `/api/companies/${companyId}/projects`, { name: name.trim(), description: description.trim().slice(0, 4000), status: "in_progress" })).id;
      setProjectId(id);
      setStep("Creating the planning task");
      const label = await ensureLabel(companyId, "type:bootstrap", "#8b5cf6");
      const form: BootstrapForm = { version: 1, name: name.trim(), description: description.trim(), options: touched, ...(repoName.trim() ? { repoName: repoName.trim() } : {}), ...(repoOwner.trim() ? { repoOwner: repoOwner.trim() } : {}), paperclip: { companyId, projectId: id, ...(agentId ? { agentId } : {}) } };
      await paperclip("POST", `/api/companies/${companyId}/issues`, { projectId: id, title: `Bootstrap: ${name.trim()}`, description: taskDescription(form), status: "todo", priority: "high", ...(agentId ? { assigneeAgentId: agentId } : {}), labelIds: [label] });
      nav.navigate(`/projects/${id}?tab=plugin:${PLUGIN_ID}:${TAB_SLOT_ID}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); setStep(""); }
  }

  if (!companyId) return <div className="pb"><p className="pb-note">Open a company first.</p></div>;
  if (catalog.error) return <div className="pb"><h1>New AI project</h1><p className="pb-note bad">{catalog.error.message}</p><p className="pb-help" style={{ marginTop: 8 }}>Check the plugin settings: the orchestrator bridge URL and the secret holding its token.</p></div>;
  if (!catalog.data) return <div className="pb"><h1>New AI project</h1><p className="pb-lead pb-spin">Loading the options…</p></div>;
  const noAgent = agents !== null && agents.length === 0;
  const visible = (option: OptionDef) => option.id !== "maturity" && (advanced || !option.advanced);

  return (
    <div className="pb">
      <div className="pb-head">
        <div><h1>New AI project</h1><p className="pb-lead">Describe the idea. The orchestrator picks the stack, writes the project contract, plans milestones and tasks, and sets up the repository, after you approve the plan.</p></div>
        <div className="pb-seg" role="group" aria-label="View"><button type="button" aria-pressed={!advanced} onClick={() => { setAdvanced(false); saveView(false); }}>Simple</button><button type="button" aria-pressed={advanced} onClick={() => { setAdvanced(true); saveView(true); }}>Advanced</button></div>
      </div>

      <h2>The idea</h2>
      <div className="pb-stack">
        <div className="pb-field"><label className="pb-label" htmlFor="pb-name">Project name</label><input id="pb-name" type="text" value={name} onChange={event => setName(event.target.value)} placeholder="Acme Storefront" /></div>
        <div className="pb-field"><label className="pb-label" htmlFor="pb-description">What should it do?</label><textarea id="pb-description" style={{ minHeight: 120 }} value={description} onChange={event => setDescription(event.target.value)} placeholder="A small online store with a landing page, search, product detail and checkout…" /><span className="pb-help">Who it is for, the main screens or features, anything you already know. The more concrete, the better the plan.</span></div>
      </div>

      {maturity ? <>
        <h2>{maturity.label}</h2>
        <div className="pb-cards" role="radiogroup" aria-label={maturity.label}>
          {maturity.choices!.map(choice => <button key={choice.value} type="button" role="radio" aria-checked={maturityValue === choice.value} className="pb-pick" onClick={() => setOption("maturity", choice.value)}><strong>{choice.label}</strong><span>{choice.help}</span></button>)}
        </div>
        <p className="pb-effects">This sets, unless you change it below: {effects.map(effect => { const option = options.find(item => item.id === effect.id); return <code key={effect.id}>{effect.label}: {option ? describe(effect.value, option) : String(effect.value)}</code>; })}</p>
      </> : null}

      {catalog.data.groups.map(group => {
        const rows = options.filter(option => option.group === group.id && visible(option));
        if (!rows.length && group.id !== "delivery") return null;
        return (
          <section key={group.id}>
            <h2>{group.label}</h2>
            <div className="pb-stack">
              {rows.map(option => (
                <div key={option.id} className="pb-card pb-field">
                  <label className="pb-label" htmlFor={`pb-${option.id}`}>{option.label}<Chip provenance={resolved?.provenance[option.id]} maturityLabel={maturityLabel} {...(option.id in touched ? { onReset: () => reset(option.id) } : {})} /></label>
                  <Control option={option} value={resolved?.values[option.id] ?? option.default} onChange={value => setOption(option.id, value)} />
                  {option.kind !== "toggle" ? <span className="pb-help" id={`pb-${option.id}-help`}>{option.help}</span> : null}
                </div>
              ))}
              {group.id === "delivery" ? (
                <div className="pb-card pb-row">
                  <div className="pb-field"><label className="pb-label" htmlFor="pb-repo">Repository name</label><input id="pb-repo" type="text" value={repoName} placeholder={slug} onChange={event => setRepoName(event.target.value)} /></div>
                  <div className="pb-field"><label className="pb-label" htmlFor="pb-owner">Owner (optional)</label><input id="pb-owner" type="text" value={repoOwner} placeholder="your GitHub account" onChange={event => setRepoOwner(event.target.value)} /></div>
                </div>
              ) : null}
            </div>
          </section>
        );
      })}

      {resolved?.warnings.length ? <p className="pb-note" style={{ marginTop: 16 }}>{resolved.warnings.join(" ")}</p> : null}
      {resolved?.errors.length ? <p className="pb-note bad" style={{ marginTop: 16 }}>{resolved.errors.join(" ")}</p> : null}
      {resolveError ? <p className="pb-note bad" style={{ marginTop: 16 }}>{resolveError}</p> : null}
      {noAgent ? <p className="pb-note bad" style={{ marginTop: 16 }}>This company has no agent that uses the Temporal Orchestrator adapter. Create one first, then come back.</p> : null}
      {agents && agents.length > 1 ? <div className="pb-field" style={{ marginTop: 16 }}><label className="pb-label" htmlFor="pb-agent">Agent that does the work</label><select id="pb-agent" value={agentId} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div> : null}
      {error ? <p className="pb-note bad" style={{ marginTop: 16 }} role="alert">{error}{projectId ? " The Paperclip project was already created; pressing the button again reuses it." : ""}</p> : null}

      <div className="pb-bar">
        <span className="pb-help">{problems[0] ?? `Creates the project and a planning task. Repository: ${repoOwner.trim() ? `${repoOwner.trim()}/` : ""}${slug}${resolved?.values.repo_create === false ? " (not created)" : ""}. Nothing is built until you approve the plan.`}</span>
        <button type="button" className="pb-btn" disabled={busy || problems.length > 0 || noAgent || Boolean(resolved?.errors.length) || !resolved} onClick={create}>{busy ? `${step}…` : "Create and plan"}</button>
      </div>
    </div>
  );
}
