import { z } from "zod";

// Task types are the user-facing concept (a Paperclip label, a "Type:" line); a profile is the delivery stage list a type reuses (src/profiles.ts).
// A run with no taskType takes the original pipeline unchanged, which keeps in-flight Temporal runs replayable.
export const TaskTypeIdSchema = z.enum(["task", "bug", "research", "architecture", "bootstrap"]);
export type TaskTypeId = z.infer<typeof TaskTypeIdSchema>;
/** delivery: plan -> brief -> implement -> review -> verify. bug: investigate first, then delivery. investigation: read-only exploration that ends in a document. */
export type TaskFlow = "delivery" | "bug" | "investigation" | "bootstrap";
export type TaskTypeDefinition = {
  id: TaskTypeId; label: string; profile: string; flow: TaskFlow;
  /** What the run produces: a code change or a committed document (a draft PR), or a whole project (repository, manifest and Paperclip issues). */
  delivers: "code" | "document" | "project";
  /** Names accepted from labels, directives and API fields (lower case). */
  aliases: string[];
  /** Ordered phases, for documentation and progress display only; the workflow owns the real sequence. */
  phases: string[];
};

export const taskTypes: Record<TaskTypeId, TaskTypeDefinition> = {
  task: { id: "task", label: "Task / feature", profile: "implementation", flow: "delivery", delivers: "code", aliases: ["task", "feature", "implementation", "story", "enhancement"], phases: ["plan", "brief", "implement", "review", "verify"] },
  bug: { id: "bug", label: "Bug / issue", profile: "bug", flow: "bug", delivers: "code", aliases: ["bug", "defect", "bugfix", "regression", "issue"], phases: ["diagnose", "reproduce", "plan", "brief", "implement", "review", "verify"] },
  research: { id: "research", label: "Research / exploration", profile: "investigation", flow: "investigation", delivers: "document", aliases: ["research", "explore", "exploration", "spike", "investigation"], phases: ["scope", "context", "explore", "report"] },
  architecture: { id: "architecture", label: "Architecture", profile: "investigation", flow: "investigation", delivers: "document", aliases: ["architecture", "arch", "design", "adr"], phases: ["scope", "context", "explore", "report"] },
  bootstrap: { id: "bootstrap", label: "Project bootstrap", profile: "bootstrap", flow: "bootstrap", delivers: "project", aliases: ["bootstrap", "new-project", "project-setup"], phases: ["stack", "charter", "blueprint", "approval", "scaffold", "issues"] },
};

const lookup = new Map<string, TaskTypeId>(Object.values(taskTypes).flatMap(type => type.aliases.map(alias => [alias, type.id] as const)));
/** Aliases too common as ordinary label text to count when a label is not written as "type:<name>". */
const AMBIGUOUS_BARE = new Set(["issue", "design", "task", "implementation", "investigation", "arch"]);

export function normalizeTaskType(value: unknown): TaskTypeId | undefined {
  return typeof value === "string" ? lookup.get(value.trim().toLowerCase()) : undefined;
}

/** A legacy agent profile that implies a type. "implementation" stays untyped so its runs keep the original path. */
export function taskTypeFromProfile(profile: string | undefined): TaskTypeId | undefined {
  return profile === "bugfix" ? "bug" : profile === "research" ? "research" : profile === "architecture" ? "architecture" : undefined;
}

/** "type:bug", "type/bug", "kind: bug" or a bare, unambiguous "bug" label. */
function labelType(label: string): TaskTypeId | undefined {
  const text = label.trim().toLowerCase();
  const prefixed = /^(?:type|kind|issue[- ]type)\s*[:/]\s*(.+)$/.exec(text);
  if (prefixed) return normalizeTaskType(prefixed[1]);
  return AMBIGUOUS_BARE.has(text) ? undefined : normalizeTaskType(text);
}

export type TaskTypeSource = "api" | "label" | "directive" | "profile" | "default";
/**
 * One precedence everywhere: explicit API field, then Paperclip labels, then a "Type:" line in the task text, then the agent profile.
 * Conflicting labels are an error rather than a guess. Undefined means the original, untyped pipeline.
 */
export function resolveTaskType(input: { apiType?: string; labels?: string[]; directive?: string; profile?: string }): { type?: TaskTypeId; source: TaskTypeSource; error?: string } {
  if (input.apiType !== undefined) {
    const type = normalizeTaskType(input.apiType);
    return type ? { type, source: "api" } : { source: "api", error: `unknown task type '${input.apiType}'; use one of: ${Object.keys(taskTypes).join(", ")}` };
  }
  const fromLabels = [...new Set((input.labels ?? []).map(labelType).filter((type): type is TaskTypeId => type !== undefined))];
  if (fromLabels.length > 1) return { source: "label", error: `the task carries conflicting type labels (${fromLabels.join(", ")}); keep one` };
  if (fromLabels.length === 1) return { type: fromLabels[0]!, source: "label" };
  if (input.directive !== undefined) {
    const type = normalizeTaskType(input.directive);
    return type ? { type, source: "directive" } : { source: "directive", error: `unknown task type '${input.directive}' in the task text; use one of: ${Object.keys(taskTypes).join(", ")}` };
  }
  const fromProfile = taskTypeFromProfile(input.profile);
  return fromProfile ? { type: fromProfile, source: "profile" } : { source: "default" };
}
