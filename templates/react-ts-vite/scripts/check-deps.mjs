#!/usr/bin/env node
// Dependency hygiene (B-113, R-014): every dependency in package.json is on docs/ai/dependency-allowlist.json (the pack's own tooling and the React stack, each with a reason) or has a recorded decision in
// docs/decisions/*.md: a `Dependency: <name>` line followed by a `Reason: <why>` line (bundle size, memory, device support, maintenance, licence). Models reinvent libraries and add packages casually;
// this keeps both visible. No dependencies.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const problems = [];
const readJson = (file, label) => { try { return JSON.parse(readFileSync(path.join(root, file), "utf8")); } catch (error) { problems.push(`${label} is missing or not valid JSON (${error.message})`); return undefined; } };

const manifest = readJson("package.json", "package.json");
const names = manifest ? [...new Set(["dependencies", "devDependencies", "optionalDependencies"].flatMap(group => Object.keys(manifest[group] ?? {})))].sort() : [];

const allowed = new Set();
const allowFile = existsSync(path.join(root, "docs/ai/dependency-allowlist.json")) ? readJson("docs/ai/dependency-allowlist.json", "docs/ai/dependency-allowlist.json") : undefined;
if (!allowFile && manifest) problems.push("docs/ai/dependency-allowlist.json is missing (the pack ships it)");
for (const entry of allowFile?.allow ?? []) {
  if (typeof entry?.name !== "string" || !entry.name) { problems.push("dependency-allowlist.json: every entry needs a 'name'"); continue; }
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 5) { problems.push(`dependency-allowlist.json: '${entry.name}' needs a 'reason'`); continue; }
  allowed.add(entry.name);
}

const decided = new Set();
const decisions = path.join(root, "docs/decisions");
if (existsSync(decisions)) for (const file of readdirSync(decisions).filter(name => name.endsWith(".md")).sort()) {
  let pending;
  for (const line of readFileSync(path.join(decisions, file), "utf8").replace(/\r\n/g, "\n").split("\n")) {
    const dependency = /^Dependency:[ \t]*(\S+)[ \t]*$/i.exec(line);
    if (dependency) { if (pending) problems.push(`docs/decisions/${file}: 'Dependency: ${pending}' has no 'Reason:' line`); pending = dependency[1]; continue; }
    const reason = /^Reason:[ \t]*(.+?)[ \t]*$/i.exec(line);
    if (reason && pending) { if (reason[1].length >= 10) decided.add(pending); else problems.push(`docs/decisions/${file}: the reason for '${pending}' is too short to be a reason`); pending = undefined; }
  }
  if (pending) problems.push(`docs/decisions/${file}: 'Dependency: ${pending}' has no 'Reason:' line`);
}

for (const name of names) if (!allowed.has(name) && !decided.has(name)) problems.push(`dependency '${name}' is not on the allow-list and has no recorded decision (add docs/decisions/<n>-${name.replace(/[^a-z0-9]+/gi, "-")}.md with 'Dependency: ${name}' and 'Reason: <why>', R-014)`);

if (problems.length) { console.error(`check:deps found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:deps ok (${names.length} dependencies: ${names.filter(name => allowed.has(name)).length} allow-listed, ${names.filter(name => !allowed.has(name)).length} with a decision)`);
