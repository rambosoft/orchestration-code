#!/usr/bin/env node
// Checks the emitted legacy bundle (B-114): after `npm run build`, every legacy chunk in dist (`*-legacy-*.js`, including the polyfill chunk) must parse as a classic script of at most
// ECMAScript legacy.maxEcmaVersion from docs/ai/device-tiers.json (2016 for Chrome 53), and dist/index.html must carry the nomodule legacy entries. Node's own parser is not proof,
// so this uses acorn. A smoke on a real old engine stays an operator device check. Exit 1 on any problem. Needs `acorn` (a devDependency of the pack).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(process.argv[2] ?? ".");
let acorn;
// The project's own acorn first, then the one next to this script (the pack checkout when the script runs from there).
for (const base of [path.join(root, "package.json"), import.meta.url]) { try { acorn = createRequire(base)("acorn"); break; } catch { /* try the next location */ } }
if (!acorn) { console.error("check:legacy-syntax: the 'acorn' package is not installed (npm install -D acorn)"); process.exit(1); }

const problems = [];
const dist = path.join(root, "dist");
if (!existsSync(dist)) { console.error("check:legacy-syntax: dist/ does not exist; run `npm run build` first"); process.exit(1); }
const tiersFile = path.join(root, "docs/ai/device-tiers.json");
const maxEcma = (existsSync(tiersFile) ? JSON.parse(readFileSync(tiersFile, "utf8")).tiers?.find(tier => tier.id === "legacy")?.maxEcmaVersion : undefined) ?? 2016;

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const chunks = walk(dist).filter(file => /-legacy[-.][^/\\]*\.js$/.test(file) || /legacy[^/\\]*\.js$/.test(path.basename(file)));
if (chunks.length === 0) problems.push("no legacy chunk (*-legacy-*.js) in dist: the legacy tier was not built (check vite.config and device-tiers.json)");
for (const file of chunks) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  try { acorn.parse(readFileSync(file, "utf8"), { ecmaVersion: maxEcma, sourceType: "script" }); }
  catch (error) { problems.push(`${rel}: not valid ES${maxEcma} classic script (${error.message})`); }
}
const html = path.join(dist, "index.html");
if (existsSync(html) && chunks.length > 0 && !/nomodule/.test(readFileSync(html, "utf8"))) problems.push("dist/index.html has no nomodule legacy entry: old engines would load nothing");

if (problems.length) { console.error(`check:legacy-syntax found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:legacy-syntax ok (${chunks.length} legacy chunk(s) parse as ES${maxEcma})`);
