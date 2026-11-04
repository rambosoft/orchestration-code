// Admission of a task's stage list and size (task-size gate): the bridge resolves which stages a code task runs (task "Stages:" line, else the manifest's `lanes`, else the lane table) and estimates the task's size from its text.
// Pure and I/O-free so it can be tested without the bridge. A large estimate only warns: the run continues (operator ruling).
import type { ProjectManifest, RunInput } from "./contracts.js";
import type { Lane, LaneStage } from "./lanes.js";
import { estimateSize, filesNamedIn, sizeLimitsFor } from "./task-size.js";

type Admission = Pick<RunInput, "stageList" | "stageListReason" | "sizing" | "size" | "sizeWarning">;

/** `lane` is set only for a code task of a tier project; without it no stage list is resolved. Throws the message the bridge answers with HTTP 400. */
export function admitStages(input: { project: Pick<ProjectManifest, "tier" | "sizing" | "lanes">; lane?: Lane; stages?: LaneStage[]; prompt: string }): Admission {
  const { project, lane } = input, out: Admission = {};
  const fromManifest = lane ? project.lanes?.[lane] : undefined;
  const stageList = lane ? input.stages ?? fromManifest : undefined;
  if (stageList) {
    if (!stageList.includes("implement") || !stageList.includes("verify")) throw new Error("a code task cannot skip implement or verify");
    out.stageList = [...stageList]; out.stageListReason = input.stages ? "task Stages line" : `manifest lanes.${lane}`;
  }
  if (project.tier || project.sizing) {
    const limits = sizeLimitsFor(project), named = filesNamedIn(input.prompt);
    out.sizing = { firstEditMinutes: project.sizing?.firstEditMinutes ?? 15, idleMinutes: project.sizing?.idleMinutes ?? 10, largeMinFiles: limits.largeMinFiles };
    out.size = estimateSize({ files: named, basis: "text" }, limits);
    if (out.size.hint === "large") out.sizeWarning = `task names ${out.size.files} files in ${out.size.areas} areas; limit is ${limits.largeMinFiles} files / ${limits.maxAreas} areas`;
  }
  return out;
}
