export function resolveOpenSpecEnabled(projectEnabled: boolean, taskOverride?: boolean): boolean {
  return taskOverride ?? projectEnabled;
}

export function shouldRunOpenSpec(enabled: boolean | undefined, profileStages: readonly string[]): boolean {
  return enabled === true && profileStages.includes("implement");
}

export function parseOpenSpecTaskPrompt(prompt: string): { prompt: string; override?: boolean; error?: string } {
  const lines = prompt.split(/\r?\n/);
  const directives = lines.map((line, index) => ({ index, match: /^\s*OpenSpec\s*:\s*(on|off)\s*$/i.exec(line) }))
    .filter((item): item is { index: number; match: RegExpExecArray } => item.match !== null);
  const values = new Set(directives.map(item => item.match[1]!.toLowerCase() === "on"));
  if (values.size > 1) return { prompt, error: "task contains conflicting OpenSpec on/off directives" };
  const removed = new Set(directives.map(item => item.index));
  const clean = lines.filter((_line, index) => !removed.has(index)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { prompt: clean, ...(directives.length ? { override: values.has(true) } : {}) };
}

export function openSpecProposalPrompt(input: { taskPrompt: string; changeId: string }): string {
  return `Use the $openspec-propose skill installed in this project to create the complete spec-driven proposal for change "${input.changeId}". This is the specification stage only: do not edit product code or implement the change. The orchestration has already created this change as an empty scaffold for this run; populate that scaffold and do not treat it as a pre-existing user proposal. Inspect the existing application, tests, documentation, and OpenSpec specs first. Convert the task into observable, testable requirements and a practical task checklist. Write proposal.md, at least one meaningful delta spec when behavior changes, design.md when the change needs a design decision, and tasks.md. This is an unattended workflow: do not ask the user follow-up questions. If the request is underspecified, infer the smallest useful scope consistent with repository evidence, preserve observed behavior, and record assumptions and unresolved product questions in the artifacts. If the requested behavior already exists, specify the user-visible contract and add acceptance coverage rather than claiming the implementation is missing. Never invent existing behavior. Finish by confirming the change is complete with openspec status.\n\nOriginal task:\n${input.taskPrompt}`;
}

export function makeOpenSpecChangeId(taskId: string, runId: string): string {
  const taskSlug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 34) || "task";
  const runSuffix = runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "run";
  return `task-${taskSlug}-${runSuffix}`;
}

