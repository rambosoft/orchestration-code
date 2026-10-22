import { z } from "zod";

export const StageNameSchema = z.enum(["openspec", "spec_optimize", "plan", "brief", "implement", "review", "verify", "research"]);
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
export const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  category: z.enum(["functional", "acceptance", "regression", "security", "accessibility", "tests", "environment", "approval", "polish", "other"]),
  title: z.string().min(1),
  evidence: z.string().min(1),
  acceptanceCriterion: z.string().optional(),
  fixableInCode: z.boolean(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export const ReviewAssessmentSchema = z.object({ verdict: z.enum(["pass", "needs_changes"]), findings: z.array(ReviewFindingSchema).default([]), notes: z.array(ReviewFindingSchema).default([]) });
export type ReviewAssessment = z.infer<typeof ReviewAssessmentSchema>;

export const ProjectManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
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
  providerTimeouts: z.partialRecord(StageNameSchema, z.number().int().positive().max(900_000)).default({}),
  openSpec: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  uiUx: z.object({
    enabled: z.boolean().optional(),
    autoSelect: z.boolean().optional(),
    include: z.array(UiUxSkillIdSchema).optional(),
    exclude: z.array(UiUxSkillIdSchema).optional(),
  }).optional(),
  qualityCommands: z.array(z.object({ executable: z.enum(["node", "npm", "pnpm", "yarn"]), args: z.array(z.string()), cwd: z.string().optional() })).default([]),
  qualityCommandsByProfile: z.record(z.string(), z.array(z.object({ executable: z.enum(["node", "npm", "pnpm", "yarn"]), args: z.array(z.string()), cwd: z.string().optional() }))).default({}),
  repository: z.object({ remote: z.string().min(1).default("origin"), targetBranch: z.string().min(1), integratedBaseBranch: z.string().min(1).optional(), requiredSourcePaths: z.array(z.string().min(1)).default([]) }).optional(),
  plugins: z.array(z.object({ id: z.string(), version: z.string(), capabilities: z.array(z.string()).default([]), dependencies: z.array(z.string()).default([]), compatibility: z.object({ minCoreVersion: z.string().default("0.1.0"), maxCoreVersion: z.string().optional() }).default({ minCoreVersion: "0.1.0" }), required: z.boolean().default(false), enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}), permissions: z.array(z.string()).default([]), errorPolicy: z.object({ maxAttempts: z.number().int().min(1).max(5).default(2), timeoutMs: z.number().int().positive().max(600_000).default(60_000) }).default({ maxAttempts: 2, timeoutMs: 60_000 }) })).default([]),
  policy: z.object({ maxReviewRounds: z.number().int().min(1).max(2).optional(), maxRepairAttempts: z.number().int().min(0).max(3).optional(), maxParallelism: z.number().int().min(1).max(8).default(2), requireApprovalBeforeMerge: z.boolean().default(true) }).default({ maxParallelism: 2, requireApprovalBeforeMerge: true }).transform(policy => ({ ...policy, maxReviewRounds: policy.maxReviewRounds ?? (policy.maxRepairAttempts === undefined ? 2 : Math.max(1, Math.min(2, policy.maxRepairAttempts + 1))) })),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export type ProviderRoute = { provider: "fake" | "claude" | "codex" | "gemini" | "openrouter"; model?: string; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" };
export type PluginRequirement = { id: string; version?: string; capabilities?: string[]; dependencies?: string[]; required: boolean; enabled: boolean; config?: Record<string, unknown>; permissions?: string[]; errorPolicy?: { maxAttempts: number; timeoutMs: number } };
export type StageInput = { runId: string; taskId: string; projectId: string; profile: string; stage: StageName; prompt: string; attempt: number; activityAttempt?: number; provider: string; model?: string; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"; providerTimeoutMs?: number; projectRoot: string; artifactsDir: string; plugins: PluginRequirement[]; qualityCommands?: Array<{ executable: "node" | "npm" | "pnpm" | "yarn"; args: string[]; cwd?: string }>; verificationOnly?: boolean; deterministicChecksAlreadyPassed?: boolean; openSpecChangeId?: string };
export type StageOutput = { stage?: StageName; ok: boolean; summary: string; findings: string[]; review?: ReviewAssessment; artifactRefs: string[]; provider: string; durationMs: number; metadata?: Record<string, unknown> };
export const StageOutputSchema = z.object({ stage: StageNameSchema.optional(), ok: z.boolean(), summary: z.string(), findings: z.array(z.string()), review: ReviewAssessmentSchema.optional(), artifactRefs: z.array(z.string()), provider: z.string(), durationMs: z.number().nonnegative(), metadata: z.record(z.string(), z.unknown()).optional() });
export type RepositoryContext = { remote: string; targetBranch: string; branch: string; baseSha: string; prBaseBranch: string; taskTitle: string; requiredSourcePaths?: string[] };
export type ParentPublication = { issueId: string; branch: string; headSha: string; prUrl: string };
export type OpenSpecRunInfo = { changeId: string; version: string; contextArtifact: string; archivedPath?: string };
export type OpenSpecPrepared = { changeId: string; version: string; artifactRef: string };
export type OpenSpecContext = { context: string; artifactRef: string; version: string };
export type RunInput = { runId: string; taskId: string; taskRevision?: string; attempt?: number; blockerIds?: string[]; parentPublications?: ParentPublication[]; projectId: string; profile: string; prompt: string; openSpec?: boolean; uiUx?: UiUxConfig; uiUxFrameworks?: string[]; provider?: ProviderRoute["provider"]; providerRouting?: Partial<Record<StageName, ProviderRoute>>; providerTimeouts?: Partial<Record<StageName, number>>; projectRoot: string; artifactsDir: string; repository?: RepositoryContext; approval?: boolean; maxReviewRounds?: number; /** @deprecated Use maxReviewRounds; legacy repair counts are capped at two total review rounds. */ maxRepairAttempts?: number; maxParallelism?: number; injectReviewFailure?: boolean; repeatReviewFailure?: boolean; injectActivityTimeout?: boolean; plugins?: PluginRequirement[]; qualityCommands?: Array<{ executable: "node" | "npm" | "pnpm" | "yarn"; args: string[]; cwd?: string }> };
export type PublishResult = { branch: string; baseSha: string; headSha: string; prUrl: string; prBaseBranch: string };
export type RunResult = { runId: string; status: "completed" | "failed" | "rejected"; stages: StageOutput[]; artifactRefs: string[]; message: string; metadata?: { review: { maxReviewRounds: number; reviewCount: number; repairCount: number; findingsFixed: number; reviewRuns: Array<{ round: number; provider: string; durationMs: number; verdict: "pass" | "needs_changes" | "unstructured"; blockingFindingCount: number; nonBlockingNoteCount: number; usage?: unknown }>; nonBlockingNotes: ReviewFinding[]; unresolvedFindings: ReviewFinding[]; stopReason?: string }; openSpec?: OpenSpecRunInfo }; publish?: PublishResult };
