// Lanes and tiers (ADR 0015): which stages a task needs. A project has a tier (how finished it must be: the bootstrap maturity), a task has a lane (how big and risky it is). The pair picks the stage list
// from one table, so a prototype task is implement + verify and a production task is the full pipeline. Pure and workflow-safe (no clock, no I/O); the choice is carried in the run input, so a run
// recorded before this existed has no lane and keeps the profile's own stage list.
export const TIERS = ["throwaway", "prototype", "mvp", "production"] as const;
export type Tier = (typeof TIERS)[number];
export const LANES = ["light", "standard", "heavy"] as const;
export type Lane = (typeof LANES)[number];
export type LaneStage = "plan" | "brief" | "implement" | "review" | "verify";
export type SizeHint = "small" | "normal" | "large";
export type LanePlan = {
  stages: LaneStage[];
  /** Spec-driven proposal (OpenSpec) before planning. */
  openSpec: boolean;
  /** Approach analysis before planning. */
  analysis: boolean;
  /** Without a review stage, a risky result still gets one (see escalationReasons). */
  escalation: boolean;
};

/** The lane of a task: an explicit "Lane:" line wins, otherwise the size the blueprint gave it. */
/** The title every milestone check task starts with (src/bootstrap.ts writes it, the workflow recognises it): a check that finds nothing to change is a result, not a failed publish (ADR 0026). */
export const MILESTONE_CHECK_PREFIX = "Check milestone:";
export function laneFor(size?: SizeHint, override?: Lane): Lane {
  return override ?? (size === "small" ? "light" : size === "large" ? "heavy" : "standard");
}

export const isMilestoneCheckTitle = (title?: string): boolean => title?.startsWith(MILESTONE_CHECK_PREFIX) ?? false;

/** ADR 0029: a prototype reviews once per milestone, in the check task, which always runs heavy; no other task of it runs heavier than standard, whatever size the blueprint gave it. Other tiers keep the lane as named. */
export function effectiveLane(tier: Tier, lane: Lane, taskTitle?: string): Lane {
  if (tier !== "prototype") return lane;
  return isMilestoneCheckTitle(taskTitle) ? "heavy" : lane === "heavy" ? "standard" : lane;
}

/** ADR 0029: on a prototype, commands marked `scope: "milestone"` gate only the milestone check task. Never leaves a task without a gate: when every command is milestone-scoped they all stay. */
export function gateCommandsFor<T extends { scope?: "milestone" }>(tier: Tier | undefined, commands: readonly T[], taskTitle?: string): T[] {
  if (tier !== "prototype" || isMilestoneCheckTitle(taskTitle)) return [...commands];
  const perTask = commands.filter(command => command.scope !== "milestone");
  return perTask.length > 0 ? perTask : [...commands];
}

const DIRECT: LaneStage[] = ["implement", "verify"];
// Plan and brief are model calls. Without them the brief is built from the task text (src/fallbacks.ts), which already carries the acceptance criteria.
const TABLE: Record<Tier, Record<Lane, LanePlan>> = {
  throwaway: {
    light: { stages: DIRECT, openSpec: false, analysis: false, escalation: true },
    standard: { stages: DIRECT, openSpec: false, analysis: false, escalation: true },
    heavy: { stages: ["plan", "implement", "verify"], openSpec: false, analysis: false, escalation: true },
  },
  prototype: {
    light: { stages: DIRECT, openSpec: false, analysis: false, escalation: true },
    standard: { stages: DIRECT, openSpec: false, analysis: false, escalation: true },
    heavy: { stages: ["plan", "implement", "review", "verify"], openSpec: false, analysis: false, escalation: false },
  },
  mvp: {
    light: { stages: DIRECT, openSpec: false, analysis: false, escalation: true },
    standard: { stages: ["plan", "implement", "review", "verify"], openSpec: false, analysis: false, escalation: false },
    heavy: { stages: ["plan", "brief", "implement", "review", "verify"], openSpec: false, analysis: false, escalation: false },
  },
  production: {
    light: { stages: ["implement", "review", "verify"], openSpec: false, analysis: false, escalation: false },
    standard: { stages: ["plan", "brief", "implement", "review", "verify"], openSpec: false, analysis: false, escalation: false },
    heavy: { stages: ["plan", "brief", "implement", "review", "verify"], openSpec: true, analysis: true, escalation: false },
  },
};

export function lanePlan(tier: Tier, lane: Lane): LanePlan {
  const plan = TABLE[tier][lane];
  return { ...plan, stages: [...plan.stages] };
}

/** Profiles whose stage list the lane replaces; bug, research and the other typed flows keep their own. */
export const LANE_PROFILES: readonly string[] = ["implementation", "refactor"];

export const ESCALATION = { maxFiles: 15, maxLines: 600 } as const;
const RISKY_PATH = /(^|\/)(auth|security|crypto|payments?|billing|migrations?|schema|secrets?|\.github|docker-compose[^/]*|dockerfile)(\/|\.|$)|\.(sql|env|pem|key)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|tests?\.cs$/i;
/** `countedFiles` (ADR 0029) leaves out generated and binary files (.meta, images, audio, fonts) for the file-count limit only; results recorded without it count every file, so replay is unchanged. */
export type ChangeStats = { files: string[]; lines: number; deletedFiles: string[]; countedFiles?: string[] };

/** Why a result that skipped review should get one anyway. Empty means the lane's own stage list stands. */
export function escalationReasons(stats: ChangeStats, unmetAcceptance: boolean): string[] {
  const reasons: string[] = [];
  if (unmetAcceptance) reasons.push("the implementer reported acceptance criteria it did not meet");
  const counted = (stats.countedFiles ?? stats.files).length;
  if (counted > ESCALATION.maxFiles) reasons.push(`${counted} files changed (limit ${ESCALATION.maxFiles})`);
  if (stats.lines > ESCALATION.maxLines) reasons.push(`${stats.lines} lines changed (limit ${ESCALATION.maxLines})`);
  const risky = stats.files.filter(file => RISKY_PATH.test(file.replace(/\\/g, "/")));
  if (risky.length) reasons.push(`touches security, data or deployment paths (${risky.slice(0, 3).join(", ")})`);
  const removedTests = stats.deletedFiles.filter(file => TEST_PATH.test(file.replace(/\\/g, "/")));
  if (removedTests.length) reasons.push(`deletes test files (${removedTests.slice(0, 3).join(", ")})`);
  return reasons;
}
