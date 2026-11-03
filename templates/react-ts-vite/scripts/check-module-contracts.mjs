#!/usr/bin/env node
// Checks the component contract format (B-161, ADR 0034 decision 8): every module (a top-level folder under src that holds source files, except pages, styles and
// assets, plus any deeper folder that has its own README.md) has a README.md with a one-line purpose and the sections `## Interface`, `## Invariants` and
// `## Side Effects`, each with real content (write `none` when there is nothing). A later agent changes a module safely from this contract alone. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const SKIP = new Set(["pages", "styles", "assets", "node_modules"]);
const SECTIONS = ["Interface", "Invariants", "Side Effects"];
const problems = [];
const read = file => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const hasSource = dir => readdirSync(dir).some(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? !SKIP.has(name) && hasSource(full) : /\.(?:tsx?|css)$/.test(name) && !/\.(?:test|spec)\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts");
});

const modules = [];
const srcDir = path.join(root, "src");
const collect = (dir, depth) => {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory() || SKIP.has(name)) continue;
    if (depth === 0 ? hasSource(full) : existsSync(path.join(full, "README.md"))) modules.push(full);
    collect(full, depth + 1);
  }
};
if (existsSync(srcDir)) collect(srcDir, 0);

for (const dir of modules) {
  const rel = path.relative(root, dir).split(path.sep).join("/");
  const file = path.join(dir, "README.md");
  if (!existsSync(file)) { problems.push(`${rel}/ has no README.md (a one-line purpose plus ## Interface, ## Invariants and ## Side Effects; see docs/ai/MODULE_README_TEMPLATE.md)`); continue; }
  const text = read(file);
  const purpose = text.split(/^##\s/m)[0].split("\n").map(line => line.trim()).find(line => line && !line.startsWith("#"));
  if (!purpose) problems.push(`${rel}/README.md has no purpose line under the title`);
  for (const section of SECTIONS) {
    const body = text.split(new RegExp(`^##\\s+${section}\\s*$`, "mi"))[1]?.split(/^##\s/m)[0];
    if (body === undefined) problems.push(`${rel}/README.md is missing the section '## ${section}'`);
    else if (body.replace(/<!--[\s\S]*?-->/g, "").trim().length < 4) problems.push(`${rel}/README.md has an empty '## ${section}' (write 'none' if there is nothing)`);
  }
}

if (problems.length) { console.error(`check:contracts found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:contracts ok (${modules.length} module(s))`);
