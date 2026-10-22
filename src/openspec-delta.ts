import { readFile } from "node:fs/promises";
import path from "node:path";

export type DeltaOps = { added: string[]; modified: string[]; removed: string[]; renamedFrom: string[] };

const requirementNames = (markdown: string): string[] => [...markdown.matchAll(/^###\s+Requirement:\s*(.+?)\s*$/gm)].map(match => match[1]!);

/** Parse an OpenSpec delta spec into the requirement names each operation section touches. */
export function parseDelta(markdown: string): DeltaOps {
  const ops: DeltaOps = { added: [], modified: [], removed: [], renamedFrom: [] };
  let section: "added" | "modified" | "removed" | "renamed" | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i.exec(line);
    if (heading) { section = heading[1]!.toLowerCase() as typeof section; continue; }
    if (/^##\s/.test(line)) { section = undefined; continue; }
    const requirement = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (requirement && section && section !== "renamed") { ops[section].push(requirement[1]!); continue; }
    const renamed = /FROM:\s*`?###\s+Requirement:\s*(.+?)`?\s*$/i.exec(line);
    if (renamed && section === "renamed") ops.renamedFrom.push(renamed[1]!);
  }
  return ops;
}

/** Problems that would make `openspec archive` fail later: operations that do not match the capability's main spec. */
export function deltaProblems(capability: string, ops: DeltaOps, mainSpec: string | undefined): string[] {
  const existing = new Set(mainSpec === undefined ? [] : requirementNames(mainSpec));
  const problems: string[] = [];
  for (const name of ops.modified) if (!existing.has(name)) problems.push(`capability '${capability}': MODIFIED requirement "${name}" does not exist in the main spec${mainSpec === undefined ? " (the capability has no main spec yet)" : ""}; put new requirements under ADDED`);
  for (const name of ops.removed) if (!existing.has(name)) problems.push(`capability '${capability}': REMOVED requirement "${name}" does not exist in the main spec`);
  for (const name of ops.renamedFrom) if (!existing.has(name)) problems.push(`capability '${capability}': RENAMED FROM requirement "${name}" does not exist in the main spec`);
  for (const name of ops.added) if (existing.has(name)) problems.push(`capability '${capability}': ADDED requirement "${name}" already exists in the main spec; use MODIFIED`);
  return problems;
}

/** Check every delta spec of a change against openspec/specs/<capability>/spec.md. */
export async function findDeltaProblems(root: string, changeId: string, deltaFiles: string[]): Promise<string[]> {
  const problems: string[] = [];
  const prefix = `openspec/changes/${changeId}/specs/`;
  for (const file of deltaFiles) {
    if (!file.startsWith(prefix) || !file.endsWith("/spec.md")) continue;
    const capability = file.slice(prefix.length, -"/spec.md".length);
    const delta = await readFile(path.resolve(root, ...file.split("/")), "utf8");
    const main = await readFile(path.resolve(root, "openspec", "specs", ...capability.split("/"), "spec.md"), "utf8").catch(() => undefined);
    problems.push(...deltaProblems(capability, parseDelta(delta), main));
  }
  return problems;
}
