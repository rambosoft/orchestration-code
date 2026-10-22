import path from "node:path";

export type ProjectRootSettings = { id: string; root: string; rootEnv?: string };

/** Resolve a project checkout for the worker without requiring one env var or Docker mount per project. */
export function resolveProjectHostRoot(
  project: ProjectRootSettings,
  environment: NodeJS.ProcessEnv = process.env,
  defaultProjectId?: string,
): string | undefined {
  if (project.rootEnv) {
    const configuredRoot = environment[project.rootEnv];
    return configuredRoot ? path.resolve(configuredRoot) : undefined;
  }

  if (project.id === defaultProjectId && environment.DEMO_PROJECT_ROOT) {
    return path.resolve(environment.DEMO_PROJECT_ROOT);
  }

  const workspaceRoot = environment.ORCHESTRATOR_PROJECTS_ROOT;
  if (!workspaceRoot) return undefined;

  // The bridge container passes this host-side path through to the Windows
  // worker. Resolve Windows paths with win32 semantics even when running on
  // Linux; POSIX path.resolve would incorrectly prefix them with /app.
  const pathApi = /^[A-Za-z]:[\\/]/.test(workspaceRoot) || workspaceRoot.startsWith("\\\\")
    ? path.win32
    : path;
  const base = pathApi.resolve(workspaceRoot);
  const resolved = pathApi.resolve(base, project.root);
  const relative = pathApi.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new Error(`project root '${project.root}' must stay inside ORCHESTRATOR_PROJECTS_ROOT`);
  }
  return resolved;
}
