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
export type ChangeStats = { files: string[]; lines: number; deletedFiles: string[] };

/** Why a result that skipped review should get one anyway. Empty means the lane's own stage list stands. */
export function escalationReasons(stats: ChangeStats, unmetAcceptance: boolean): string[] {
  const reasons: string[] = [];
  if (unmetAcceptance) reasons.push("the implementer reported acceptance criteria it did not meet");
  if (stats.files.length > ESCALATION.maxFiles) reasons.push(`${stats.files.length} files changed (limit ${ESCALATION.maxFiles})`);
  if (stats.lines > ESCALATION.maxLines) reasons.push(`${stats.lines} lines changed (limit ${ESCALATION.maxLines})`);
  const risky = stats.files.filter(file => RISKY_PATH.test(file.replace(/\\/g, "/")));
  if (risky.length) reasons.push(`touches security, data or deployment paths (${risky.slice(0, 3).join(", ")})`);
  const removedTests = stats.deletedFiles.filter(file => TEST_PATH.test(file.replace(/\\/g, "/")));
  if (removedTests.length) reasons.push(`deletes test files (${removedTests.slice(0, 3).join(", ")})`);
  return reasons;
}
