#!/usr/bin/env node
// Checks the milestone e2e journey documents (B-132, ADR 0034/0035): few wide end-to-end tests per milestone, each described once in e2e/journeys/<slug>.md with
//   Id: J-001            (unique)
//   Milestone: M1
//   ## Steps             (numbered or bulleted, at least two)
//   ## Covers            (lines `<page>/C-nnn`: every one must be a case listed in docs/pages/<page>.md)
// and cited by an e2e test (J-001 in a test name under e2e/ or tests/). A test citing an unknown journey id fails too. At most MAX_PER_MILESTONE journeys per milestone
// (override with the JOURNEY_LIMIT environment variable). No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const MAX_PER_MILESTONE = Number(process.env.JOURNEY_LIMIT ?? 12);
const problems = [];
const read = file => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const section = (text, heading) => text.split(new RegExp(`^##\\s+${heading}\\s*$`, "mi"))[1]?.split(/^##\s/m)[0] ?? "";

const journeysDir = path.join(root, "e2e/journeys");
const journeyFiles = existsSync(journeysDir) ? readdirSync(journeysDir).filter(name => name.endsWith(".md") && !name.startsWith("_") && name !== "README.md").sort() : [];

const cases = new Map();
const pagesDir = path.join(root, "docs/pages");
if (existsSync(pagesDir)) for (const name of readdirSync(pagesDir).filter(file => file.endsWith(".md") && !file.startsWith("_") && file !== "README.md")) {
  cases.set(name.replace(/\.md$/, ""), new Set(section(read(path.join(pagesDir, name)), "Cases").match(/\bC-\d{3}\b/g) ?? []));
}

const testText = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(full); }
    else if (/\.(?:test|spec)\.[jt]sx?$/.test(name)) testText.push({ file: path.relative(root, full).split(path.sep).join("/"), text: read(full) });
  }
};
for (const dir of ["e2e", "tests"]) if (existsSync(path.join(root, dir))) walk(path.join(root, dir));
const allTests = testText.map(test => test.text).join("\n");

const ids = new Map();
const perMilestone = new Map();
for (const name of journeyFiles) {
  const file = `e2e/journeys/${name}`;
  const text = read(path.join(journeysDir, name));
  const id = text.match(/^Id:\s*(J-\d{3})\s*$/m)?.[1];
  if (!id) problems.push(`${file} has no 'Id: J-nnn' line`);
  else if (ids.has(id)) problems.push(`${file} repeats the id ${id} of ${ids.get(id)}`);
  else {
    ids.set(id, file);
    if (!allTests.includes(id)) problems.push(`${file}: journey ${id} is not cited by an e2e test (put the id in the test name)`);
  }
  const milestone = text.match(/^Milestone:\s*(\S+)\s*$/m)?.[1];
  if (!milestone) problems.push(`${file} has no 'Milestone:' line`);
  else perMilestone.set(milestone, (perMilestone.get(milestone) ?? 0) + 1);
  const steps = section(text, "Steps").split("\n").filter(line => /^\s*(?:\d+\.|[-*])\s+\S/.test(line));
  if (steps.length < 2) problems.push(`${file} needs a '## Steps' section with at least two steps`);
  const covers = section(text, "Covers").split("\n").map(line => line.trim().replace(/^[-*]\s+/, "")).filter(Boolean);
  if (covers.length === 0) problems.push(`${file} needs a '## Covers' section (lines like offline/C-001)`);
  for (const entry of covers) {
    const match = entry.match(/^([\w-]+)\/(C-\d{3})\b/);
    if (!match) { problems.push(`${file}: covers entry '${entry}' is not '<page>/C-nnn'`); continue; }
    if (!cases.get(match[1])?.has(match[2])) problems.push(`${file}: covers ${match[1]}/${match[2]}, which docs/pages/${match[1]}.md does not list`);
  }
}
for (const [milestone, count] of perMilestone) if (count > MAX_PER_MILESTONE) problems.push(`milestone ${milestone} has ${count} journeys (limit ${MAX_PER_MILESTONE}): keep e2e tests few and wide, move detail into page tests`);
for (const test of testText) for (const id of new Set(test.text.match(/\bJ-\d{3}\b/g) ?? [])) if (!ids.has(id)) problems.push(`${test.file} cites ${id}, which has no journey document in e2e/journeys/`);

if (problems.length) { console.error(`check:journeys found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:journeys ok (${journeyFiles.length} journey(s))`);
