export type WorkflowProfile = { id: string; stages: Array<"plan" | "brief" | "implement" | "review" | "verify" | "research">; approvalBeforeMerge: boolean; qualityGates: string[] };
export const profiles: Record<string, WorkflowProfile> = {
  implementation: { id: "implementation", stages: ["plan", "brief", "implement", "review", "verify"], approvalBeforeMerge: true, qualityGates: ["review", "verify"] },
  bugfix: { id: "bugfix", stages: ["plan", "brief", "implement", "review", "verify"], approvalBeforeMerge: true, qualityGates: ["review", "verify"] },
  research: { id: "research", stages: ["research", "verify"], approvalBeforeMerge: false, qualityGates: ["verify"] },
  refactor: { id: "refactor", stages: ["plan", "brief", "implement", "review", "verify"], approvalBeforeMerge: true, qualityGates: ["review", "verify"] },
};
