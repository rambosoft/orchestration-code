import path from "node:path";
import type { BootstrapGlobalConfig } from "./bootstrap.js";
import { extractBootstrapForm } from "./bootstrap-form.js";
import { BootstrapFormSchema, resolveOptions } from "./bootstrap-options.js";
import type { RunInput } from "./contracts.js";

/**
 * Turn a Paperclip task labelled as a bootstrap into the workflow input (ADR 0009). The form travels inside the task description; it is validated here, the options
 * are resolved (user value, then preset, then default) and the project must not be bootstrapped already. No project manifest exists yet, so none is required.
 */
export async function prepareBootstrapRun(
  payload: { taskId: string; projectId?: string; revision?: string; attempt?: number; prompt: string; taskTitle?: string },
  deps: { isProjectKnown: (projectId: string) => Promise<boolean>; config: BootstrapGlobalConfig; dataRoot: string; projectsRoot?: string },
): Promise<Omit<RunInput, "runId">> {
  const extracted = extractBootstrapForm(payload.prompt);
  if (extracted.error) throw new Error(extracted.error);
  const parsed = BootstrapFormSchema.safeParse(extracted.form);
  if (!parsed.success) throw new Error(`invalid bootstrap form: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "form"}: ${issue.message}`).join("; ")}`);
  const form = parsed.data;
  if (payload.projectId && payload.projectId !== form.paperclip.projectId) throw new Error("the bootstrap form belongs to a different Paperclip project than the task");
  if (await deps.isProjectKnown(form.paperclip.projectId)) throw new Error("this Paperclip project already has an orchestrator manifest; a project is bootstrapped once");
  const resolved = resolveOptions(form.options);
  if (resolved.errors.length) throw new Error(`invalid bootstrap options: ${resolved.errors.join("; ")}`);
  const provider = deps.config.manifest.providers.default;
  return {
    taskId: payload.taskId, ...(payload.revision !== undefined ? { taskRevision: payload.revision } : {}), ...(payload.attempt !== undefined ? { attempt: payload.attempt } : {}),
    projectId: form.paperclip.projectId, profile: "bootstrap", prompt: extracted.rest || `Bootstrap ${form.name}`, taskType: "bootstrap",
    bootstrap: { form, options: resolved.values, provenance: resolved.provenance, ...(deps.projectsRoot ? { projectsRoot: deps.projectsRoot } : {}) },
    ...(provider ? { provider } : {}), providerRouting: deps.config.stages, providerTimeouts: {},
    projectRoot: deps.dataRoot, artifactsDir: path.join(deps.dataRoot, "artifacts", payload.taskId),
    approval: resolved.values.approval === "required", plugins: [], qualityCommands: [],
  };
}
