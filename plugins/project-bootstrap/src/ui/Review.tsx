import { useEffect, useState } from "react";
import { useHostNavigation, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { findBootstrapIssue } from "./api.js";
import type { BootState, IssueRow, RunStatus } from "./types.js";

const STEPS: Array<{ id: string; label: string }> = [{ id: "stack", label: "Choose the stack" }, { id: "charter", label: "Write the project contract" }, { id: "blueprint", label: "Plan milestones and tasks" }, { id: "approval", label: "Your approval" }, { id: "scaffold", label: "Create the repository and manifest" }, { id: "issues", label: "Create the Paperclip tasks" }];
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED", "CANCELLED", "TERMINATED", "TIMED_OUT"]);
const List = ({ items }: { items: string[] }) => items.length ? <ul className="pb-list">{items.map(item => <li key={item}>{item}</li>)}</ul> : <p className="pb-help">none</p>;

function Steps({ progress }: { progress: NonNullable<NonNullable<RunStatus["run"]>["progress"]> | undefined }) {
  return (
    <ol className="pb-steps" aria-label="Progress">
      {STEPS.map(step => { const done = progress?.completedStages.includes(step.id); const now = progress?.currentStage === step.id; return <li key={step.id} className={done ? "done" : now ? "now" : ""}><span className="pb-dot" aria-hidden />{step.label}{now ? " (now)" : ""}</li>; })}
    </ol>
  );
}

function Plan({ state }: { state: BootState }) {
  const { stack, charter, blueprint } = state;
  return (
    <div className="pb-stack">
      {stack ? <div className="pb-card"><h3>Stack</h3><p>{stack.summary}</p><p className="pb-help">{stack.language} · {stack.architecture.replace("_", " ")} · {stack.frameworks.map(item => item.name).join(", ")} · scaffold: {stack.template_id}</p><p style={{ marginTop: 6 }}>{stack.rationale}</p>
        {stack.alternatives.length ? <><p className="pb-label" style={{ marginTop: 8 }}>Considered and not chosen</p><ul className="pb-list">{stack.alternatives.map(item => <li key={item.name}><strong>{item.name}</strong>: {item.why_not}</li>)}</ul></> : null}
        {stack.assumptions.length || stack.risks.length ? <div className="pb-row" style={{ marginTop: 8 }}><div><p className="pb-label">Assumptions</p><List items={stack.assumptions} /></div><div><p className="pb-label">Risks</p><List items={stack.risks} /></div></div> : null}</div> : null}
      {charter ? <div className="pb-card"><h3>Project contract</h3><p>{charter.vision}</p>
        <div className="pb-row" style={{ marginTop: 8 }}><div><p className="pb-label">Goals</p><List items={charter.goals} /></div><div><p className="pb-label">Not in scope</p><List items={[...charter.non_goals, ...charter.boundaries]} /></div></div>
        {charter.open_questions.length ? <><p className="pb-label" style={{ marginTop: 8 }}>Open questions for you</p><List items={charter.open_questions} /></> : null}</div> : null}
      {blueprint ? <div className="pb-card"><h3>Plan</h3><p>{blueprint.summary}</p>
        {blueprint.milestones.map((milestone, index) => <div key={milestone.key} className="pb-ms"><strong>Milestone {index + 1}: {milestone.title}</strong><p className="pb-help">{milestone.goal}</p>
          {milestone.tasks.map(task => <div key={task.key} className="pb-task"><strong>{task.title}</strong>{task.type !== "task" ? <span className="pb-chip">{task.type}</span> : null}{task.depends_on.length ? <span className="pb-chip">after {task.depends_on.join(", ")}</span> : null}<p className="pb-help">{task.description}</p><List items={task.acceptance} /></div>)}</div>)}</div> : null}
    </div>
  );
}

export function Review({ context }: { context: PluginHostContext }) {
  const companyId = context.companyId ?? ""; const projectId = context.entityId ?? "";
  const nav = useHostNavigation();
  const [issue, setIssue] = useState<IssueRow | null | undefined>(undefined); const [issueError, setIssueError] = useState<string | null>(null);
  const status = usePluginData<RunStatus>("status", { companyId, issueId: issue?.id ?? "" });
  const approve = usePluginAction("approve"); const reject = usePluginAction("reject");
  const [busy, setBusy] = useState(false); const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => { if (companyId && projectId) findBootstrapIssue(companyId, projectId).then(found => setIssue(found ?? null)).catch(failure => { setIssue(null); setIssueError(failure instanceof Error ? failure.message : String(failure)); }); }, [companyId, projectId]);
  const run = status.data?.run; const finished = run ? TERMINAL.has(run.status) : false;
  useEffect(() => {
    if (!issue || finished) return;
    const timer = setInterval(() => status.refresh(), 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, finished]);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true); setActionError(null);
    try { await (decision === "approve" ? approve : reject)({ companyId, workflowId: status.data?.workflowId }); status.refresh(); }
    catch (failure) { setActionError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };

  if (issue === undefined) return <div className="pb"><p className="pb-lead">Looking for the bootstrap task…</p></div>;
  if (issue === null) return <div className="pb"><h1>Bootstrap</h1><p className="pb-lead">{issueError ?? "This project was not created through New AI project, so there is no plan to show."}</p><a className="pb-btn secondary" {...nav.linkProps("/new-project")}>New AI project</a></div>;
  const boot = run?.bootstrap; const result = run?.result;
  return (
    <div className="pb">
      <div className="pb-head"><div><h1>Bootstrap</h1><p className="pb-lead">Task: <a {...nav.linkProps(`/issues/${issue.identifier ?? issue.id}`)}>{issue.title}</a> ({issue.status.replace("_", " ")})</p></div></div>
      {status.error ? <p className="pb-note bad" role="alert">{status.error.message}</p> : null}
      {!status.data?.found && !status.loading ? <p className="pb-note">Waiting for the orchestrator to pick up the task. It starts as soon as the assigned agent runs.</p> : null}
      {run ? <><h2>Progress</h2><Steps progress={run.progress} /></> : null}
      {boot?.warnings.length ? <p className="pb-note" style={{ marginTop: 14 }}>{boot.warnings.join(" · ")}</p> : null}
      {boot && (boot.stack || boot.charter || boot.blueprint) ? <><h2>The plan</h2><Plan state={boot} /></> : null}
      {boot?.phase === "awaiting_approval" ? (
        <div className="pb-bar">
          <span className="pb-help">Approving creates the repository, the orchestrator manifest and the tasks. Rejecting creates nothing.</span>
          <span style={{ display: "flex", gap: 10 }}><button type="button" className="pb-btn danger" disabled={busy} onClick={() => decide("reject")}>Reject</button><button type="button" className="pb-btn" disabled={busy} onClick={() => decide("approve")}>Approve and create</button></span>
        </div>
      ) : null}
      {actionError ? <p className="pb-note bad" role="alert" style={{ marginTop: 12 }}>{actionError}</p> : null}
      {result ? <><h2>Result</h2>
        <p className={result.status === "completed" ? "pb-note" : "pb-note bad"}>{result.message}</p>
        {result.bootstrap ? <div className="pb-card" style={{ marginTop: 10 }}>
          {result.bootstrap.repositoryUrl ? <p>Repository: <a href={result.bootstrap.repositoryUrl} target="_blank" rel="noreferrer">{result.bootstrap.repositoryUrl}</a></p> : <p className="pb-help">No repository was created.</p>}
          <p className="pb-help">Local folder: {result.bootstrap.projectRoot} · scaffold: {result.bootstrap.template}</p>
          {result.bootstrap.issues.length ? <ul className="pb-list">{result.bootstrap.issues.map(created => <li key={created.id}><a {...nav.linkProps(`/issues/${created.id}`)}>{created.title}</a> <span className="pb-chip">{created.kind === "milestone" ? "milestone" : created.status.replace("_", " ")}</span></li>)}</ul> : null}
          {result.bootstrap.warnings.length ? <><p className="pb-label" style={{ marginTop: 8 }}>Heads-up</p><List items={result.bootstrap.warnings} /></> : null}
        </div> : null}</> : null}
    </div>
  );
}
