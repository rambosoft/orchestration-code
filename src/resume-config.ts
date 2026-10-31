// A resume continues a run; it must not be frozen at the configuration the run started with. LOC-92 (2026-10-26) started when review was routed to a free OpenRouter model that kept returning empty
// answers; the operator then moved every stage to codex in the manifest, but `resume-run` (and the automatic resume) re-started the workflow with the ORIGINAL input and failed the same way twice.
// So a resume takes the operator-controlled parts of the input (provider, per-stage routing, per-stage timeouts, budget) from the CURRENT manifest, and keeps the route of every stage that already
// has a saved successful result (changing a finished stage's provider would only make it run again). Everything else (prompt, ids, repository, quality commands) stays as the run started.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ProjectManifestSchema, StageNameSchema, type ProjectManifest, type ProviderRoute, type RunInput, type StageName } from "./contracts.js";

/** Stages with a saved successful result in the run folder (artifacts/<task>/<run>/<stage>-<n>.json): they are reused on resume, so their route is not changed. */
export async function savedStages(input: Pick<RunInput, "artifactsDir" | "runId">): Promise<Set<StageName>> {
  const done = new Set<StageName>();
  let names: string[] = [];
  try { names = await readdir(path.join(input.artifactsDir, input.runId)); } catch { return done; }
  for (const name of names) {
    const match = /^([a-z_]+)-\d+\.json$/.exec(name);
    const stage = StageNameSchema.safeParse(match?.[1]);
    if (!match || !stage.success) continue;
    try { if ((JSON.parse(await readFile(path.join(input.artifactsDir, input.runId, name), "utf8")) as { ok?: unknown }).ok === true) done.add(stage.data); } catch { /* an unreadable result is not a saved result */ }
  }
  return done;
}

/** The manifest of a project, found the way the bridge finds it: hand-written ones in the projects folder, bootstrap-written ones in its `generated` folder, by id or alias. */
export async function loadManifest(projectId: string, env: NodeJS.ProcessEnv = process.env): Promise<ProjectManifest | undefined> {
  const folder = env.ORCHESTRATOR_PROJECTS_DIR ?? path.resolve("projects");
  const files: string[] = [];
  for (const directory of [folder, path.join(folder, "generated")]) {
    try { for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".json")) files.push(path.join(directory, entry.name)); } catch { /* a missing folder has no manifests */ }
  }
  files.push(path.resolve(env.ORCHESTRATOR_PROJECT_FILE ?? "project.example.json"));
  for (const file of files) {
    try {
      const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (manifest.id === projectId || manifest.aliases.includes(projectId)) return manifest;
    } catch { /* an invalid manifest is reported by the bridge at startup */ }
  }
  return undefined;
}

const describeRoute = (route: ProviderRoute | undefined): string => route ? `${route.provider}${route.model ? `:${route.model}` : ""}${route.reasoningEffort ? ` (${route.reasoningEffort})` : ""}` : "the default";

/** The input with the manifest's current routing, timeouts and budget; routes of stages in `done` are kept. `changes` says what moved, for the operator. */
export function refreshConfig(input: RunInput, manifest: ProjectManifest, done: ReadonlySet<StageName>): { input: RunInput; changes: string[] } {
  const changes: string[] = [];
  const routing: NonNullable<RunInput["providerRouting"]> = {};
  for (const stage of StageNameSchema.options) {
    const before = input.providerRouting?.[stage];
    const route = done.has(stage) ? before : manifest.providerRouting[stage];
    if (route) routing[stage] = route;
    if (!done.has(stage) && describeRoute(before) !== describeRoute(route)) changes.push(`${stage}: ${describeRoute(before)} -> ${describeRoute(route)}`);
  }
  const provider = manifest.providers.default ?? input.provider;
  if (provider !== input.provider) changes.push(`default provider: ${input.provider ?? "none"} -> ${provider ?? "none"}`);
  const timeoutsChanged = JSON.stringify(input.providerTimeouts ?? {}) !== JSON.stringify(manifest.providerTimeouts);
  if (timeoutsChanged) changes.push("stage timeouts updated from the manifest");
  const budget = manifest.budget ?? input.budget;
  if (JSON.stringify(budget ?? null) !== JSON.stringify(input.budget ?? null)) changes.push("token budget updated from the manifest");
  return { input: { ...input, ...(provider ? { provider } : {}), providerRouting: routing, providerTimeouts: manifest.providerTimeouts, ...(budget ? { budget } : {}) }, changes };
}

/** The resume input for a run: unchanged when the project has no manifest on this machine. */
export async function refreshedInput(input: RunInput, env: NodeJS.ProcessEnv = process.env): Promise<{ input: RunInput; changes: string[] }> {
  const manifest = await loadManifest(input.projectId, env);
  if (!manifest) return { input, changes: [] };
  return refreshConfig(input, manifest, await savedStages(input));
}
