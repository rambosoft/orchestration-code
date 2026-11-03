#!/usr/bin/env node
// Checks the legacy bundle size budget (B-114): after `npm run build`, the total bytes of the legacy JavaScript (`*legacy*.js`) and the largest legacy file may grow by at most the
// percentages in docs/ai/device-tiers.json (10% total, 5% largest by default) over the recorded baseline docs/ai/legacy-budget.json. The baseline belongs to THIS app: record it from
// the first accepted build with `npm run check:legacy-budget -- --update` and commit it. Without a baseline the check only reports the sizes. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const update = args.includes("--update");
const root = path.resolve(args.find(arg => !arg.startsWith("--")) ?? ".");
const dist = path.join(root, "dist");
if (!existsSync(dist)) { console.error("check:legacy-budget: dist/ does not exist; run `npm run build` first"); process.exit(1); }

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const sizes = walk(dist).filter(file => /legacy[^/\\]*\.js$/.test(path.basename(file))).map(file => statSync(file).size);
if (sizes.length === 0) { console.error("check:legacy-budget: no legacy chunk in dist: the legacy tier was not built"); process.exit(1); }
const current = { totalBytes: sizes.reduce((sum, size) => sum + size, 0), largestBytes: Math.max(...sizes) };

const baselineFile = path.join(root, "docs/ai/legacy-budget.json");
if (update) {
  writeFileSync(baselineFile, `${JSON.stringify({ schemaVersion: 1, ...current }, null, 2)}\n`);
  console.log(`check:legacy-budget baseline recorded: total ${current.totalBytes} bytes, largest ${current.largestBytes} bytes (${path.relative(root, baselineFile).split(path.sep).join("/")})`);
  process.exit(0);
}
if (!existsSync(baselineFile)) { console.log(`check:legacy-budget: no baseline yet (total ${current.totalBytes} bytes, largest ${current.largestBytes} bytes); record it after the first accepted build with \`npm run check:legacy-budget -- --update\``); process.exit(0); }

const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const tiersFile = path.join(root, "docs/ai/device-tiers.json");
const budget = existsSync(tiersFile) ? JSON.parse(readFileSync(tiersFile, "utf8")).budget : undefined;
const totalLimit = budget?.totalGrowthPercent ?? 10;
const largestLimit = budget?.largestFileGrowthPercent ?? 5;
const problems = [];
const check = (label, now, before, limit) => {
  const allowed = Math.floor(before * (1 + limit / 100));
  if (now > allowed) problems.push(`legacy ${label} is ${now} bytes, over the budget of ${allowed} (baseline ${before} + ${limit}%). Reduce it, or accept the growth by re-recording the baseline with a recorded reason`);
};
check("total", current.totalBytes, baseline.totalBytes, totalLimit);
check("largest file", current.largestBytes, baseline.largestBytes, largestLimit);

if (problems.length) { console.error(`check:legacy-budget found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:legacy-budget ok (total ${current.totalBytes} of ${Math.floor(baseline.totalBytes * (1 + totalLimit / 100))}, largest ${current.largestBytes} of ${Math.floor(baseline.largestBytes * (1 + largestLimit / 100))})`);
