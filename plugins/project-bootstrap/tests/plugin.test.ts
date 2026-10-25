import { describe, expect, it } from "vitest";
import { bridgeCall, pickRun, readBridgeSettings } from "../src/bridge.js";
import { embedBootstrapForm, formProblems, projectSlug, taskDescription, type BootstrapForm } from "../src/form.js";
import manifest, { PAGE_ROUTE, PLUGIN_ID, TAB_SLOT_ID } from "../src/manifest.js";
// The orchestrator's own reader, so the page and the bridge cannot drift apart on the format.
import { extractBootstrapForm } from "../../../src/bootstrap-form.js";

const form: BootstrapForm = { version: 1, name: "Shop --> Demo", description: "A storefront prototype.", options: { maturity: "prototype", ui_ux: true }, paperclip: { companyId: "c", projectId: "p" } };

describe("bridge helpers", () => {
  it("sends the token and a JSON body, and reads the JSON answer", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const result = await bridgeCall<{ ok: boolean }>({ url: "http://bridge/", token: "tok" }, async (url, init) => { seen.push({ url, init: init! }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }, "POST", "/v1/bootstrap/resolve", { options: {} });
    expect(result.ok).toBe(true);
    expect(seen[0]!.url).toBe("http://bridge/v1/bootstrap/resolve");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(seen[0]!.init.body).toBe(JSON.stringify({ options: {} }));
  });
  it("turns a bridge error into a message that names the route and the reason", async () => {
    await expect(bridgeCall({ url: "http://bridge", token: "t" }, async () => new Response(JSON.stringify({ error: "project already bootstrapped" }), { status: 400 }), "GET", "/v1/runs")).rejects.toThrow("returned 400: project already bootstrapped");
    await expect(bridgeCall({ url: "http://bridge", token: "t" }, async () => new Response("plain failure", { status: 502 }), "GET", "/v1/runs")).rejects.toThrow("plain failure");
  });
  it("picks the running workflow of a task, else the newest, and ignores other tasks", () => {
    const rows = [{ workflowId: "pc-T1-2026-10-22T10-a1", status: "COMPLETED" }, { workflowId: "pc-T1-2026-10-23T10-a1", status: "FAILED" }, { workflowId: "pc-T2-2026-10-24T10-a1", status: "RUNNING" }];
    expect(pickRun(rows, "T1")?.workflowId).toBe("pc-T1-2026-10-23T10-a1");
    expect(pickRun([...rows, { workflowId: "pc-T1-2026-10-21T10-a1", status: "RUNNING" }], "T1")?.workflowId).toBe("pc-T1-2026-10-21T10-a1");
    expect(pickRun(rows, "T3")).toBeUndefined();
  });
  it("reads the settings, defaulting the URL and insisting on a token", () => {
    expect(readBridgeSettings({ bridgeToken: { type: "secret_ref", secretId: "s" } }).url).toBe("http://orchestrator:3101");
    expect(readBridgeSettings({ bridgeUrl: " http://x:1 ", bridgeToken: "ref" }).url).toBe("http://x:1");
    expect(() => readBridgeSettings({})).toThrow("no bridge token");
  });
});

describe("the project form", () => {
  it("is hidden in the task description and survives text that contains the end of a comment", () => {
    const block = embedBootstrapForm(form);
    expect(block.match(/-->/g)).toHaveLength(1);
    const description = taskDescription(form);
    expect(description).toContain("Plan and create the project");
    expect(description).toContain("- maturity: prototype");
    expect((extractBootstrapForm(description).form as BootstrapForm).name).toBe("Shop --> Demo");
  });
  it("is read back by the orchestrator even after Paperclip turns literal backslash-n sequences in task text into newlines", () => {
    const withLines: BootstrapForm = { ...form, options: { out_of_scope: "Real payments\nAccounts", constraints: "Mock data only" } };
    const stored = taskDescription(withLines).replace(/\\n/g, "\n");
    expect(extractBootstrapForm(stored)).toMatchObject({ form: withLines });
  });
  it("checks the input the way the orchestrator will", () => {
    expect(formProblems({ name: "", description: "short", repoName: "", repoOwner: "" })).toHaveLength(2);
    expect(formProblems({ name: "Shop", description: "A storefront prototype.", repoName: "../x", repoOwner: "" })[0]).toContain("repository name");
    expect(formProblems({ name: "Shop", description: "A storefront prototype.", repoName: "shop-demo", repoOwner: "acme" })).toEqual([]);
    expect(projectSlug("Shop Demo!!")).toBe("shop-demo");
  });
});

describe("manifest", () => {
  it("declares each slot with its export, and only the capabilities its code uses", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    const slots = manifest.ui?.slots ?? [];
    expect(slots.map(slot => slot.type).sort()).toEqual(["detailTab", "globalToolbarButton", "page", "sidebar"]);
    expect(slots.find(slot => slot.type === "page")).toMatchObject({ routePath: PAGE_ROUTE });
    expect(slots.find(slot => slot.type === "detailTab")).toMatchObject({ id: TAB_SLOT_ID, entityTypes: ["project"] });
    expect(new Set(slots.map(slot => slot.id)).size).toBe(slots.length);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["http.outbound", "secrets.read-ref", "ui.page.register", "ui.detailTab.register"]));
    expect(manifest.capabilities).not.toContain("issues.create");
  });
  it("keeps the token out of plain configuration", () => {
    const token = (manifest.instanceConfigSchema as { properties: Record<string, { format?: string }> }).properties.bridgeToken!;
    expect(token.format).toBe("secret-ref");
  });
});
