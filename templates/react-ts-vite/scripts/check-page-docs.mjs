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

// Route coverage (B-123): when src/router exists, every route declared there as an object key ("/path": ...) has a page document with a `Route: /path` line, and every
// `Route:` line names a declared route. `Route: none` marks a page that has no route of its own.
const routerDir = path.join(root, "src/router");
if (existsSync(routerDir)) {
  const declared = new Set();
  for (const name of readdirSync(routerDir)) {
    if (!/\.[jt]sx?$/.test(name) || /\.(?:test|spec)\./.test(name)) continue;
    for (const match of readFileSync(path.join(routerDir, name), "utf8").matchAll(/["'`](\/[^"'`\s]*)["'`]\s*:/g)) declared.add(match[1]);
  }
  const documented = new Map();
  for (const doc of docs) {
    const line = readFileSync(path.join(docsDir, doc), "utf8").match(/^Route:\s*(.+)$/m)?.[1];
    if (line === undefined) { problems.push(`docs/pages/${doc} has no 'Route:' line (write 'Route: /path', or 'Route: none' for a page without a route)`); continue; }
    for (const route of line.split(",").map(item => item.trim()).filter(item => item && item !== "none")) documented.set(route, doc);
  }
  for (const route of declared) if (!documented.has(route)) problems.push(`route '${route}' in src/router has no page document with 'Route: ${route}'`);
  for (const [route, doc] of documented) if (!declared.has(route)) problems.push(`docs/pages/${doc} declares 'Route: ${route}', which is not declared in src/router`);
}

if (problems.length) { console.error(`check:pages found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:pages ok (${pages.length} page(s))`);
