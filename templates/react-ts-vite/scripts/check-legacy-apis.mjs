#!/usr/bin/env node
// Checks the source for browser features the legacy tier cannot run (B-114, rule R-019): the rules in docs/ai/legacy-banned.json (DOM APIs and CSS the polyfills cannot supply,
// each with the Chrome version that introduced it) that are newer than the legacy floor in docs/ai/device-tiers.json fail, in src/**/*.css (CSS rules) and src/**/*.ts(x) (JS rules).
// Tag a line `legacy-ok: <reason>` when a documented fallback covers it. Tests are skipped. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const read = file => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const rulesFile = path.join(root, "docs/ai/legacy-banned.json");
const tiersFile = path.join(root, "docs/ai/device-tiers.json");
if (!existsSync(rulesFile)) { console.error("check:legacy-apis: docs/ai/legacy-banned.json is missing (copy it from the react-ts-vite pack)"); process.exit(1); }
const floor = (existsSync(tiersFile) ? JSON.parse(read(tiersFile)).tiers?.find(tier => tier.id === "legacy")?.browserFloor : undefined) ?? 53;
const rules = (JSON.parse(read(rulesFile)).rules ?? []).filter(rule => rule.minChrome > floor).map(rule => ({ ...rule, regex: new RegExp(rule.pattern) }));

const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(full); }
    else if (/\.(?:css|tsx?)$/.test(name) && !/\.(?:test|spec)\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts")) files.push(full);
  }
};
if (existsSync(path.join(root, "src"))) walk(path.join(root, "src"));

const problems = [];
for (const file of files) {
  const css = file.endsWith(".css");
  const raw = read(file).split("\n");
  const code = read(file).replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " ")).split("\n");
  code.forEach((line, index) => {
    if (/legacy-ok:\s*[^\s*]/.test(raw[index])) return;
    const scan = css ? line : line.replace(/\/\/.*$/, "");
    for (const rule of rules) if (rule.kind === (css ? "css" : "js") && rule.regex.test(scan)) problems.push(`${path.relative(root, file).split(path.sep).join("/")}:${index + 1}: ${rule.id} needs Chrome ${rule.minChrome}, the legacy floor is ${floor} (${rule.hint})`);
  });
}

if (problems.length) { console.error(`check:legacy-apis found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:legacy-apis ok (${files.length} file(s), ${rules.length} rule(s) above Chrome ${floor})`);
