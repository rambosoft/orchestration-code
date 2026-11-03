#!/usr/bin/env node
// Checks rule R-015 (ADR 0034, B-122): outside src/styles, sizes come from rem and tokens, never raw colours, px or viewport units. Allowed: `100vh` on min-height/height
// (full-height containers, never a rem value), px inside @media preludes (a query cannot use a variable), and a line tagged `token-ok: <reason>` (custom styling is the
// exception and needs a reason). Scans .css, .ts and .tsx under src (tests and src/styles excluded). No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const problems = [];
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const PX = /(?<![\w.]|\w-)-?\d*\.?\d+px\b/;
const VIEWPORT = /(?<![\w.]|\w-)-?(\d*\.?\d+)(vh|vw|vmin|vmax|dvh|svh|lvh)\b/g;

const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (!["node_modules", "dist", "styles"].includes(name)) walk(full); }
    else if (/\.(?:css|tsx?)$/.test(name) && !/\.(?:test|spec)\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts")) files.push(full);
  }
};
if (existsSync(path.join(root, "src"))) walk(path.join(root, "src"));

for (const file of files) {
  const css = file.endsWith(".css");
  const text = readFileSync(file, "utf8");
  // Blank out block comments but keep line numbers; a `token-ok:` tag is looked up on the raw line.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "));
  const raw = text.split(/\r?\n/);
  code.split(/\r?\n/).forEach((line, index) => {
    if (/token-ok:\s*[^\s*]/.test(raw[index])) return;
    const scan = css ? line : line.replace(/\/\/.*$/, "");
    if (!css && !/["'`]/.test(scan)) return;
    const where = `${path.relative(root, file).split(path.sep).join("/")}:${index + 1}`;
    const declaration = css ? /:\s*[^;{}]*\S/.test(scan) : /["'`][^"'`]*(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\()/.test(scan);
    if (declaration && COLOUR.test(scan)) problems.push(`${where}: raw colour (use a --color-* token)`);
    const atRule = /^\s*@(?:media|container|supports)\b/.test(scan);
    if (!atRule && PX.test(scan)) problems.push(`${where}: raw px (use rem or a token)`);
    if (!atRule) for (const match of scan.matchAll(VIEWPORT)) {
      const allowed = match[1] === "100" && match[2] === "vh" && /\b(?:min-)?height\s*:/.test(scan);
      if (!allowed) problems.push(`${where}: viewport unit ${match[0]} (only 100vh on min-height or height is allowed)`);
    }
  });
}

if (problems.length) { console.error(`check:styles found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:styles ok (${files.length} file(s))`);
