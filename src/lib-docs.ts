import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Version-matched library documentation, cached in the repository as reviewed content (B-165, ADR 0038, ADR 0033). The new app uses releases newer than most models' training data, so a stage prompt points at
// docs/ai/libs/<package>.md instead of letting the model guess an API. The cache is the product: a stage reads it and never touches the network. `dev libs-fetch` fills it from Context7 for declared
// dependencies only; only the library name, a version and a generic question leave the machine, never code. A person reviews each file (`Status: reviewed`) before a stage uses it.

export const LIBS_DIR = "docs/ai/libs";
const API = "https://context7.com/api/v2";
const MAX_NOTE_CHARS = 6_000;

export type LibNote = { name: string; version: string; libraryId: string; fetchedAt: string; status: "reviewed" | "unreviewed"; summary: string; body: string };
export type HttpResponse = { status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> };
export type Fetcher = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

/** docs/ai/libs/<file> for a package name: the scope slash becomes a double underscore, nothing else is allowed in a file name. */
export const libFile = (name: string): string => `${LIBS_DIR}/${name.replace(/^@/, "").replace(/\//g, "__")}.md`;
export const isPackageName = (name: string): boolean => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name);

/** The lowest version a range names ("^19.3.1" gives "19.3.1", "~6.0.3" gives "6.0.3", ">=2 <3" gives "2.0.0"); undefined for a tag or URL. */
export function declaredVersion(range: string): string | undefined {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  return match ? `${match[1]}.${match[2] ?? "0"}.${match[3] ?? "0"}` : undefined;
}
export const majorOf = (version: string): number | undefined => { const major = /^\D*(\d+)/.exec(version)?.[1]; return major === undefined ? undefined : Number(major); };

export function renderLibNote(note: LibNote): string {
  return [`# ${note.name}@${note.version}`, "", `Source: Context7 ${note.libraryId}`, `Fetched: ${note.fetchedAt}`, `Status: ${note.status}`, `Summary: ${note.summary}`, "", note.body.trim(), ""].join(String.fromCharCode(10));
}
export function parseLibNote(text: string): LibNote | undefined {
  const lines = text.replace(/\r\n/g, String.fromCharCode(10)).split(String.fromCharCode(10));
  const head = /^#\s+(\S+)@(\S+)\s*$/.exec(lines[0] ?? "");
  const field = (name: string): string | undefined => lines.slice(0, 10).map(line => new RegExp(`^${name}:\\s*(.+?)\\s*$`).exec(line)?.[1]).find(Boolean);
  const status = field("Status");
  if (!head || (status !== "reviewed" && status !== "unreviewed")) return undefined;
  return { name: head[1]!, version: head[2]!, libraryId: field("Source")?.replace(/^Context7\s+/, "") ?? "", fetchedAt: field("Fetched") ?? "", status, summary: field("Summary") ?? "", body: lines.slice(lines.findIndex((line, index) => index > 0 && line.startsWith("Summary:")) + 1).join(String.fromCharCode(10)).trim() };
}

/** The dependencies a package.json declares, with their ranges. */
export async function declaredDependencies(root: string): Promise<Record<string, string>> {
  try { const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>; return { ...manifest.devDependencies, ...manifest.dependencies }; }
  catch { return {}; }
}
export async function readLibNote(root: string, name: string): Promise<LibNote | undefined> {
  try { return parseLibNote(await readFile(path.join(root, libFile(name)), "utf8")); } catch { return undefined; }
}

const defaultFetcher: Fetcher = (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
async function getJson(fetcher: Fetcher, url: string, key: string | undefined): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(url, headers);
    if (response.status === 503 && attempt < 1) { await new Promise(resolve => setTimeout(resolve, 1_000)); continue; }
    if (response.status === 429) throw new Error(`Context7 rate limit reached (retry after ${response.headers?.get("Retry-After") ?? "a while"} seconds); set CONTEXT7_API_KEY for higher limits`);
    if (response.status === 404) throw new Error("Context7 has no documentation for this library");
    if (response.status < 200 || response.status >= 300) throw new Error(`Context7 answered ${response.status}`);
    return response.json();
  }
}
const asObjects = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];

export type FetchOptions = { apiKey?: string; fetcher?: Fetcher; now?: () => Date; version?: string };
/**
 * One library's note from Context7: the best search match, then a generic overview question for the declared version. Sends the library name, the version and that question, nothing else.
 * The note is written `unreviewed`; a person reads it and sets `Status: reviewed` before any stage uses it.
 */
export async function fetchLibNote(name: string, declaredRange: string, options: FetchOptions = {}): Promise<LibNote> {
  if (!isPackageName(name)) throw new Error(`'${name}' is not a package name`);
  const fetcher = options.fetcher ?? defaultFetcher;
  const version = options.version ?? declaredVersion(declaredRange);
  if (!version) throw new Error(`cannot tell which version of '${name}' to document from '${declaredRange}'; pass --version`);
  const question = `Overview of ${name} ${version}: setup, the main API, common patterns, and what changed from the previous major version.`;
  const search = await getJson(fetcher, `${API}/libs/search?libraryName=${encodeURIComponent(name)}&query=${encodeURIComponent(question)}`, options.apiKey) as { results?: unknown };
  const best = asObjects(search.results)[0];
  const libraryId = typeof best?.id === "string" ? best.id : undefined;
  if (!libraryId) throw new Error(`Context7 found no library for '${name}'`);
  const context = await getJson(fetcher, `${API}/context?libraryId=${encodeURIComponent(`${libraryId}/${version}`)}&query=${encodeURIComponent(question)}&type=json`, options.apiKey) as { infoSnippets?: unknown; codeSnippets?: unknown; version?: { version?: unknown } };
  const info = asObjects(context.infoSnippets).map(item => String(item.content ?? "").trim()).filter(Boolean);
  const code = asObjects(context.codeSnippets).flatMap(item => { const first = asObjects(item.codeList)[0]; return first && typeof first.code === "string" ? [`### ${String(item.codeTitle ?? "Example")}`, "```", first.code.trim(), "```"] : []; });
  const body = [...info, ...code].join(String.fromCharCode(10) + String.fromCharCode(10)).slice(0, MAX_NOTE_CHARS);
  if (!body.trim()) throw new Error(`Context7 returned no documentation for '${name}' ${version}`);
  const served = typeof context.version?.version === "string" ? context.version.version : version;
  return { name, version: served, libraryId, fetchedAt: (options.now?.() ?? new Date()).toISOString().slice(0, 10), status: "unreviewed", summary: (info[0] ?? code[0] ?? "").replace(/\s+/g, " ").slice(0, 140), body };
}

/** Fetches the notes for the named dependencies. A name the project does not declare is refused (nothing else may be requested); a note already cached is not fetched again unless `force`. */
export async function fetchDeclared(root: string, names: string[], options: FetchOptions & { force?: boolean } = {}): Promise<Array<{ name: string; outcome: "cached" | "written" | "failed"; detail: string }>> {
  const declared = await declaredDependencies(root);
  const results: Array<{ name: string; outcome: "cached" | "written" | "failed"; detail: string }> = [];
  for (const name of names) {
    if (!(name in declared)) { results.push({ name, outcome: "failed", detail: "not a declared dependency of this project; only declared dependencies are requested" }); continue; }
    if (!options.force && await readLibNote(root, name)) { results.push({ name, outcome: "cached", detail: libFile(name) }); continue; }
    try {
      const note = await fetchLibNote(name, declared[name]!, options);
      const target = path.join(root, libFile(name));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, renderLibNote(note));
      results.push({ name, outcome: "written", detail: `${libFile(name)} (${note.version}, unreviewed)` });
    } catch (error) { results.push({ name, outcome: "failed", detail: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}
