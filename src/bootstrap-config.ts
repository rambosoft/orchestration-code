import { readFile } from "node:fs/promises";
import path from "node:path";
import { BootstrapGlobalConfigSchema, DEFAULT_BOOTSTRAP_CONFIG, type BootstrapGlobalConfig } from "./bootstrap.js";

/** Global bootstrap defaults (bootstrap.global.json, next to uiux.global.json). A missing file means the built-in defaults; an invalid file is an error, never silently ignored. */
export async function loadBootstrapConfig(environment: NodeJS.ProcessEnv = process.env): Promise<BootstrapGlobalConfig> {
  const file = path.resolve(environment.ORCHESTRATOR_BOOTSTRAP_CONFIG ?? "bootstrap.global.json");
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return DEFAULT_BOOTSTRAP_CONFIG;
    throw error;
  }
  const parsed = BootstrapGlobalConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`invalid bootstrap config '${file}': ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}
