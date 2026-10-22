import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { ReviewAssessmentSchema, type ReviewAssessment, type StageInput, type StageOutput } from "./contracts.js";
import { resolveRtkStatus } from "./rtk.js";
import { childEnv } from "./env.js";

export interface AgentProvider { readonly id: string; run(input: StageInput): Promise<StageOutput> }
function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|AIza)[-_A-Za-z0-9]{20,}\b/g, "[REDACTED CREDENTIAL]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
function parseReviewAssessment(text: string): ReviewAssessment {
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? "", text.match(/\{[\s\S]*\}/)?.[0] ?? ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = ReviewAssessmentSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch { /* try the next supported response form */ }
  }
  const verdict = /(?:^|\n)\s*(?:\*\*)?VERDICT:\s*(PASS|NEEDS_CHANGES)(?:\*\*)?/i.exec(text)?.[1]?.toLowerCase();
  if (verdict === "pass" || verdict === "needs_changes") {
    const details = text.replace(/(?:^|\n)\s*(?:\*\*)?VERDICT:\s*(?:PASS|NEEDS_CHANGES)(?:\*\*)?/i, "").trim();
    const findings = verdict === "needs_changes" ? [{ severity: "high" as const, category: "functional" as const, title: details.slice(0, 180) || "Review identified a blocking defect", evidence: details || text, fixableInCode: true }] : [];
    return { verdict, findings, notes: [] };
  }
  throw new Error("review provider returned an invalid structured assessment; expected verdict, findings, and notes JSON");
}
export class FakeProvider implements AgentProvider {
  readonly id = "fake";
  async run(input: StageInput): Promise<StageOutput> {
    if (input.prompt.includes("[TRANSIENT_ACTIVITY]") && (input.activityAttempt ?? 1) === 1) throw new Error("deterministic one-time Activity failure");
    if (input.prompt.includes("[INVALID_RESULT]")) return { ok: true, summary: "invalid", findings: [], artifactRefs: [], provider: "", durationMs: -1 };
    let summary = `[fake:${input.stage}] ${input.prompt.slice(0, 180)}`;
    if (input.stage === "plan" && input.prompt.includes("Compress this plan")) {
      let prior: Record<string, unknown> = {};
      try { prior = JSON.parse(/Plan to compress:\n([\s\S]*)$/.exec(input.prompt)?.[1] ?? "{}"); } catch { /* deterministic invalid-input fixture */ }
      summary = JSON.stringify({ task_goal: prior.task_goal ?? "Implement the requested behavior", approach: prior.approach ?? "Follow existing project patterns", important_decisions: Array.isArray(prior.important_decisions) ? prior.important_decisions.slice(0, 2) : [], risks: Array.isArray(prior.risks) ? prior.risks.slice(0, 2) : [], acceptance_criteria: prior.acceptance_criteria ?? ["Implement the requested behavior and verify it with focused tests."], hard_constraints: prior.hard_constraints ?? [] });
    } else if (input.stage === "plan") summary = JSON.stringify({ task_goal: "Implement the requested behavior", approach: "Follow existing project patterns", important_decisions: [], risks: [], acceptance_criteria: ["Implement the requested behavior and verify it with focused tests."], hard_constraints: [] });
    if (input.stage === "brief" && input.prompt.includes("Compress this execution brief")) {
      let prior: Record<string, unknown> = {};
      try { prior = JSON.parse(/Brief to compress:\n([\s\S]*)$/.exec(input.prompt)?.[1] ?? "{}"); } catch { /* deterministic invalid-input fixture */ }
      summary = JSON.stringify({ ...prior, implementation_steps: Array.isArray(prior.implementation_steps) ? prior.implementation_steps.slice(0, 3) : [], verification_steps: Array.isArray(prior.verification_steps) ? prior.verification_steps.slice(0, 3) : [] });
    } else if (input.stage === "brief") {
      let protectedItems: string[] = [];
      const source = /Source:\n([\s\S]*)$/.exec(input.prompt)?.[1];
      try { protectedItems = (JSON.parse(source ?? "{}") as { requiredVerbatimItems?: string[] }).requiredVerbatimItems ?? []; } catch { /* provider test fixture will fail schema validation if malformed */ }
      summary = JSON.stringify({ task_goal: "Implement the requested behavior", files_or_modules: [], must_follow: protectedItems, must_avoid: [], implementation_steps: ["Implement the requested behavior"], verification_steps: ["Run focused tests"], acceptance_checks: protectedItems.length ? protectedItems : ["Implement the requested behavior and verify it with focused tests."] });
    }
    const review = input.stage !== "review" ? undefined
      : input.prompt.includes("[INJECT_EXTERNAL_REVIEW_BLOCKER]")
        ? { verdict: "needs_changes" as const, findings: [{ severity: "high" as const, category: "environment" as const, title: "External setup prerequisite", evidence: "Test-only injected external prerequisite", fixableInCode: false }], notes: [] }
        : input.prompt.includes("[INJECT_REVIEW_FAILURE]")
          ? { verdict: "needs_changes" as const, findings: [{ severity: "high" as const, category: "functional" as const, title: "Injected deterministic review failure", evidence: "Test-only injected review finding", fixableInCode: true }], notes: [] }
          : { verdict: "pass" as const, findings: [], notes: input.prompt.includes("[INJECT_REVIEW_NOTE]") ? [{ severity: "low" as const, category: "polish" as const, title: "Injected minor suggestion", evidence: "Test-only injected non-blocking note", fixableInCode: true }] : [] };
    const failed = input.stage === "review" && (review!.verdict === "needs_changes");
    return { ok: !failed, summary, findings: review?.findings.map(item => `${item.title}: ${item.evidence}`) ?? [], ...(review ? { review } : {}), artifactRefs: [], provider: this.id, durationMs: 0, metadata: { deterministic: true, activityAttempt: input.activityAttempt ?? 1 } };
  }
}

type ProviderSpec = { executable: string; args: (prompt: string, stage: StageInput["stage"], reasoningEffort?: StageInput["reasoningEffort"]) => string[]; env?: Record<string, string> };
const require = createRequire(import.meta.url);
const pinnedCodexCli = require.resolve("@openai/codex/bin/codex.js");
export function codexExecutionArgs(prompt: string, stage: StageInput["stage"], effort?: StageInput["reasoningEffort"]): string[] {
  return [pinnedCodexCli, "exec", "--ephemeral", "--json", ...(stage === "implement" && effort ? ["-c", `model_reasoning_effort=${effort}`] : []), "--model", "gpt-6-luna", "--sandbox", stage === "implement" || stage === "openspec" ? "workspace-write" : "read-only", "-"];
}
const specs: Record<string, ProviderSpec> = {
  claude: { executable: "claude", args: (p, stage) => ["-p", "--permission-mode", stage === "implement" ? "acceptEdits" : "plan", "--max-turns", "8", "--output-format", "json", p] },
  codex: { executable: process.execPath, args: codexExecutionArgs },
  gemini: { executable: "gemini", args: (p, stage) => ["--approval-mode", stage === "implement" ? "auto_edit" : "plan", "--output-format", "json", "-p", p] },
};

export function parseCodexTelemetry(output: string): { summary?: string; telemetry: { eventCounts: Record<string, number>; itemCounts: Record<string, number>; turnCount: number; usage?: unknown } } {
  const eventCounts: Record<string, number> = {};
  const itemCounts: Record<string, number> = {};
  let turnCount = 0;
  let summary: string | undefined;
  let usage: unknown;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown }; usage?: unknown; total_token_usage?: unknown };
      if (typeof event.type !== "string") continue;
      eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
      if (event.type === "turn.completed") {
        turnCount++;
        usage = event.usage ?? event.total_token_usage ?? usage;
      }
      if (typeof event.item?.type === "string") {
        itemCounts[event.item.type] = (itemCounts[event.item.type] ?? 0) + (event.type === "item.completed" ? 1 : 0);
        if (event.type === "item.completed" && event.item.type === "agent_message" && typeof event.item.text === "string") summary = event.item.text;
      }
    } catch { /* Ignore non-JSON lines; --json still allows provider diagnostics on stdout. */ }
  }
  return { ...(summary ? { summary } : {}), telemetry: { eventCounts, itemCounts, turnCount, ...(usage !== undefined ? { usage } : {}) } };
}

const PROVIDER_CREDENTIALS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
/** CLI agents keep their own provider credentials; orchestrator, Paperclip, GitHub and OpenRouter secrets are removed. */
export function cliProviderEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return childEnv(environment, PROVIDER_CREDENTIALS);
}

export class CliProvider implements AgentProvider {
  constructor(readonly id: "claude" | "codex" | "gemini", private readonly defaultTimeoutMs = 180_000) {}
  async run(input: StageInput): Promise<StageOutput> {
    const spec = specs[this.id]; const started = Date.now(); const timeoutMs = input.providerTimeoutMs ?? this.defaultTimeoutMs;
    const rtk = this.id === "codex" && input.stage === "implement"
      ? await resolveRtkStatus({ plugins: input.plugins, stage: input.stage, provider: this.id, projectRoot: input.projectRoot })
      : { active: false as const, reason: "unsupported-stage-or-provider" as const };
    const instruction = `${input.stage.toUpperCase()} stage. Do not execute commands unrelated to the task. Work only in this isolated project worktree.${rtk.active ? " RTK command-output filtering is enabled; if a compact result omits needed detail, rerun that command with `rtk bypass <command>`." : ""} Task: ${input.prompt}`;
    return new Promise((resolve, reject) => {
      const child = spawn(spec.executable, spec.args(instruction, input.stage, input.reasoningEffort), { cwd: input.projectRoot, shell: false, windowsHide: true, env: { ...cliProviderEnvironment(), ...spec.env } });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let size = 0; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.stdout.on("data", (b: Buffer) => { size += b.length; if (size < 1_000_000) stdout.push(b); });
      child.stderr.on("data", (b: Buffer) => { if (Buffer.concat(stderr).length < 64_000) stderr.push(b); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer); const out = Buffer.concat(stdout).toString("utf8").trim();
        if (timedOut) return reject(new Error(`${this.id} timed out after ${timeoutMs}ms`));
        if (code !== 0) return reject(new Error(`${this.id} exited ${code}: ${redact(Buffer.concat(stderr).toString("utf8").slice(-3000))}`));
        let summary = out; const metadata: Record<string, unknown> = {};
        if (this.id === "codex") {
          const parsed = parseCodexTelemetry(out);
          summary = parsed.summary ?? out;
          metadata.codexActivity = parsed.telemetry;
          if (input.stage === "implement" && input.reasoningEffort) metadata.reasoningEffort = input.reasoningEffort;
        } else try {
          const value = JSON.parse(out) as Record<string, unknown>;
          const response = value.result ?? value.response ?? value.text;
          if (typeof response === "string") summary = response;
          for (const key of ["model", "model_name", "usage", "total_cost_usd", "costUsd", "duration_ms", "num_turns"]) if (value[key] !== undefined) metadata[key] = value[key];
        } catch { /* plain-text result */ }
        if (input.plugins.some(plugin => plugin.id === "rtk" && plugin.enabled) && input.stage === "implement" && this.id === "codex") {
          metadata.commandOutputFiltering = { tool: "rtk", ...rtk, bypass: "rtk bypass <command>" };
        }
        resolve({ ok: true, summary: redact(summary).slice(0, 8000), findings: [], artifactRefs: [], provider: this.id, durationMs: Date.now() - started, metadata });
      });
      if (this.id === "codex") child.stdin.end(instruction);
    });
  }
}

export class OpenRouterProvider implements AgentProvider {
  readonly id = "openrouter";
  constructor(private readonly apiKey = process.env.OPENROUTER_API_KEY, private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 120_000) {}

  async run(input: StageInput): Promise<StageOutput> {
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY is not configured for the Windows worker");
    if (!input.model) throw new Error("OpenRouter stage is missing its configured model ID");
    const started = Date.now();
    let response: Response;
    try {
      const structuredGemma = /^google\/gemma-4-\d+b(?:-a4b)?-it(?::|$)/.test(input.model) && ["plan", "brief", "review"].includes(input.stage);
      const structuredNemotron = /^nvidia\/nemotron-3-ultra-[^:]+(?::|$)/.test(input.model) && ["plan", "brief", "review"].includes(input.stage);
      const stageTool = structuredNemotron ? {
        type: "function",
        function: {
          name: "submit_structured_result",
          description: "Return the requested stage result as structured JSON.",
          parameters: input.stage === "plan" ? {
            type: "object", additionalProperties: false,
            properties: { task_goal: { type: "string" }, approach: { type: "string" }, important_decisions: { type: "array", items: { type: "string" } }, risks: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, acceptance_criteria: { type: "array", items: { type: "string" } }, hard_constraints: { type: "array", items: { type: "string" } } },
            required: ["task_goal", "approach", "important_decisions", "risks", "acceptance_criteria", "hard_constraints"],
          } : input.stage === "brief" ? {
            type: "object", additionalProperties: false,
            properties: { task_goal: { type: "string" }, files_or_modules: { type: "array", items: { type: "string" } }, must_follow: { type: "array", items: { type: "string" } }, must_avoid: { type: "array", items: { type: "string" } }, implementation_steps: { type: "array", items: { type: "string" } }, verification_steps: { type: "array", items: { type: "string" } }, acceptance_checks: { type: "array", items: { type: "string" } } },
            required: ["task_goal", "files_or_modules", "must_follow", "must_avoid", "implementation_steps", "verification_steps", "acceptance_checks"],
          } : {
            type: "object", additionalProperties: false,
            properties: {
              verdict: { type: "string", enum: ["pass", "needs_changes"] },
              findings: { type: "array", items: { type: "object", additionalProperties: false, properties: { severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] }, category: { type: "string", enum: ["functional", "acceptance", "regression", "security", "accessibility", "tests", "environment", "approval", "polish", "other"] }, title: { type: "string" }, evidence: { type: "string" }, acceptanceCriterion: { type: "string" }, fixableInCode: { type: "boolean" } }, required: ["severity", "category", "title", "evidence", "fixableInCode"] } },
              notes: { type: "array", items: { type: "object", additionalProperties: false, properties: { severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] }, category: { type: "string", enum: ["functional", "acceptance", "regression", "security", "accessibility", "tests", "environment", "approval", "polish", "other"] }, title: { type: "string" }, evidence: { type: "string" }, acceptanceCriterion: { type: "string" }, fixableInCode: { type: "boolean" } }, required: ["severity", "category", "title", "evidence", "fixableInCode"] } },
            }, required: ["verdict", "findings", "notes"],
          },
        },
      } : undefined;
      response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "http-referer": "http://localhost", "x-title": "Paperclip Temporal Orchestrator" },
        body: JSON.stringify({ model: input.model, messages: [{ role: "user", content: `${input.stage.toUpperCase()} stage. Do not execute commands. ${input.stage === "review" ? "Review the implementation according to the review contract in the task prompt. Return the requested structured JSON assessment; deterministic checks are supplied separately." : ""} Task: ${input.prompt}` }], ...(structuredGemma ? { response_format: { type: "json_object" } } : {}), ...(stageTool ? { tools: [stageTool], tool_choice: { type: "function", function: { name: "submit_structured_result" } } } : {}), temperature: 0.2, reasoning_effort: "low", max_tokens: input.stage === "brief" && structuredNemotron ? 4096 : input.stage === "plan" ? 4096 : input.stage === "brief" ? 1100 : 4096 }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error(`OpenRouter request timed out after ${this.timeoutMs}ms`);
      throw new Error(`OpenRouter request failed: ${redact(error instanceof Error ? error.message : "network error").replaceAll(this.apiKey, "[REDACTED]")}`);
    }
    if (!response.ok) {
      const category = response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate limit" : response.status >= 500 ? "server" : "request";
      const detail = redact((await response.text().catch(() => "")).slice(0, 500)).replaceAll(this.apiKey, "[REDACTED]");
      throw new Error(`OpenRouter ${category} error (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    const payload = await response.json() as { model?: string; choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>; usage?: Record<string, unknown> };
    const message = payload.choices?.[0]?.message;
    const toolResult = message?.tool_calls?.find(call => call.function?.name === "submit_structured_result")?.function?.arguments;
    const content = message?.content;
    const summary = typeof toolResult === "string" ? toolResult : typeof content === "string" ? content : Array.isArray(content) ? content.map(part => typeof part === "object" && part && "text" in part ? String(part.text) : "").join("\n") : "";
    if (!summary.trim()) throw new Error("OpenRouter returned no text content");
    const safeSummary = redact(summary).replaceAll(this.apiKey, "[REDACTED]").slice(0, 8000);
    const review = input.stage === "review" ? parseReviewAssessment(safeSummary) : undefined;
    const repairFindings = review?.findings ?? [];
    const blocking = repairFindings.some(f => ["critical", "high"].includes(f.severity) && f.fixableInCode && !["environment", "approval"].includes(f.category));
    const findings = repairFindings.map(f => `[${f.severity}/${f.category}] ${f.title}: ${f.evidence}`);
    const notes = review?.notes.map(f => `[${f.severity}/${f.category}] ${f.title}: ${f.evidence}`) ?? [];
    return { ok: input.stage === "review" ? !blocking && !repairFindings.some(f => f.category === "environment" || f.category === "approval" || !f.fixableInCode) : true, summary: safeSummary, findings, review, artifactRefs: [], provider: this.id, durationMs: Date.now() - started, metadata: { model: payload.model ?? input.model, ...(payload.usage ? { usage: payload.usage } : {}), ...(review ? { review: { blockingCount: repairFindings.filter(f => ["critical", "high"].includes(f.severity) && f.fixableInCode).length, noteCount: notes.length } } : {}) } };
  }
}

export function getProvider(id: string): AgentProvider {
  if (id === "fake") return new FakeProvider();
  if (id === "claude" || id === "codex" || id === "gemini") return new CliProvider(id);
  if (id === "openrouter") return new OpenRouterProvider();
  throw new Error(`unsupported provider '${id}'`);
}
