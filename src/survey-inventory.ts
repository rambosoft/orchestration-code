import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { runCommand, type CommandRunner } from "./command.js";
import { SENSITIVE_PATH } from "./publish-guard.js";
import { redactSecrets } from "./redact.js";
import type { Inventory } from "./survey.js";
import { extractVueFacts, renderVueSummary, type VueFacts } from "./vue-extract.js";

// The deterministic inventory a survey starts from (ADR 0032). File-system code, so it runs as an activity; the pure schema, prompt and renderer are in survey.ts (the workflow bundle imports those).
const SKIPPED = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git|\.nuxt|\.next|vendor|\.runtime|data|static|assets|test-results|tmp)\/|(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|log|map)$/i;
const SOURCE = /\.(?:vue|jsx?|tsx?|mjs|cjs|css|scss|less|html|json)$/i;

const lineCount = async (file: string): Promise<number> => (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/).length;

const MAX_VUE_FILES = 400; const MAX_VUE_BYTES = 200_000;
/** Facts counted from the single-file components (B-138): props, registrations, hooks, store use, event bus. A file that cannot be read or parsed is skipped, never fatal. */
async function vueFacts(base: string, files: string[]): Promise<VueFacts[]> {
  const found: VueFacts[] = [];
  for (const file of files.filter(item => item.endsWith(".vue")).slice(0, MAX_VUE_FILES)) {
    try {
      const full = path.join(base, file);
      if ((await stat(full)).size > MAX_VUE_BYTES) continue;
      found.push(extractVueFacts(await readFile(full, "utf8"), file));
    } catch { /* an unreadable component is left out of the facts */ }
  }
  return found;
}
const moduleOf = (entry: string): string => {
  const read = /^read:state\.([^.]+)/.exec(entry);
  if (read) return read[1]!;
  const name = entry.replace(/^(?:dispatch|commit|read):/, "");
  return name.includes("/") ? name.split("/")[0]! : "(root)";
};
/** How many components use each Vuex module (the part before the slash in a mapped or dispatched name; the root otherwise). */
function storeUse(all: VueFacts[]): string {
  const counts = new Map<string, number>();
  for (const facts of all) {
    const modules = new Set<string>();
    for (const entry of [...Object.values(facts.vuex.mapped).flat(), ...facts.vuex.calls]) modules.add(moduleOf(entry));
    for (const module of modules) counts.set(module, (counts.get(module) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([module, count]) => `${module}: ${count} components`).join("\n");
}

/** Routes (pages/ or routes/), store modules, dependencies, scripts, largest source files, tests and guidance documents, counted from the tracked files. Bounded and deterministic. */
export async function buildSurveyInventory(root: string, runner: CommandRunner = runCommand): Promise<Inventory> {
  const base = path.resolve(root);
  let tracked: string[];
  try { tracked = (await runner("git", ["-c", "core.quotepath=off", "ls-files"], base)).split(/\r?\n/).filter(Boolean); } catch { tracked = []; }
  tracked = tracked.filter(file => !SENSITIVE_PATH.some(pattern => pattern.test(file)) && !SKIPPED.test(file));
  const sources = tracked.filter(file => SOURCE.test(file));
  const routeFiles = sources.filter(file => /^(?:src\/)?(?:pages|routes)\/.+\.(?:vue|jsx?|tsx?)$/i.test(file) && !/(?:^|\/)(?:test|tests|__tests__|dev)\//i.test(file));
  const routes = await Promise.all(routeFiles.slice(0, 200).map(async file => ({ file, lines: await lineCount(path.join(base, file)) })));
  const stores = sources.filter(file => /^(?:src\/)?(?:store|stores)\/[^/]+\.(?:js|ts)$/i.test(file));
  const sized = await Promise.all(sources.filter(file => /\.(?:vue|jsx?|tsx?)$/i.test(file)).slice(0, 1500).map(async file => ({ file, size: (await stat(path.join(base, file)).catch(() => ({ size: 0 }))).size })));
  const largest = sized.sort((a, b) => b.size - a.size).slice(0, 15);
  const vue = await vueFacts(base, sources);
  const byFolder = new Map<string, number>();
  for (const file of sources) { const top = file.includes("/") ? file.split("/")[0]! : "(root)"; byFolder.set(top, (byFolder.get(top) ?? 0) + 1); }
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; engines?: Record<string, string> } = {};
  try { manifest = JSON.parse(await readFile(path.join(base, "package.json"), "utf8")); } catch { /* not a node project */ }
  const list = (items: string[]) => items.length ? items.join("\n") : "(none)";
  const docs = tracked.filter(file => /^(?:docs\/.+\.md|AGENTS\.md|CLAUDE\.md|README\.md)$/i.test(file)).slice(0, 40);
  const tests = tracked.filter(file => !/^(?:src\/)?(?:pages|routes)\//i.test(file) && /(?:^|\/)(?:tests?|__tests__|e2e)\/|\.(?:spec|test)\.[jt]sx?$/i.test(file));
  const text = redactSecrets([
    `## Totals\n${sources.length} source files in ${byFolder.size} top-level folders; ${routes.length} route files; ${stores.length} store modules; ${tests.length} test files`,
    `## Source files by top-level folder\n${list([...byFolder].sort((a, b) => b[1] - a[1]).map(([folder, count]) => `${folder}: ${count}`))}`,
    `## Routes (file, lines)\n${list(routes.map(route => `${route.file} ${route.lines}`))}`,
    `## Store modules\n${list(stores)}`,
    ...(vue.length ? [`## Vue components (counted from the code: props, registrations, hooks, store use, event bus)\n${renderVueSummary(vue, 4_000)}`, `## Vuex use by component count\n${storeUse(vue) || "(none)"}`] : []),
    `## Largest components and scripts (file, bytes)\n${list(largest.map(item => `${item.file} ${item.size}`))}`,
    `## Runtime and dependencies\nengines: ${JSON.stringify(manifest.engines ?? {})}\ndependencies: ${Object.entries(manifest.dependencies ?? {}).slice(0, 60).map(([name, version]) => `${name}@${version}`).join(", ") || "(none)"}\ndevDependencies: ${Object.keys(manifest.devDependencies ?? {}).slice(0, 40).join(", ") || "(none)"}`,
    `## npm scripts (names)\n${Object.keys(manifest.scripts ?? {}).slice(0, 60).join(", ") || "(none)"}`,
    `## Guidance documents\n${list(docs)}`,
  ].join("\n\n")).slice(0, 12_000);
  return { text, routes, stores, files: sources.length };
}

