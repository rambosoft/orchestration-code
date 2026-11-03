import { createHash } from "node:crypto";
import type { IntelligenceConfig, QualityCommand } from "./contracts.js";
import type { CommandRunner } from "./command.js";
import { FactSchema, type Fact } from "./intelligence.js";

// The intelligence registry (ADR 0038 addendum, B-167). A tool is a registry entry plus an adapter; its mode (off | advisory | gate) comes from the manifest, falling back to the
// adapter's own default. Advisory tools never fail a task: a crash, timeout or oversize result becomes a warning. Only a gate tool can fail a task, through its quality command.

export type IntelligenceMode = "off" | "advisory" | "gate";
export type IntelligenceContext = {
  worktree: string; taskId: string; commit: string;
  /** Repository-relative files the task names or changes. */
  affectedFiles: string[];
  /** The stage prompt, for tools that look for what the task names (B-165). */
  prompt?: string;
  /** Tracked and untracked (not ignored) files of the worktree, repository-relative. */
  files: string[];
  signal: AbortSignal; runner?: CommandRunner;
};
export type IntelligenceAdapter = {
  id: string; version: string;
  /** Off until the tool's token and time effect has been measured against the baseline (ADR 0038): a project switches it on in its manifest. */
  defaultMode: IntelligenceMode;
  timeoutMs: number; sizeBudgetChars: number;
  run(context: IntelligenceContext): Promise<Fact[]>;
  /** The quality command a gate-mode tool adds to the verify stage; undefined when the project does not support it. */
  gateCommand?(worktree: string): Promise<QualityCommand | undefined>;
};
export type AdvisoryResult = { facts: Fact[]; tools: string[]; warnings: string[] };

const MAX_CACHE = 64;
export class IntelligenceRegistry {
  private readonly adapters = new Map<string, IntelligenceAdapter>();
  private readonly cache = new Map<string, Fact[]>();
  register(adapter: IntelligenceAdapter): void { if (this.adapters.has(adapter.id)) throw new Error(`duplicate intelligence tool: ${adapter.id}`); this.adapters.set(adapter.id, adapter); }
  get(id: string): IntelligenceAdapter | undefined { return this.adapters.get(id); }
  list(): IntelligenceAdapter[] { return [...this.adapters.values()]; }

  /** The manifest wins over the adapter default. The kill switch (ORCHESTRATOR_INTELLIGENCE=off) and `enabled: false` turn advisory tools off; a gate is a verdict the project asked for and stays. */
  mode(adapter: IntelligenceAdapter, config?: IntelligenceConfig, env: NodeJS.ProcessEnv = process.env): IntelligenceMode {
    const mode = config?.tools[adapter.id]?.mode ?? adapter.defaultMode;
    const switchedOff = env.ORCHESTRATOR_INTELLIGENCE === "off" || config?.enabled === false;
    return mode === "advisory" && switchedOff ? "off" : mode;
  }
  /** Tool ids a manifest names that no adapter implements (a typo would otherwise silently do nothing). */
  unknownTools(config?: IntelligenceConfig): string[] { return Object.keys(config?.tools ?? {}).filter(id => !this.adapters.has(id)); }

  /** Runs every advisory tool, each bounded by its timeout and size budget. Never throws. A result is cached by tool, version, working-tree fingerprint and affected files. */
  async collect(context: Omit<IntelligenceContext, "signal">, config: IntelligenceConfig | undefined, options: { fingerprint: string; env?: NodeJS.ProcessEnv }): Promise<AdvisoryResult> {
    const result: AdvisoryResult = { facts: [], tools: [], warnings: this.unknownTools(config).map(id => `intelligence tool '${id}' is not registered`) };
    for (const adapter of this.adapters.values()) {
      if (this.mode(adapter, config, options.env) !== "advisory") continue;
      const settings = config?.tools[adapter.id];
      const timeoutMs = settings?.timeoutMs ?? adapter.timeoutMs; const budget = settings?.sizeBudgetChars ?? adapter.sizeBudgetChars;
      const key = [adapter.id, adapter.version, options.fingerprint, context.affectedFiles.join(","), createHash("sha1").update(context.prompt ?? "").digest("hex").slice(0, 10)].join("|");
      let facts = this.cache.get(key);
      if (!facts) {
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        try {
          const found = await Promise.race([
            adapter.run({ ...context, signal: controller.signal }),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs); }),
          ]);
          const parsed = found.filter(fact => FactSchema.safeParse(fact).success);
          if (parsed.length < found.length) result.warnings.push(`intelligence tool '${adapter.id}' returned ${found.length - parsed.length} malformed fact(s), dropped`);
          let size = 0; facts = [];
          for (const fact of parsed) { size += JSON.stringify(fact).length; if (size > budget) { result.warnings.push(`intelligence tool '${adapter.id}' result cut at ${budget} characters (${parsed.length - facts.length} fact(s) dropped)`); break; } facts.push(fact); }
          if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
          this.cache.set(key, facts);
        } catch (error) {
          result.warnings.push(`intelligence tool '${adapter.id}' failed: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        } finally { if (timer) clearTimeout(timer); }
      }
      result.tools.push(`${adapter.id}@${adapter.version}`);
      result.facts.push(...facts);
    }
    return result;
  }

  /** Quality commands of the gate-mode tools, for the verify stage. A tool that cannot build one (the project lacks it) is skipped. */
  async gateCommands(worktree: string, config: IntelligenceConfig | undefined, env: NodeJS.ProcessEnv = process.env): Promise<QualityCommand[]> {
    const commands: QualityCommand[] = [];
    for (const adapter of this.adapters.values()) {
      if (this.mode(adapter, config, env) !== "gate" || !adapter.gateCommand) continue;
      const command = await adapter.gateCommand(worktree).catch(() => undefined);
      if (command) commands.push(command);
    }
    return commands;
  }
  clearCache(): void { this.cache.clear(); }
}

export const intelligenceRegistry = new IntelligenceRegistry();
