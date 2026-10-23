import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { bridgeCall, pickRun, readBridgeSettings, type BridgeConfig, type RunRow } from "./bridge.js";

// The worker is a thin, authenticated proxy to the orchestrator bridge: it holds no logic of its own, so a Paperclip upgrade can only affect the slots and the SDK
// calls below. The bridge token is a secret reference, resolved at call time and never stored or logged.
async function bridgeFor(ctx: PluginContext, companyId: string): Promise<{ config: BridgeConfig; call: <T>(method: "GET" | "POST", route: string, body?: unknown) => Promise<T> }> {
  if (!companyId) throw new Error("companyId is required");
  const settings = readBridgeSettings(await ctx.config.get(companyId));
  const token = await ctx.secrets.resolve(settings.tokenRef as never, { companyId });
  const config: BridgeConfig = { url: settings.url, token };
  return { config, call: <T,>(method: "GET" | "POST", route: string, body?: unknown) => bridgeCall<T>(config, (url, init) => ctx.http.fetch(url, init), method, route, body) };
}
const text = (value: unknown) => typeof value === "string" ? value : "";

const plugin = definePlugin({
  async setup(ctx) {
    // The wizard renders its form from the orchestrator's catalog, so options and presets have one definition.
    ctx.data.register("catalog", async params => (await bridgeFor(ctx, text(params.companyId))).call("GET", "/v1/bootstrap/catalog"));
    ctx.actions.register("resolve", async params => (await bridgeFor(ctx, text(params.companyId))).call("POST", "/v1/bootstrap/resolve", { options: params.options ?? {} }));
    // Progress and plan of the bootstrap run behind a Paperclip task.
    ctx.data.register("status", async params => {
      const { call } = await bridgeFor(ctx, text(params.companyId));
      const issueId = text(params.issueId);
      if (!issueId) return { found: false };
      const row = pickRun(await call<RunRow[]>("GET", "/v1/runs"), issueId);
      if (!row) return { found: false };
      return { found: true, workflowId: row.workflowId, run: await call("GET", `/v1/runs/${encodeURIComponent(row.workflowId)}`) };
    });
    for (const decision of ["approve", "reject"] as const) {
      ctx.actions.register(decision, async params => {
        const workflowId = text(params.workflowId);
        if (!/^pc-[A-Za-z0-9._-]+$/.test(workflowId)) throw new Error("not a bootstrap workflow id");
        return (await bridgeFor(ctx, text(params.companyId))).call("POST", `/v1/runs/${encodeURIComponent(workflowId)}/${decision}`);
      });
    }
    ctx.logger.info("project bootstrap plugin ready");
  },
  async onHealth() { return { status: "ok", message: "Project Bootstrap ready" }; },
  async onValidateConfig(config) {
    try { readBridgeSettings(config); return { ok: true }; }
    catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }; }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
