import type { PluginRequirement } from "./contracts.js";
export type PluginCheckContext = { stage: string; provider: string };
export type CapabilityPlugin = { id: string; version: string; capabilities: string[]; dependencies: string[]; compatible: (coreVersion: string) => boolean; validateConfig: (config: Record<string, unknown>) => boolean; permissions: string[]; errorPolicy: { maxAttempts: number; timeoutMs: number }; required: boolean; healthCheck: () => Promise<boolean>; appliesTo?: (context: PluginCheckContext, config: Record<string, unknown>) => boolean };
export class PluginRegistry {
  private readonly plugins = new Map<string, CapabilityPlugin>();
  register(plugin: CapabilityPlugin): void { if (this.plugins.has(plugin.id)) throw new Error(`duplicate plugin: ${plugin.id}`); this.plugins.set(plugin.id, plugin); }
  get(id: string): CapabilityPlugin | undefined { return this.plugins.get(id); }
  async check(enabled: PluginRequirement[], context?: PluginCheckContext): Promise<string[]> {
    const errors: string[] = [];
    for (const item of enabled) {
      if (!item.enabled) continue;
      const plugin = this.plugins.get(item.id);
      if (!plugin) { if (item.required) errors.push(`required plugin '${item.id}' is missing`); continue; }
      if (item.version && item.version !== plugin.version) errors.push(`plugin '${item.id}' version mismatch: manifest ${item.version}, installed ${plugin.version}`);
      if (!plugin.compatible("0.1.0")) errors.push(`plugin '${item.id}' is incompatible with orchestration core 0.1.0`);
      if (!plugin.validateConfig(item.config ?? {})) errors.push(`plugin '${item.id}' configuration is invalid`);
      if (context && plugin.appliesTo && !plugin.appliesTo(context, item.config ?? {})) continue;
      const missingDependencies = [...(item.dependencies ?? []), ...plugin.dependencies].filter(id => !this.plugins.has(id));
      if (missingDependencies.length) errors.push(`plugin '${item.id}' is missing dependencies: ${[...new Set(missingDependencies)].join(", ")}`);
      try { if (!(await plugin.healthCheck()) && (item.required || plugin.required)) errors.push(`required plugin '${item.id}' failed health check`); }
      catch (error) { if (item.required || plugin.required) errors.push(`required plugin '${item.id}' health check error: ${String(error)}`); }
    }
    return errors;
  }
}
export const pluginRegistry = new PluginRegistry();

// RTK is an optional, project-scoped execution integration. Its CLI and hook
// are checked by the provider at the Codex implementation stage so unrelated
// stages never depend on the host binary.
pluginRegistry.register({
  id: "rtk",
  version: "0.1.0",
  capabilities: ["command-output-filtering"],
  dependencies: [],
  appliesTo: (context, config) => context.stage === "implement" && context.provider === "codex" && (config.stages === undefined || (Array.isArray(config.stages) && config.stages.includes(context.stage))),
  compatible: () => true,
  validateConfig: (config) => {
    const stages = config.stages;
    return stages === undefined || (Array.isArray(stages) && stages.every(stage => stage === "implement"));
  },
  permissions: ["execute:rtk-hook", "read:project-codex-hook-config"],
  errorPolicy: { maxAttempts: 1, timeoutMs: 5_000 },
  required: false,
  healthCheck: async () => true,
});
