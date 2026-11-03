#!/usr/bin/env node
// Checks deferred work (ADR 0034, decision 7): every `TODO(debt:D-nnn)` or `@deprecated ... (debt:D-nnn)` in src/ needs a row in docs/technical-debt/LEDGER.md with
// ID, reason, risk, next action, owner, tracking reference and a review date that has not passed. No dependencies. CHECK_TODAY=YYYY-MM-DD overrides the date for tests.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const today = process.env.CHECK_TODAY ?? new Date().toISOString().slice(0, 10);
const problems = [];

const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(full); }
    else if (/\.(?:tsx?|jsx?|css)$/.test(name)) files.push(full);
  }
};
if (existsSync(path.join(root, "src"))) walk(path.join(root, "src"));

const tags = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const where = `${path.relative(root, file).split(path.sep).join("/")}:${index + 1}`;
    for (const match of line.matchAll(/TODO\(debt:(D-\d{3})\)/g)) tags.push({ id: match[1], where });
    if (/@deprecated/.test(line)) {
      const id = /debt:(D-\d{3})/.exec(line)?.[1];
      const note = line.replace(/^.*@deprecated/, "").replace(/\(debt:D-\d{3}\)/, "").replace(/\*\/\s*$/, "").trim();
      if (note.length < 8) problems.push(`${where}: @deprecated needs the replacement or the reason`);
      if (!id) problems.push(`${where}: @deprecated needs a ledger reference, for example "(debt:D-012)"`); else tags.push({ id, where });
    }
    if (/TODO(?!\(debt:)/.test(line)) problems.push(`${where}: a TODO without a ledger id; write TODO(debt:D-nnn) and add the ledger row, or do it now`);
  });
}

const ledgerFile = path.join(root, "docs/technical-debt/LEDGER.md");
const rows = new Map();
const COLUMNS = ["id", "reason", "risk", "next action", "owner", "tracking", "review date"];
if (existsSync(ledgerFile)) {
  const header = readFileSync(ledgerFile, "utf8").split(/\r?\n/).filter(line => line.trim().startsWith("|"));
  const names = (header[0] ?? "").split("|").slice(1, -1).map(cell => cell.trim().toLowerCase());
  if (COLUMNS.some((column, index) => names[index] !== column)) problems.push(`docs/technical-debt/LEDGER.md header must be: | ${COLUMNS.join(" | ")} |`);
  for (const line of header.slice(2)) {
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (!/^D-\d{3}$/.test(cells[0] ?? "")) continue;
    rows.set(cells[0], cells);
    COLUMNS.forEach((column, index) => { if (!cells[index] || cells[index] === "-" || /^<.*>$/.test(cells[index])) problems.push(`${cells[0]}: '${column}' is empty`); });
    const date = cells[6] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`${cells[0]}: review date '${date}' is not YYYY-MM-DD`);
    else if (date < today) problems.push(`${cells[0]}: review date ${date} has passed (today ${today}); decide, fix or set a new date`);
  }
} else if (tags.length) problems.push("docs/technical-debt/LEDGER.md is missing but the code carries debt tags");
for (const tag of tags) if (!rows.has(tag.id)) problems.push(`${tag.where}: ${tag.id} has no row in docs/technical-debt/LEDGER.md`);

if (problems.length) { console.error(`check:debt found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:debt ok (${tags.length} tag(s), ${rows.size} ledger row(s))`);
