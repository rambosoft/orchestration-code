import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OptionValue } from "./bootstrap-options.js";
import type { ScaffoldTemplate } from "./bootstrap-templates.js";
import type { CommandRunner } from "./command.js";
import { childEnv } from "./env.js";
import { activitySignal, killOnAbort } from "./process-control.js";
import { parseUnityEditorVersion } from "./stack-profiles.js";
import { nunitProblem, runUnity, type UnityRun } from "./unity.js";

// Host-side creation of a Unity project for the bootstrap scaffold. Unity writes the project (ProjectSettings, Packages, .meta files) so GUIDs are genuine; the template
// files are copied on top, then one import pass lets Unity write the .meta files of the copied files, and the project is proven (EditMode tests, hygiene) before anything is committed.
export type UnityTools = {
  /** Creates an empty Unity project in `root` with the installed Editor. */
  createProject(root: string): Promise<UnityRun>;
  /** Runs the Unity CLI. */
  cli(args: string[], cwd: string): Promise<UnityRun>;
};

/** The Editor to create projects with: UNITY_EDITOR_PATH, else the newest 6000.x under the Hub's install folder (UNITY_EDITORS_ROOT or the Windows default). */
export function findUnityEditor(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync, list: (dir: string) => string[] = dir => readdirSync(dir)): string | undefined {
  if (env.UNITY_EDITOR_PATH) return exists(env.UNITY_EDITOR_PATH) ? env.UNITY_EDITOR_PATH : undefined;
  const root = env.UNITY_EDITORS_ROOT ?? "C:\\Program Files\\Unity\\Hub\\Editor";
  let versions: string[] = [];
  try { versions = list(root); } catch { return undefined; }
  const newest = versions.filter(version => /^6000\.\d+\.\d+[abfp]\d+$/.test(version)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const executable = newest ? path.join(root, newest, "Editor", "Unity.exe") : undefined;
  return executable && exists(executable) ? executable : undefined;
}

export function defaultUnityTools(env: NodeJS.ProcessEnv = process.env): UnityTools {
  return {
    createProject: root => new Promise((resolve, reject) => {
      const editor = findUnityEditor(env);
      if (!editor) return reject(new Error("no Unity 6 Editor was found: install one with the Android module through Unity Hub, or set UNITY_EDITOR_PATH"));
      const log = path.join(path.dirname(root), `${path.basename(root)}-create.log`);
      const child = spawn(editor, ["-batchmode", "-nographics", "-quit", "-createProject", root, "-logFile", log], { shell: false, windowsHide: true, env: childEnv(env) });
      const stopKill = killOnAbort(child, activitySignal());
      child.on("error", error => { stopKill(); reject(error); });
      child.on("close", code => { stopKill(); resolve({ code, output: code === 0 ? "" : `see ${log}`, stderr: code === 198 ? "No valid Unity Editor licence: sign in to Unity Hub and activate a licence" : "" }); });
    }),
    cli: (args, cwd) => runUnity(args, cwd, activitySignal()),
  };
}

/** The templates folder: ORCHESTRATOR_TEMPLATES_DIR, else the nearest `templates` folder above this file (works from src and from dist). */
export function templatesRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCHESTRATOR_TEMPLATES_DIR) return path.resolve(env.ORCHESTRATOR_TEMPLATES_DIR);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++, dir = path.dirname(dir)) if (existsSync(path.join(dir, "templates"))) return path.join(dir, "templates");
  throw new Error("the templates folder was not found next to the orchestrator");
}

export type TemplateValues = Record<"NAME" | "PACKAGE" | "ORIENTATION" | "FPS", string>;
export function templateValues(name: string, slug: string, options: Record<string, OptionValue>): TemplateValues {
  const segment = slug.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return {
    NAME: name.replace(/[\u0000-\u001f"\\]/g, " ").trim().slice(0, 60) || "Game",
    PACKAGE: /^[a-z]/.test(segment) ? segment : `g${segment}`,
    ORIENTATION: options.game_orientation === "landscape" ? "LandscapeLeft" : options.game_orientation === "both" ? "AutoRotation" : "Portrait",
    FPS: options.game_fps === "30" ? "30" : "60",
  };
}
export const fillTemplate = (content: string, values: TemplateValues): string => content.replace(/\{\{(NAME|PACKAGE|ORIENTATION|FPS)\}\}/g, (_, key: keyof TemplateValues) => values[key]);

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(full, base)); else result.push(path.relative(base, full));
  }
  return result;
}

const TEST_FRAMEWORK = "1.6.0";
/** Adds the Unity Test Framework to the manifest; the empty Unity template does not declare it and test assemblies then fail with CS0246 NUnit. */
export function withTestFramework(manifestJson: string): string {
  const manifest = JSON.parse(manifestJson) as { dependencies?: Record<string, string> };
  manifest.dependencies = { "com.unity.test-framework": TEST_FRAMEWORK, ...(manifest.dependencies ?? {}) };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export type UnityScaffoldRequest = { root: string; template: ScaffoldTemplate; values: TemplateValues; tools: UnityTools; run: CommandRunner; env: NodeJS.ProcessEnv; /** Writes the repository's own files (docs, guides) after the project exists. */ writeFiles: () => Promise<void> };
const tail = (value: string, max = 1500) => value.trim().slice(-max);
const said = (result: UnityRun) => tail([result.stderr, result.output].filter(Boolean).join(" "));

/** Creates, fills and proves the project. Returns the Editor version it was created with. Throws with a readable message at the first failing step. */
export async function scaffoldUnityProject(request: UnityScaffoldRequest): Promise<{ editorVersion: string }> {
  const { root, template, values, tools } = request;
  const created = await tools.createProject(root);
  if (created.code !== 0) throw new Error(`Unity could not create the project (exit ${created.code ?? "unknown"}): ${said(created)}`);
  const editorVersion = parseUnityEditorVersion(await readFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "utf8"));
  if (!editorVersion) throw new Error("the created project has no editor version in ProjectSettings/ProjectVersion.txt");

  const source = path.join(templatesRoot(request.env), template.templateDir ?? template.id);
  for (const file of await listFiles(source)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, fillTemplate(await readFile(path.join(source, file), "utf8"), values), "utf8");
  }
  const manifestPath = path.join(root, "Packages", "manifest.json");
  await writeFile(manifestPath, withTestFramework(await readFile(manifestPath, "utf8")), "utf8");
  await request.writeFiles();

  // One import pass: Unity compiles the copied scripts and writes the .meta files for everything that was copied.
  const imported = await tools.cli(["run", root, "--timeout", "840", "--no-banner", "--non-interactive"], root);
  if (imported.code !== 0) throw new Error(`the Unity import of the new project failed (exit ${imported.code ?? "unknown"}): ${said(imported)}`);
  const report = path.join(root, "Logs", "scaffold-editmode.xml");
  const tested = await tools.cli(["test", root, "--mode", "EditMode", "--output", report, "--timeout", "900", "--no-banner", "--non-interactive"], root);
  if (tested.code !== 0) throw new Error(`the generated project failed its EditMode tests (exit ${tested.code ?? "unknown"}), so nothing was committed: ${said(tested)}`);
  const problem = nunitProblem(await readFile(report, "utf8").catch(() => ""));
  if (problem) throw new Error(`the generated project's EditMode report is not a pass: ${problem}`);
  try { await request.run("node", ["scripts/check-unity-hygiene.mjs"], root); } catch (error) { throw new Error(`the generated project fails its own hygiene check: ${tail(error instanceof Error ? error.message : String(error))}`); }
  if (!(await stat(path.join(root, "Assets", "Scripts", "Logic", "Game.Logic.asmdef.meta")).then(() => true, () => false))) throw new Error("Unity did not write .meta files for the template files");
  return { editorVersion };
}
