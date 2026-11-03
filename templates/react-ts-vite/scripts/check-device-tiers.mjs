#!/usr/bin/env node
// Checks the device-tier matrix and the legacy build configuration (B-114, ADR 0032 decision 10, ADR 0034): docs/ai/device-tiers.json is valid, every shipping tier has a floor
// (or is explicitly marked as waiting for operator data), and vite.config.* really builds the legacy tier: it imports the plugin the matrix names and passes the matrix targets.
// No dependencies.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const problems = [];
const matrixFile = path.join(root, "docs/ai/device-tiers.json");
if (!existsSync(matrixFile)) { console.error("check:device-tiers: docs/ai/device-tiers.json is missing (copy it from the react-ts-vite pack)"); process.exit(1); }

let matrix;
try { matrix = JSON.parse(readFileSync(matrixFile, "utf8")); } catch (error) { console.error(`check:device-tiers: docs/ai/device-tiers.json is not valid JSON (${error.message})`); process.exit(1); }
if (matrix.schemaVersion !== 1) problems.push("device-tiers.json: schemaVersion must be 1");
const tiers = Array.isArray(matrix.tiers) ? matrix.tiers : [];
if (tiers.length === 0) problems.push("device-tiers.json: tiers must be a non-empty array");
const ids = new Set();
for (const tier of tiers) {
  if (typeof tier.id !== "string" || !tier.id) { problems.push("device-tiers.json: every tier needs an id"); continue; }
  if (ids.has(tier.id)) problems.push(`device-tiers.json: duplicate tier '${tier.id}'`);
  ids.add(tier.id);
  if (typeof tier.ship !== "boolean") problems.push(`device-tiers.json: tier '${tier.id}' needs "ship": true or false`);
  if (tier.ship === true && !Number.isFinite(tier.browserFloor) && tier.status !== "operator-data-pending") problems.push(`device-tiers.json: shipping tier '${tier.id}' has no browserFloor (set one, or mark it "status": "operator-data-pending")`);
}
const legacy = tiers.find(tier => tier.id === "legacy");
if (!legacy) problems.push("device-tiers.json: the 'legacy' tier is required (the nomodule bundle for old TVs)");
else {
  if (!Number.isFinite(legacy.browserFloor)) problems.push("device-tiers.json: legacy.browserFloor must be a number");
  if (typeof legacy.vite?.plugin !== "string" || !Array.isArray(legacy.vite?.targets) || legacy.vite.targets.length === 0) problems.push("device-tiers.json: legacy.vite needs plugin and targets");
  else if (!legacy.vite.targets.some(target => new RegExp(`chrome\\s*>=\\s*${legacy.browserFloor}\\b`, "i").test(target))) problems.push(`device-tiers.json: legacy.vite.targets must contain 'Chrome >= ${legacy.browserFloor}'`);
  if (!Number.isInteger(legacy.maxEcmaVersion) || legacy.maxEcmaVersion < 2015) problems.push("device-tiers.json: legacy.maxEcmaVersion must be a year such as 2016");

  const configFile = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].map(name => path.join(root, name)).find(existsSync);
  if (!configFile) problems.push("no vite.config.* found to check the legacy build");
  else if (legacy.vite?.plugin) {
    const config = readFileSync(configFile, "utf8");
    const name = path.basename(configFile);
    if (!config.includes(legacy.vite.plugin)) problems.push(`${name} does not use ${legacy.vite.plugin}: the legacy tier would not be built (npm run apply the pack, or add legacy({ targets: [...] }))`);
    else for (const target of legacy.vite.targets ?? []) if (!config.includes(target)) problems.push(`${name} does not pass the legacy target '${target}' from device-tiers.json`);
    if (/polyfills\s*:\s*false/.test(config)) problems.push(`${name} turns the legacy polyfills off (polyfills: false); old engines need them`);
  }
}
const budget = matrix.budget;
if (!budget || !(budget.totalGrowthPercent > 0) || !(budget.largestFileGrowthPercent > 0)) problems.push("device-tiers.json: budget.totalGrowthPercent and budget.largestFileGrowthPercent must be positive numbers");

if (problems.length) { console.error(`check:device-tiers found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:device-tiers ok (${tiers.length} tier(s), legacy Chrome ${legacy.browserFloor})`);
