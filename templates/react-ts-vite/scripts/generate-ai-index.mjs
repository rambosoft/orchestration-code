#!/usr/bin/env node
// Regenerates the pages and modules lists of docs/ai/INDEX.md between the generated markers from the real files (B-123, ADR 0034 decision 8), so the map cannot rot:
// pages come from docs/pages/*.md (route and purpose), modules from the folders under src (purpose from the folder's README.md). `--check` writes nothing and fails when
// the block is missing or out of date (drift). Hand-written lines outside the markers are never touched. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const root = path.resolve(args.find(arg => !arg.startsWith("--")) ?? ".");
const BEGIN = "<!-- generated:begin (npm run ai:index; do not edit by hand) -->";
const END = "<!-- generated:end -->";
const SKIP_MODULES = new Set(["pages", "styles", "assets", "node_modules"]);
const clip = (text, max = 140) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const read = file => (existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "");
const firstLineAfter = (text, heading) => {
  const section = text.split(new RegExp(`^##\\s+${heading}\\s*$`, "mi"))[1] ?? "";
  return (section.split("\n").map(line => line.trim()).find(line => line && !line.startsWith("#")) ?? "").replace(/^[-*]\s+/, "");
};
const dirs = dir => (existsSync(dir) ? readdirSync(dir).filter(name => statSync(path.join(dir, name)).isDirectory()).sort() : []);

const pageLines = [];
const docsDir = path.join(root, "docs/pages");
for (const name of existsSync(docsDir) ? readdirSync(docsDir).filter(file => file.endsWith(".md") && !file.startsWith("_") && file !== "README.md").sort() : []) {
  const text = read(path.join(docsDir, name));
  const route = text.match(/^Route:\s*(\S+)/m)?.[1] ?? "no route declared";
  pageLines.push(`- \`${name.replace(/\.md$/, "")}\` (${route}): ${clip(firstLineAfter(text, "Purpose") || "no purpose written")} -> \`docs/pages/${name}\``);
}
const moduleLines = [];
for (const name of dirs(path.join(root, "src")).filter(item => !SKIP_MODULES.has(item))) {
  const readme = read(path.join(root, "src", name, "README.md"));
  const purpose = readme.split(/^##\s/m)[0].split("\n").map(line => line.trim()).find(line => line && !line.startsWith("#"));
  moduleLines.push(`- \`src/${name}/\`: ${purpose ? clip(purpose) : "no README.md yet (add one with Interface, Invariants and Side Effects)"}`);
}
const block = [BEGIN, "### Pages", ...(pageLines.length ? pageLines : ["- none yet"]), "", "### Modules", ...(moduleLines.length ? moduleLines : ["- none yet"]), END].join("\n");

const indexFile = path.join(root, "docs/ai/INDEX.md");
const current = read(indexFile);
if (!current) { console.error("docs/ai/INDEX.md is missing"); process.exit(1); }
const start = current.indexOf(BEGIN);
const end = current.indexOf(END);
const next = start >= 0 && end > start ? `${current.slice(0, start)}${block}${current.slice(end + END.length)}` : `${current.replace(/\s*$/, "")}\n\n${block}\n`;
if (check) {
  if (start < 0 || end < start) { console.error("check:index: docs/ai/INDEX.md has no generated block; run `npm run ai:index`"); process.exit(1); }
  if (next !== current) { console.error("check:index: docs/ai/INDEX.md is out of date with docs/pages and src; run `npm run ai:index` and commit the result"); process.exit(1); }
  console.log(`check:index ok (${pageLines.length} page(s), ${moduleLines.length} module(s))`);
} else {
  if (next !== current) writeFileSync(indexFile, next);
  console.log(`ai:index ${next === current ? "unchanged" : "updated"} (${pageLines.length} page(s), ${moduleLines.length} module(s))`);
}
