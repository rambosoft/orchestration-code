#!/usr/bin/env node
// Checks the living page documents (ADR 0034 decision 8, ADR 0035 decision 2): every page folder src/pages/<name>/ has docs/pages/<name>.md with the required sections and
// at least one case id (C-nnn); every case id is cited by a test; no document describes a page that no longer exists. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const SECTIONS = ["Purpose", "Visible content", "Actions", "Inputs", "Data", "Cases"];
const problems = [];

const pagesDir = path.join(root, "src/pages");
const pages = existsSync(pagesDir) ? readdirSync(pagesDir).filter(name => statSync(path.join(pagesDir, name)).isDirectory()) : [];
const docsDir = path.join(root, "docs/pages");
const docs = existsSync(docsDir) ? readdirSync(docsDir).filter(name => name.endsWith(".md") && !name.startsWith("_") && name !== "README.md") : [];

const testText = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(full); }
    else if (/\.(?:test|spec)\.[jt]sx?$/.test(name)) testText.push(readFileSync(full, "utf8"));
  }
};
for (const dir of ["src", "e2e", "tests"]) if (existsSync(path.join(root, dir))) walk(path.join(root, dir));
const allTests = testText.join("\n");

for (const page of pages) {
  const docFile = `docs/pages/${page}.md`;
  if (!docs.includes(`${page}.md`)) { problems.push(`page '${page}' has no ${docFile}`); continue; }
  const text = readFileSync(path.join(root, docFile), "utf8");
  for (const section of SECTIONS) if (!new RegExp(`^##\\s+${section}\\s*$`, "mi").test(text)) problems.push(`${docFile} is missing the section '## ${section}'`);
  const cases = text.split(/^##\s+Cases\s*$/mi)[1]?.match(/\bC-\d{3}\b/g) ?? [];
  if (cases.length === 0) problems.push(`${docFile} lists no cases (C-001 and so on): states, actions and edge cases`);
  for (const id of new Set(cases)) if (!allTests.includes(id)) problems.push(`${docFile}: case ${id} is not cited by any test (put the id in the test name)`);
}
for (const doc of docs) if (!pages.includes(doc.replace(/\.md$/, ""))) problems.push(`docs/pages/${doc} describes a page folder that does not exist`);

if (problems.length) { console.error(`check:pages found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:pages ok (${pages.length} page(s))`);
