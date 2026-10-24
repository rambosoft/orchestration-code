import { z } from "zod";

import type { TaskTypeId } from "./task-types.js";
import { CORE_EXECUTABLES, STACK_PROFILE_IDS, stackCommandProblems } from "./stack-profiles.js";
import type { BootstrapOutcome, BootstrapRunInput } from "./bootstrap.js";

export const StageNameSchema = z.enum(["openspec", "spec_optimize", "analyze", "plan", "brief", "implement", "review", "verify", "research", "diagnose", "reproduce", "scope", "explore", "stack", "charter", "blueprint"]);
export type StageName = z.infer<typeof StageNameSchema>;
export const ProviderIdSchema = z.enum(["fake", "claude", "codex", "gemini", "openrouter"]);
export const UiUxSkillIdSchema = z.enum(["ui-ux-pro-max", "frontend-design", "vercel-composition-patterns", "vercel-react-native-skills"]);
export type UiUxSkillId = z.infer<typeof UiUxSkillIdSchema>;
export const UiUxConfigSchema = z.object({
  enabled: z.boolean(),
  autoSelect: z.boolean(),
  include: z.array(UiUxSkillIdSchema),
  exclude: z.array(UiUxSkillIdSchema),
});
export type UiUxConfig = z.infer<typeof UiUxConfigSchema>;
const ToolExecutableSchema = z.enum(CORE_EXECUTABLES);
/** `unity` is accepted by the schema but the manifest only allows it for the unity-mobile stack profile (see stackCommandProblems). */
const QualityExecutableSchema = z.enum([...CORE_EXECUTABLES, "unity"]);
/** severity "warn": a failing command is reported as a warning and never stops the run (for example a first knip or jscpd report). Default "fail". */
export const QualityCommandSchema = z.object({ executable: QualityExecutableSchema, args: z.array(z.string()), cwd: z.string().optional(), severity: z.enum(["fail", "warn"]).optional() });
export type QualityCommand = z.infer<typeof QualityCommandSchema>;
export const VisualStepSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("press"), key: z.string().min(1).max(32) }),
  z.object({ do: z.literal("wait"), ms: z.number().int().min(0).max(10_000) }),
  z.object({ do: z.literal("click"), selector: z.string().min(1).max(200) }),
  z.object({ do: z.literal("shot"), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "shot names are lowercase letters, digits and dashes") }),
]);
/** Optional screenshot capture of the running app for the reviewer (ADR 0007). The page must be served on this machine. */
export const VisualConfigSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.object({ executable: ToolExecutableSchema, args: z.array(z.string()), cwd: z.string().optional() }),
  url: z.string().url().refine(value => /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(value), "visual.url must be an http://localhost, 127.0.0.1 or [::1] address"),
  readyTimeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
  viewports: z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,20}$/), width: z.number().int().min(200).max(3840), height: z.number().int().min(200).max(2160) })).min(1).max(3).default([{ name: "desktop", width: 1280, height: 720 }]),
  steps: z.array(VisualStepSchema).min(1).max(40).default([{ do: "shot", name: "initial" }]),
  maxImages: z.number().int().min(1).max(8).default(6),
  /** true: a capture that cannot be produced fails the review instead of only warning. */
  required: z.boolean().default(false),
});
export type VisualConfig = z.infer<typeof VisualConfigSchema>;
export const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  category: z.enum(["functional", "acceptance", "regression", "security", "accessibility", "tests", "environment", "approval", "polish", "other"]),
  title: z.string().min(1),
  evidence: z.string().min(1),
  acceptanceCriterion: z.string().optional(),
  fixableInCode: z.boolean(),
  /** A concrete input or state and the wrong result it produces. Required for a blocking finding to stand in a follow-up review. */
  scenario: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export const ReviewAssessmentSchema = z.object({ verdict: z.enum(["pass", "needs_changes"]), findings: z.array(ReviewFindingSchema).default([]), notes: z.array(ReviewFindingSchema).default([]) });
export type ReviewAssessment = z.infer<typeof ReviewAssessmentSchema>;

const RelativeDirSchema = z.string().min(1).refine(dir => !dir.startsWith("/") && !/^[A-Za-z]:/.test(dir) && !dir.split(/[\\/]/).includes(".."), "a document directory must be a relative path inside the repository");
export const ProjectManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  /** Readable alternative ids (the id itself is usually the Paperclip project UUID). */
  aliases: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/)).default([]),
  name: z.string().min(1),
  root: z.string().min(1),
  rootEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  containerRoot: z.string().min(1).optional(),
  defaultProfile: z.string().min(1),
  providers: z.object({ default: ProviderIdSchema.optional() }).default({}),
  providerRouting: z.partialRecord(StageNameSchema, z.object({
    provider: ProviderIdSchema,
    model: z.string().min(1).optional(),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  })).default({}).superRefine((routes, ctx) => {
    for (const [stage, route] of Object.entries(routes)) {
      if (route.provider === "openrouter" && !route.model) ctx.addIssue({ code: "custom", path: [stage, "model"], message: "OpenRouter routes require a model ID" });
    }
  }),
  providerTimeouts: z.partialRecord(StageNameSchema, z.number().int().positive().max(14_400_000)).default({}),
  openSpec: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  // Optional analysis stage (approach comparison, chosen parameters, validation properties). A task can override with an "Analysis: on|off" line.
  analysis: z.object({
    enabled: z.boolean().default(false),
    docsDir: RelativeDirSchema.default("docs/analysis"),
  }).default({ enabled: false, docsDir: "docs/analysis" }),
  // Where research and architecture reports are committed (draft PR). Bug diagnoses go to analysis.docsDir.
  documents: z.object({ researchDir: RelativeDirSchema.default("docs/research"), architectureDir: RelativeDirSchema.default("docs/architecture") }).default({ researchDir: "docs/research", architectureDir: "docs/architecture" }),
  uiUx: z.object({
    enabled: z.boolean().optional(),
    autoSelect: z.boolean().optional(),
    include: z.array(UiUxSkillIdSchema).optional(),
    exclude: z.array(UiUxSkillIdSchema).optional(),
  }).optional(),
  visual: VisualConfigSchema.optional(),
  /** Toolchain profile (src/stack-profiles.ts). Absent means node-web, today's behaviour. */
  stack: z.object({
    profile: z.enum(STACK_PROFILE_IDS).default("node-web"),
    unity: z.object({
      editorVersion: z.string().regex(/^\d{4}\.\d+\.\d+[abfp]\d+$/, "a Unity editor version such as 6000.3.11f1").optional(),
      /** Static C# methods quality commands may name with --execute-method. */
      executeMethods: z.array(z.string().regex(/^[A-Za-z_][\w.]*\.[A-Za-z_]\w*$/)).max(10).default([]),
    }).default({ executeMethods: [] }),
  }).optional(),
  qualityCommands: z.array(QualityCommandSchema).default([]),
  qualityCommandsByProfile: z.record(z.string(), z.array(QualityCommandSchema)).default({}),
  repository: z.object({ remote: z.string().min(1).default("origin"), targetBranch: z.string().min(1), integratedBaseBranch: z.string().min(1).optional(), requiredSourcePaths: z.array(z.string().min(1)).default([]) }).optional(),
  plugins: z.array(z.object({ id: z.string(), version: z.string(), capabilities: z.array(z.string()).default([]), dependencies: z.array(z.string()).default([]), compatibility: z.object({ minCoreVersion: z.string().default("0.1.0"), maxCoreVersion: z.string().optional() }).default({ minCoreVersion: "0.1.0" }), required: z.boolean().default(false), enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}), permissions: z.array(z.string()).default([]), errorPolicy: z.object({ maxAttempts: z.number().int().min(1).max(5).default(2), timeoutMs: z.number().int().positive().max(600_000).default(60_000) }).default({ maxAttempts: 2, timeoutMs: 60_000 }) })).default([]),
  policy: z.object({ maxReviewRounds: z.number().int().min(1).max(4).optional(), maxRepairAttempts: z.number().int().min(0).max(3).optional(), maxParallelism: z.number().int().min(1).max(8).default(2), requireApprovalBeforeMerge: z.boolean().default(true) }).default({ maxParallelism: 2, requireApprovalBeforeMerge: true }).transform(policy => ({ ...policy, maxReviewRounds: policy.maxReviewRounds ?? (policy.maxRepairAttempts === undefined ? 2 : Math.max(1, Math.min(4, policy.maxRepairAttempts + 1))) })),
}).superRefine((manifest, ctx) => {
  const commands = [
    ...manifest.qualityCommands.map((command, index) => ({ where: `qualityCommands.${index}`, path: ["qualityCommands", index, "executable"] as Array<string | number>, command })),
    ...Object.entries(manifest.qualityCommandsByProfile).flatMap(([profile, list]) => list.map((command, index) => ({ where: `qualityCommandsByProfile.${profile}.${index}`, path: ["qualityCommandsByProfile", profile, index, "executable"] as Array<string | number>, command }))),
  ];
  for (const problem of stackCommandProblems(manifest.stack, commands)) ctx.addIssue({ code: "custom", path: commands.find(entry => entry.where === problem.where)!.path, message: problem.message });
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export type ProviderRoute = { provider: "fake" | "claude" | "codex" | "gemini" | "openrouter"; model?: string; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" };
export type PluginRequirement = { id: string; version?: string; capabilities?: string[]; dependencies?: string[]; required: boolean; enabled: boolean; config?: Record<string, unknown>; permissions?: string[]; errorPolicy?: { maxAttempts: number; timeoutMs: number } };
export type StageInput = { runId: string; taskId: string; projectId: string; profile: string; stage: StageName; prompt: string; attempt: number; activityAttempt?: number; provider: string; model?: string; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"; providerTimeoutMs?: number; projectRoot: string; artifactsDir: string; plugins: PluginRequirement[]; qualityCommands?: QualityCommand[]; verificationOnly?: boolean; deterministicChecksAlreadyPassed?: boolean; openSpecChangeId?: string; /** Review only: screenshot capture settings (ADR 0007). */ visual?: VisualConfig; /** Image files attached to the prompt by providers that accept images. */ images?: string[] };
export type StageOutput = { stage?: StageName; ok: boolean; summary: string; findings: string[]; review?: ReviewAssessment; artifactRefs: string[]; provider: string; durationMs: number; metadata?: Record<string, unknown> };
export const StageOutputSchema = z.object({ stage: StageNameSchema.optional(), ok: z.boolean(), summary: z.string(), findings: z.array(z.string()), review: ReviewAssessmentSchema.optional(), artifactRefs: z.array(z.string()), provider: z.string(), durationMs: z.number().nonnegative(), metadata: z.record(z.string(), z.unknown()).optional() });
export type RepositoryContext = { remote: string; targetBranch: string; branch: string; baseSha: string; prBaseBranch: string; taskTitle: string; requiredSourcePaths?: string[]; /** Several blockers and no configured integratedBaseBranch: the worker builds the base for this task by merging the blockers' published branches (ADR 0011). baseSha and prBaseBranch are then a placeholder and the target the worker confirms. */ integrateParents?: boolean };
export type ParentPublication = { issueId: string; branch: string; headSha: string; prUrl: string };
export type OpenSpecRunInfo = { changeId: string; version: string; contextArtifact: string; archivedPath?: string };
export type OpenSpecPrepared = { changeId: string; version: string; artifactRef: string };
export type OpenSpecContext = { context: string; artifactRef: string; version: string; /** Style-only validator findings that were ignored. */ warnings?: string[] };
export type RunInput = { runId: string; taskId: string; taskRevision?: string; attempt?: number; blockerIds?: string[]; parentPublications?: ParentPublication[]; /** The bounded project contract block (ADR 0011) put in front of the implement, review and plan prompts; absent when the repository has no contract file. */ projectContract?: string; projectId: string; profile: string; prompt: string; openSpec?: boolean; /** Run the analysis stage before planning. */ analysis?: boolean; /** Repository-relative folder for the committed analysis document. */ analysisDocsDir?: string; uiUx?: UiUxConfig; uiUxFrameworks?: string[]; visual?: VisualConfig; provider?: ProviderRoute["provider"]; providerRouting?: Partial<Record<StageName, ProviderRoute>>; providerTimeouts?: Partial<Record<StageName, number>>; projectRoot: string; artifactsDir: string; repository?: RepositoryContext; approval?: boolean; /** Wait limit for a human decision; default 24h. */ approvalTimeoutMs?: number; maxReviewRounds?: number; /** @deprecated Use maxReviewRounds; legacy repair counts are capped at two total review rounds. */ maxRepairAttempts?: number; maxParallelism?: number; injectReviewFailure?: boolean; repeatReviewFailure?: boolean; injectActivityTimeout?: boolean; plugins?: PluginRequirement[]; qualityCommands?: QualityCommand[]; /** Absent: the original pipeline for `profile`. Set: the typed flow of src/task-types.ts (bug investigation, research and architecture reports). */ taskType?: TaskTypeId; /** Repository-relative folder for the committed research or architecture report. */ documentsDir?: string; /** Project bootstrap (ADR 0009): the validated form and resolved options. */ bootstrap?: BootstrapRunInput };
export type PublishResult = { branch: string; baseSha: string; headSha: string; prUrl: string; prBaseBranch: string; /** Open PRs of earlier runs of the same task that this publication closed. */ superseded?: string[] };
/** needs_info: a bug that could be neither reproduced nor traced; the message says what the reporter has to add. Not a failure of the orchestrator. needs_review: gates passed and a draft PR is published, but blocking review findings remain after the last round; they are in a PR comment for a human to accept or send back. */
export type RunResult = { runId: string; status: "completed" | "failed" | "rejected" | "needs_info" | "needs_review"; stages: StageOutput[]; artifactRefs: string[]; message: string; metadata?: { review: { maxReviewRounds: number; reviewCount: number; repairCount: number; findingsFixed: number; reviewRuns: Array<{ round: number; provider: string; durationMs: number; verdict: "pass" | "needs_changes" | "unstructured"; blockingFindingCount: number; nonBlockingNoteCount: number; usage?: unknown }>; nonBlockingNotes: ReviewFinding[]; unresolvedFindings: ReviewFinding[]; stopReason?: string }; openSpec?: OpenSpecRunInfo; /** Things that did not stop the run but deserve a look: deterministic fallbacks used, size warnings, skipped analysis. */ warnings?: Array<{ stage: string; message: string }>; taskType?: TaskTypeId }; publish?: PublishResult; /** Research and architecture runs: the report that is also committed as a document; the Paperclip adapter posts it as the issue comment. */ report?: { title: string; markdown: string }; /** Project bootstrap: what was created (repository, manifest, Paperclip issues). */ bootstrap?: BootstrapOutcome };
