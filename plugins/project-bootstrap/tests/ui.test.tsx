// @vitest-environment jsdom
// The wizard and the review tab against a stubbed Paperclip host: the SDK hooks come from a fake bridge registry, the Paperclip REST API is a fetch mock, and the
// option catalog and preset logic are the orchestrator's real ones, so the page and the server cannot drift apart unnoticed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { extractBootstrapForm } from "../../../src/bootstrap-form.js";
import { catalogPayload, resolveOptions } from "../../../src/bootstrap-options.js";
import { templateSummaries } from "../../../src/bootstrap-templates.js";
import { Review } from "../src/ui/Review.js";
import { Wizard } from "../src/ui/Wizard.js";
import type { BootState, RunStatus } from "../src/ui/types.js";

type Call = { key: string; params: Record<string, unknown> | undefined };
const navigate = vi.fn();
let data: Record<string, unknown>; let actionCalls: Call[]; let requests: Array<{ method: string; path: string; body?: Record<string, unknown> }>; let refresh: ReturnType<typeof vi.fn>;
let issues: unknown[];

function installHost() {
  (globalThis as unknown as { __paperclipPluginBridge__: unknown }).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginData: (key: string) => ({ data: data[key] ?? null, loading: !(key in data), error: null, refresh }),
      usePluginAction: (key: string) => async (params?: Record<string, unknown>) => {
        actionCalls.push({ key, params });
        return key === "resolve" ? resolveOptions((params?.options ?? {}) as Record<string, unknown>) : { ok: true };
      },
      useHostNavigation: () => ({ navigate, resolveHref: (to: string) => to, linkProps: (to: string) => ({ href: to, onClick: () => undefined }) }),
    },
  };
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const path = String(input); const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ method, path, ...(body ? { body } : {}) });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path.endsWith("/agents")) return json([{ id: "A1", name: "Orchestrator", adapterType: "temporal_orchestrator", status: "idle" }, { id: "A2", name: "Other", adapterType: "codex_local", status: "idle" }]);
    if (path.endsWith("/labels")) return json(method === "POST" ? { id: "L1" } : []);
    if (path.endsWith("/projects")) return json({ id: "P1" });
    if (path.includes("/issues?")) return json(issues);
    if (path.endsWith("/issues")) return json({ id: "I1" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const context = { companyId: "C1", companyPrefix: "PC", projectId: null, entityId: null, entityType: null, userId: "U1" };
beforeEach(() => {
  navigate.mockReset(); refresh = vi.fn(); actionCalls = []; requests = []; issues = [];
  data = { catalog: { ...catalogPayload(), templates: templateSummaries() } };
  installHost();
});
afterEach(() => cleanup());

describe("wizard", () => {
  it("shows the simple view first, applies a preset's defaults visibly and sends only what the user chose", async () => {
    render(<Wizard context={context} />);
    await screen.findByText("Who uses it?", {}, { timeout: 100 }).then(() => { throw new Error("advanced option visible in the simple view"); }, () => undefined);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Aurora Store" } });
    fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: "A modern online store: landing, search, product detail and checkout." } });
    fireEvent.click(screen.getByRole("radio", { name: /Prototype/ }));
    await waitFor(() => expect(actionCalls.some(call => call.key === "resolve" && JSON.stringify(call.params?.options) === JSON.stringify({ maturity: "prototype" }))).toBe(true));
    await waitFor(() => expect(screen.getAllByText("from the Prototype preset").length).toBeGreaterThan(0));
    expect((screen.getByLabelText(/Automated tests/) as HTMLSelectElement).value).toBe("smoke");

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByLabelText(/Review rounds per task/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Review rounds per task/), { target: { value: "3" } });
    await waitFor(() => expect(screen.getAllByText("set by you").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "reset" }));
    await waitFor(() => expect(screen.queryByText("set by you")).toBeNull());
    fireEvent.change(screen.getByLabelText(/Review rounds per task/), { target: { value: "2" } });

    await waitFor(() => expect((screen.getByRole("button", { name: "Create and plan" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create and plan" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/projects/P1?tab=plugin:orchestrator.project-bootstrap:bootstrap-tab"));

    const project = requests.find(request => request.method === "POST" && request.path.endsWith("/projects"))!;
    expect(project.body).toMatchObject({ name: "Aurora Store", status: "in_progress" });
    const issue = requests.find(request => request.method === "POST" && request.path.endsWith("/issues"))!;
    expect(issue.body).toMatchObject({ projectId: "P1", title: "Bootstrap: Aurora Store", status: "todo", assigneeAgentId: "A1", labelIds: ["L1"] });
    const form = extractBootstrapForm(String(issue.body!.description)).form as { options: Record<string, unknown>; paperclip: Record<string, unknown> };
    expect(form.options).toEqual({ maturity: "prototype", review_rounds: "2" });
    expect(form.paperclip).toMatchObject({ companyId: "C1", projectId: "P1", agentId: "A1" });
    expect(requests.some(request => request.method === "POST" && request.path.endsWith("/labels"))).toBe(true);
  });

  it("will not create anything until the name and description are usable", async () => {
    render(<Wizard context={context} />);
    await waitFor(() => expect(actionCalls.length).toBeGreaterThan(0));
    const button = screen.getByRole("button", { name: "Create and plan" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Give the project a name.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Aurora" } });
    fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: "short" } });
    expect(button.disabled).toBe(true);
    expect(requests.filter(request => request.method === "POST")).toEqual([]);
  });

  it("explains a missing orchestrator agent instead of failing later", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => String(input).endsWith("/agents") ? new Response(JSON.stringify([]), { status: 200 }) : original(input as string, init as RequestInit)) as typeof fetch;
    render(<Wizard context={context} />);
    await screen.findByText(/no agent that uses the Temporal Orchestrator adapter/);
    expect((screen.getByRole("button", { name: "Create and plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the created project when the task could not be created, and reuses it on retry", async () => {
    let failIssue = true; const base = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      if (String(input).endsWith("/issues") && init?.method === "POST" && failIssue) { requests.push({ method: "POST", path: String(input) }); return new Response("boom", { status: 500 }); }
      return base(input as string, init as RequestInit);
    }) as typeof fetch;
    render(<Wizard context={context} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Aurora Store" } });
    fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: "A modern online store with four pages." } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create and plan" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create and plan" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("already created");
    failIssue = false;
    fireEvent.click(screen.getByRole("button", { name: "Create and plan" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(requests.filter(request => request.method === "POST" && request.path.endsWith("/projects"))).toHaveLength(1);
  });
});

describe("review tab", () => {
  const projectContext = { ...context, projectId: "P1", entityId: "P1", entityType: "project" } as const;
  const boot: BootState = {
    phase: "awaiting_approval", warnings: ["blueprint: a deterministic fallback replaced the model answer"],
    stack: { summary: "Vite and React", language: "TypeScript", architecture: "frontend_only", template_id: "vite-react-ts", rationale: "Simple.", frameworks: [{ name: "React", role: "UI", why: "w" }], alternatives: [{ name: "Next.js", why_not: "No server needed" }], assumptions: ["Current React"], risks: ["Mock data"] },
    charter: { vision: "A modern storefront prototype.", goals: ["Browse and buy"], non_goals: ["Real payments"], boundaries: ["No backend"], constraints: [], design_rules: [], open_questions: ["Which currency?"] },
    blueprint: { summary: "Two milestones.", milestones: [{ key: "M1", title: "Storefront", goal: "Browse", exit_criteria: [], tasks: [{ key: "T1", title: "Landing page", description: "Hero and products", type: "task", acceptance: ["Shows products"], depends_on: [] }, { key: "T2", title: "Search page", description: "Filter", type: "task", acceptance: ["Filters"], depends_on: ["T1"] }] }] },
  };
  const waiting: RunStatus = { found: true, workflowId: "pc-I1-rev-a1", run: { status: "RUNNING", progress: { currentStage: "approval", completedStages: ["stack", "charter", "blueprint"] }, bootstrap: boot } };
  beforeEach(() => { issues = [{ id: "I1", title: "Bootstrap: Aurora Store", status: "in_progress", labels: [{ name: "type:bootstrap" }], projectId: "P1" }]; });

  it("shows progress and the plan, and lets the user approve it", async () => {
    data.status = waiting;
    render(<Review context={projectContext} />);
    await screen.findByText("Milestone 1: Storefront");
    for (const text of ["Vite and React", "Next.js", "No server needed", "Real payments", "Which currency?", "Landing page", "after T1", "a deterministic fallback replaced the model answer"]) expect(screen.getAllByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length, text).toBeGreaterThan(0);
    expect(screen.getByText(/Your approval \(now\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and create" }));
    await waitFor(() => expect(actionCalls.find(call => call.key === "approve")?.params).toEqual({ companyId: "C1", workflowId: "pc-I1-rev-a1" }));
    expect(refresh).toHaveBeenCalled();
  });
  it("lets the user reject the plan", async () => {
    data.status = waiting;
    render(<Review context={projectContext} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(actionCalls.some(call => call.key === "reject")).toBe(true));
  });
  it("shows what was created when the run is done", async () => {
    data.status = { found: true, workflowId: "pc-I1-rev-a1", run: { status: "COMPLETED", progress: undefined, result: { status: "completed", message: "project created: 2 Paperclip issues, repository https://github.com/me/shop", bootstrap: { repositoryUrl: "https://github.com/me/shop", projectRoot: "C:/projects/shop", template: "vite-react-ts", warnings: [], issues: [{ id: "X1", title: "Milestone 1: Storefront", kind: "milestone", status: "backlog" }, { id: "X2", title: "Landing page", kind: "task", status: "todo" }] } } } } satisfies RunStatus;
    render(<Review context={projectContext} />);
    await screen.findByText(/project created: 2 Paperclip issues/);
    expect((screen.getByText("https://github.com/me/shop") as HTMLAnchorElement).href).toBe("https://github.com/me/shop");
    expect(screen.getByText("Landing page")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and create" })).toBeNull();
  });
  it("says so when the project has no bootstrap task, and while the orchestrator has not picked it up", async () => {
    issues = [];
    render(<Review context={projectContext} />);
    await screen.findByText(/not created through New AI project/);
    cleanup();
    issues = [{ id: "I1", title: "Bootstrap: Aurora Store", status: "todo", labels: [{ name: "type:bootstrap" }], projectId: "P1" }];
    data.status = { found: false };
    render(<Review context={projectContext} />);
    await screen.findByText(/Waiting for the orchestrator to pick up the task/);
  });
});
