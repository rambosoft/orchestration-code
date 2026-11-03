import { resolveProjectHostRoot } from "./project-roots.js";

export type ProjectReference = { root: string; label?: string };

export function referencePromptBlock(hostPath: string, label: string): string {
  return `REFERENCE REPOSITORY (read-only, outside this worktree): ${label} at ${hostPath.replace(/\\/g, "/")}. Read the OLD files named in this task from there with absolute paths. Never modify, create or delete anything there. If a file cannot be read, say so in docs/migration/findings.md instead of guessing.\n\n`;
}

export function resolveReferenceHostPath(reference: { root: string }, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveProjectHostRoot({ id: "reference", root: reference.root }, environment);
}

export function applyReference(prompt: string, reference: ProjectReference | undefined, environment: NodeJS.ProcessEnv = process.env, projectId = "project"): string {
  if (!reference) return prompt;
  const hostPath = resolveReferenceHostPath(reference, environment);
  if (!hostPath) throw new Error(`project '${projectId}' declares a reference repository but ORCHESTRATOR_PROJECTS_ROOT is not set`);
  const result = referencePromptBlock(hostPath, reference.label ?? "reference repository") + prompt;
  if (result.length > 20_000) throw new Error("prompt exceeds the 20000 character limit after adding the reference repository instructions");
  return result;
}
