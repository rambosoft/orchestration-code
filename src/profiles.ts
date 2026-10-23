export type WorkflowProfile = { id: string; stages: Array<"plan" | "brief" | "implement" | "review" | "verify" | "research">; approvalBeforeMerge: boolean; qualityGates: string[] };
export const profiles: Record<string, WorkflowProfile> = {
  implementation: { id: "implementation", stages: ["plan", "brief", "implement", "review", "verify"], approvalBeforeMerge: true, qualityGates: ["review", "verify"] },
  bugfix: { id: "bugfix", stages: ["plan", "brief", "implement", "review", "verify"], approvalBeforeMerge: true, qualityGates: ["review", "verify"] },
  research: { id: "research", stages: ["research", "verify"], approvalBeforeMerge: false, qualityGates: ["verify"] },
  // bug: diagnose + reproduce run before these stages; investigation: read-only phases that end in a committed document, so no delivery stages (src/task-types.ts).
  bug: { id: "bug", stages: ["plan", "brief", "implement", "review", "verify"], approvalBeforeMerge: true, qualityGates: ["review", "verify"] },
  investigation: { id: "investigation", stages: [], approvalBeforeMerge: false, qualityGates: [] },
  refactor: { id: "refactor", stages: ["plan", "brief", "implement", "review", "verify"], approvalBeforeMerge: true, qualityGates: ["review", "verify"] },
};
