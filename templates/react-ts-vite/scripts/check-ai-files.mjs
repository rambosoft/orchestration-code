#!/usr/bin/env node
// Checks the AI instruction files (ADR 0035): AGENTS.md is the single canonical file, short, with numbered rule ids; other agent files only point to it;
// docs/ai/enforcement.json maps every rule id to an npm script that enforces it, or marks it "prose" (reviewed by a person or a reviewer agent). No dependencies.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const MAX_AGENTS_LINES = 150;
const MAX_POINTER_LINES = 15;
const problems = [];
const read = file => (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8") : undefined);

const agents = read("AGENTS.md");
if (agents === undefined) problems.push("AGENTS.md is missing");
const ruleIds = new Set();
if (agents !== undefined) {
  const lines = agents.split(/\r?\n/);
  if (lines.length > MAX_AGENTS_LINES) problems.push(`AGENTS.md has ${lines.length} lines; the limit is ${MAX_AGENTS_LINES} (keep it dense: move detail into ENGINEERING_STANDARDS.md)`);
  for (const match of agents.matchAll(/\bR-\d{3}\b/g)) ruleIds.add(match[0]);
  if (ruleIds.size === 0) problems.push("AGENTS.md has no rule ids (R-001 and so on)");
}

for (const file of ["CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"]) {
  const text = read(file);
  if (text === undefined) continue;
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_POINTER_LINES) problems.push(`${file} has ${lines.length} lines; it must only point to AGENTS.md (limit ${MAX_POINTER_LINES})`);
  if (!/AGENTS\.md/.test(text)) problems.push(`${file} does not point to AGENTS.md`);
  if (/\bR-\d{3}\b/.test(text)) problems.push(`${file} repeats rule ids; keep rules only in AGENTS.md`);
}

const manifestText = read("docs/ai/enforcement.json");
if (manifestText === undefined) problems.push("docs/ai/enforcement.json is missing");
else {
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch { problems.push("docs/ai/enforcement.json is not valid JSON"); }
  if (Array.isArray(manifest)) {
    const scripts = (() => { try { return JSON.parse(read("package.json") ?? "{}").scripts ?? {}; } catch { return {}; } })();
    const seen = new Set();
    for (const entry of manifest) {
      if (!entry || typeof entry.id !== "string" || typeof entry.gate !== "string") { problems.push(`enforcement entry is malformed: ${JSON.stringify(entry)}`); continue; }
      if (seen.has(entry.id)) problems.push(`${entry.id} appears twice in enforcement.json`);
      seen.add(entry.id);
      if (agents !== undefined && !ruleIds.has(entry.id)) problems.push(`${entry.id} is in enforcement.json but not in AGENTS.md`);
      if (entry.gate !== "prose" && !(entry.gate in scripts)) problems.push(`${entry.id} names the gate '${entry.gate}', which is not an npm script in package.json`);
    }
    for (const id of ruleIds) if (!seen.has(id)) problems.push(`${id} is in AGENTS.md but has no entry in enforcement.json (map it to a gate or mark it prose)`);
  } else if (manifest !== undefined) problems.push("docs/ai/enforcement.json must be an array of { id, gate }");
}

if (problems.length) { console.error(`check:ai found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:ai ok (${ruleIds.size} rules)`);
