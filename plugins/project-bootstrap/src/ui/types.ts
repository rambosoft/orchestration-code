export type OptionValue = string | boolean;
export type OptionChoice = { value: string; label: string; help?: string };
export type OptionDef = { id: string; group: string; label: string; help: string; kind: "select" | "toggle" | "text"; choices?: OptionChoice[]; default: OptionValue; advanced: boolean };
export type Catalog = {
  groups: Array<{ id: string; label: string }>;
  options: OptionDef[];
  maturities: Array<{ id: string; effects: Array<{ id: string; label: string; value: OptionValue }> }>;
  templates: Array<{ id: string; label: string; description: string }>;
};
export type Resolved = { values: Record<string, OptionValue>; provenance: Record<string, string>; warnings: string[]; errors: string[] };

export type Milestone = { key: string; title: string; goal: string; exit_criteria: string[]; tasks: Array<{ key: string; title: string; description: string; type: string; acceptance: string[]; depends_on: string[] }> };
export type BootState = {
  phase: "planning" | "awaiting_approval" | "creating" | "done"; warnings: string[]; summary?: string;
  stack?: { summary: string; language: string; architecture: string; template_id: string; rationale: string; frameworks: Array<{ name: string; role: string; why: string }>; alternatives: Array<{ name: string; why_not: string }>; assumptions: string[]; risks: string[] };
  charter?: { vision: string; goals: string[]; non_goals: string[]; boundaries: string[]; constraints: string[]; design_rules: string[]; open_questions: string[] };
  blueprint?: { summary: string; milestones: Milestone[] };
};
export type RunResult = { status: string; message: string; bootstrap?: { repositoryUrl?: string; projectRoot: string; template: string; warnings: string[]; issues: Array<{ id: string; title: string; kind: string; status: string }> }; metadata?: { warnings?: Array<{ stage: string; message: string }> } };
export type RunStatus = { found: boolean; workflowId?: string; run?: { status: string; progress?: { currentStage: string | null; completedStages: string[] }; bootstrap?: BootState; result?: RunResult } };
export type IssueRow = { id: string; identifier?: string; title: string; status: string; labels?: Array<{ name: string }> };
