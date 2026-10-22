import { readFile } from "node:fs/promises";
import path from "node:path";
import { UiUxConfigSchema, type UiUxConfig } from "./contracts.js";
import { DEFAULT_UI_UX_CONFIG, resolveUiUxConfig } from "./uiux.js";

export async function loadGlobalUiUxConfig(environment: NodeJS.ProcessEnv = process.env): Promise<UiUxConfig> {
  const file = path.resolve(environment.ORCHESTRATOR_UIUX_CONFIG ?? "uiux.global.json");
  try {
    return UiUxConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return DEFAULT_UI_UX_CONFIG;
    throw new Error(`invalid global UI/UX config '${file}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function resolveProjectUiUx(project: { uiUx?: Partial<UiUxConfig> }, projectRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<{ config: UiUxConfig; frameworks: string[] }> {
  const global = await loadGlobalUiUxConfig(environment);
  return { config: resolveUiUxConfig(global, project.uiUx), frameworks: await detectProjectFrameworks(projectRoot) };
}

export async function detectProjectFrameworks(projectRoot: string): Promise<string[]> {
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")); }
  catch { return []; }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const has = (name: string) => Object.hasOwn(dependencies, name);
  const result = new Set<string>();
  if (has("react-native") || has("expo")) result.add("react-native");
  if (has("react")) result.add("react");
  if (has("next")) result.add("next");
  if (has("vue")) result.add("vue");
  if (has("nuxt")) result.add("nuxt");
  if (has("@angular/core")) result.add("angular");
  if (has("svelte") || has("@sveltejs/kit")) result.add("svelte");
  if (has("astro")) result.add("astro");
  if (has("react") && !has("react-native") && !has("expo")) result.add("web");
  return [...result];
}
