import path from "node:path";

export type ProjectRootSettings = { id: string; root: string; rootEnv?: string };

/** Windows-style paths (drive letter or UNC) must be resolved with win32 semantics even when the bridge runs in a Linux container; POSIX path.resolve would prefix them with the working directory. */
function pathApiFor(value: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") ? path.win32 : path;
}

/** Resolve a project checkout for the worker without requiring one env var or Docker mount per project. */
export function resolveProjectHostRoot(
  project: ProjectRootSettings,
  environment: NodeJS.ProcessEnv = process.env,
  defaultProjectId?: string,
): string | undefined {
  if (project.rootEnv) {
    const configuredRoot = environment[project.rootEnv];
    return configuredRoot ? pathApiFor(configuredRoot).resolve(configuredRoot) : undefined;
  }

  if (project.id === defaultProjectId && environment.DEMO_PROJECT_ROOT) {
    return pathApiFor(environment.DEMO_PROJECT_ROOT).resolve(environment.DEMO_PROJECT_ROOT);
  }

  const workspaceRoot = environment.ORCHESTRATOR_PROJECTS_ROOT;
  if (!workspaceRoot) return undefined;

  // The bridge container passes this host-side path through to the Windows
  // worker. Resolve Windows paths with win32 semantics even when running on
  // Linux; POSIX path.resolve would incorrectly prefix them with /app.
  const pathApi = pathApiFor(workspaceRoot);
  const base = pathApi.resolve(workspaceRoot);
  const resolved = pathApi.resolve(base, project.root);
  const relative = pathApi.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new Error(`project root '${project.root}' must stay inside ORCHESTRATOR_PROJECTS_ROOT`);
  }
  return resolved;
}
