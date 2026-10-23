import { readFile, writeFile } from "node:fs/promises";
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

type OpSection = "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED";
const OP_ORDER: OpSection[] = ["ADDED", "MODIFIED", "REMOVED", "RENAMED"];

/**
 * Mechanically correct delta operations that contradict the capability's main spec, instead of failing the run on something the validator can
 * state exactly: MODIFIED of a requirement that does not exist becomes ADDED, ADDED of one that already exists becomes MODIFIED, REMOVED of one
 * that does not exist is dropped. RENAMED mismatches cannot be fixed mechanically and are left for the problem report. Every change is returned as a note.
 */
export function normalizeDelta(markdown: string, mainSpec: string | undefined): { markdown: string; notes: string[] } {
  const existing = new Set(mainSpec === undefined ? [] : requirementNames(mainSpec));
  const preamble: string[] = []; const others: string[] = [];
  const sections: Record<OpSection, string[][]> = { ADDED: [], MODIFIED: [], REMOVED: [], RENAMED: [] };
  const intros: Record<OpSection, string[]> = { ADDED: [], MODIFIED: [], REMOVED: [], RENAMED: [] };
  const present = new Set<OpSection>();
  let current: OpSection | "other" | undefined; let block: string[] | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i.exec(line);
    if (heading) { current = heading[1]!.toUpperCase() as OpSection; present.add(current); block = undefined; continue; }
    if (/^##\s/.test(line)) { current = "other"; block = undefined; others.push(line); continue; }
    if (current === undefined) { preamble.push(line); continue; }
    if (current === "other") { others.push(line); continue; }
    if (/^###\s+Requirement:/.test(line)) { block = [line]; sections[current].push(block); continue; }
    (block ?? intros[current]).push(line);
  }
  const notes: string[] = [];
  const nameOf = (lines: string[]) => /^###\s+Requirement:\s*(.+?)\s*$/.exec(lines[0]!)?.[1] ?? "";
  const moved: Record<OpSection, string[][]> = { ADDED: [], MODIFIED: [], REMOVED: [], RENAMED: [] };
  for (const kind of OP_ORDER) {
    for (const lines of sections[kind]) {
      const name = nameOf(lines);
      if (kind === "MODIFIED" && !existing.has(name)) { moved.ADDED.push(lines); notes.push(`MODIFIED requirement "${name}" does not exist in the main spec; moved to ADDED`); }
      else if (kind === "ADDED" && existing.has(name)) { moved.MODIFIED.push(lines); notes.push(`ADDED requirement "${name}" already exists in the main spec; moved to MODIFIED`); }
      else if (kind === "REMOVED" && !existing.has(name)) notes.push(`REMOVED requirement "${name}" does not exist in the main spec; dropped`);
      else moved[kind].push(lines);
    }
  }
  if (!notes.length) return { markdown, notes };
  const out = [...preamble];
  for (const kind of OP_ORDER) {
    if (!moved[kind].length && !(present.has(kind) && (kind === "RENAMED" || intros[kind].some(line => line.trim())))) continue;
    out.push(`## ${kind} Requirements`, ...intros[kind]);
    for (const lines of moved[kind]) { const body = [...lines]; while (body.length > 1 && !body.at(-1)!.trim()) body.pop(); out.push(...body, ""); }
  }
  out.push(...others);
  return { markdown: `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, notes };
}

/** Rewrite delta spec files in place when they contradict the main specs; returns the notes for the final message. */
export async function repairDeltaFiles(root: string, changeId: string, deltaFiles: string[]): Promise<string[]> {
  const notes: string[] = [];
  const prefix = `openspec/changes/${changeId}/specs/`;
  for (const file of deltaFiles) {
    if (!file.startsWith(prefix) || !file.endsWith("/spec.md")) continue;
    const capability = file.slice(prefix.length, -"/spec.md".length);
    const target = path.resolve(root, ...file.split("/"));
    const delta = await readFile(target, "utf8");
    const main = await readFile(path.resolve(root, "openspec", "specs", ...capability.split("/"), "spec.md"), "utf8").catch(() => undefined);
    const fixed = normalizeDelta(delta, main);
    if (!fixed.notes.length) continue;
    await writeFile(target, fixed.markdown, "utf8");
    notes.push(...fixed.notes.map(note => `openspec delta '${capability}' corrected automatically: ${note}`));
  }
  return notes;
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
