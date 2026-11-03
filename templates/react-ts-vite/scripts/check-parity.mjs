#!/usr/bin/env node
// Checks the characterization and parity contract of a migration (B-110, ADR 0032 decision 6): before a slice is ported, docs/characterization/<slice>.json records what the
// legacy code does (cases with source citations); the port is parity-checked because every characterized case is a case of a page document and is cited by a test.
//   { "schemaVersion": 1, "slice": "<file name>", "legacy": { "revision": "<commit>" }, "cases": [
//     { "id": "C-001", "page": "<page folder>", "behaviour": "...", "expected": "...", "basis": "static" | "observed", "sources": ["pages/x.vue:12-30"], "observation": "<needed when observed>" } ] }
// The migration map docs/migration/map.md (`| old file | new file | status | tests |`) is the ledger: a `ported` or `verified` row needs an existing new file and existing tests.
// With REFERENCE_ROOT set, every cited legacy source and every old file must exist there. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const reference = process.env.REFERENCE_ROOT ? path.resolve(process.env.REFERENCE_ROOT) : undefined;
const problems = [];
const read = file => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const isFile = file => existsSync(file) && statSync(file).isFile();
const STATUSES = new Set(["planned", "characterized", "ported", "verified", "deferred"]);
const text = value => typeof value === "string" && value.trim().length > 0;

const tests = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(full); }
    else if (/\.(?:test|spec)\.[jt]sx?$/.test(name)) tests.push({ file: path.relative(root, full).split(path.sep).join("/"), text: read(full) });
  }
};
for (const dir of ["src", "e2e", "tests"]) if (existsSync(path.join(root, dir))) walk(path.join(root, dir));
const pageOf = file => file.match(/^src\/pages\/([^/]+)\//)?.[1];
const testsFor = page => tests.filter(test => pageOf(test.file) === page || pageOf(test.file) === undefined).map(test => test.text).join("\n");
const pageCases = page => {
  const file = path.join(root, "docs/pages", `${page}.md`);
  return isFile(file) ? new Set(read(file).split(/^##\s+Cases\s*$/mi)[1]?.match(/\bC-\d{3}\b/g) ?? []) : undefined;
};

const characterizedPages = new Set();
const dir = path.join(root, "docs/characterization");
const artifacts = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).sort() : [];
for (const name of artifacts) {
  const rel = `docs/characterization/${name}`;
  let data;
  try { data = JSON.parse(read(path.join(dir, name))); } catch (error) { problems.push(`${rel} is not valid JSON (${error.message})`); continue; }
  if (data.schemaVersion !== 1) problems.push(`${rel}: schemaVersion must be 1`);
  if (data.slice !== name.replace(/\.json$/, "")) problems.push(`${rel}: slice must equal the file name '${name.replace(/\.json$/, "")}'`);
  if (!text(data.legacy?.revision)) problems.push(`${rel}: legacy.revision (the legacy commit the cases were read from) is required`);
  if (!Array.isArray(data.cases) || data.cases.length === 0) { problems.push(`${rel}: cases must be a non-empty array`); continue; }
  const seen = new Set();
  data.cases.forEach((item, index) => {
    const at = `${rel} case #${index + 1}`;
    if (!/^C-\d{3}$/.test(item?.id ?? "")) { problems.push(`${at}: id must look like C-001`); return; }
    const label = `${rel} ${item.id}`;
    const key = `${item.page}/${item.id}`;
    if (seen.has(key)) problems.push(`${label}: duplicate case for page '${item.page}'`);
    seen.add(key);
    for (const field of ["page", "behaviour", "expected"]) if (!text(item[field])) problems.push(`${label}: '${field}' is required`);
    if (text(item.page)) characterizedPages.add(item.page);
    if (item.basis !== "static" && item.basis !== "observed") problems.push(`${label}: basis must be 'static' (read from legacy code) or 'observed' (captured from the running legacy app)`);
    if (item.basis === "observed" && !text(item.observation)) problems.push(`${label}: an observed case needs 'observation' (the fixture or capture it came from)`);
    if (!Array.isArray(item.sources) || item.sources.length === 0 || !item.sources.every(text)) problems.push(`${label}: sources must list at least one legacy path (path or path:line-line)`);
    else if (reference) for (const source of item.sources) if (!isFile(path.join(reference, source.replace(/:\d+(?:-\d+)?$/, "")))) problems.push(`${label}: legacy source '${source}' does not exist under REFERENCE_ROOT`);
    if (text(item.page)) {
      const cases = pageCases(item.page);
      if (!cases) problems.push(`${label}: page '${item.page}' has no docs/pages/${item.page}.md`);
      else {
        if (!cases.has(item.id)) problems.push(`${label}: docs/pages/${item.page}.md does not list ${item.id} under Cases`);
        if (!testsFor(item.page).includes(item.id)) problems.push(`${label}: no test in src/pages/${item.page}/ or a shared test cites ${item.id} (the parity test is missing)`);
      }
    }
  });
}

const mapFile = path.join(root, "docs/migration/map.md");
let rows = 0;
if (isFile(mapFile)) for (const line of read(mapFile).split("\n")) {
  const cells = line.split("|").slice(1, -1).map(cell => cell.replace(/`/g, "").trim());
  if (cells.length < 4 || /^-+$/.test(cells[0].replace(/\s|:/g, "")) || cells[0].toLowerCase() === "old file") continue;
  rows += 1;
  const [oldFile, newFile, statusText, testCell] = cells;
  // The status cell may carry a short note ("ported; input wiring deferred"): the strongest keyword in it counts.
  const status = ["verified", "ported", "characterized", "planned", "deferred"].find(word => new RegExp(`\\b${word}\\b`, "i").test(statusText));
  if (!status) { problems.push(`docs/migration/map.md: '${oldFile}' has status '${statusText}' (it must contain one of ${[...STATUSES].join(", ")})`); continue; }
  // A cell may name several files separated by commas, and the old-file cell may carry a note after the path ("store/x.js history action").
  const oldPath = oldFile.split(/\s+/)[0];
  if (reference && oldPath && !/^(?:-|n\/a|none)$/i.test(oldPath) && !isFile(path.join(reference, oldPath))) problems.push(`docs/migration/map.md: old file '${oldPath}' does not exist under REFERENCE_ROOT`);
  // `verified` claims parity was proven, which needs a characterization of the page the new file belongs to (a `ported` row may still be waiting for it).
  if (status === "verified") for (const file of newFile.split(/[,;]/).map(item => item.trim().split(/\s+/)[0])) {
    const page = file.match(/^src\/pages\/([^/]+)\//)?.[1];
    if (page && !characterizedPages.has(page)) problems.push(`docs/migration/map.md: '${oldFile}' is verified but page '${page}' has no characterization (a docs/characterization/*.json case with "page": "${page}")`);
  }
  if (status === "ported" || status === "verified") {
    for (const file of newFile.split(/[,;]/).map(item => item.trim().split(/\s+/)[0]).filter(item => item && !/^(?:-|n\/a|none)$/i.test(item))) if (!isFile(path.join(root, file))) problems.push(`docs/migration/map.md: '${oldFile}' is ${status} but '${file}' does not exist`);
    const cited = testCell.split(/[,;]/).map(item => item.trim()).filter(item => item && !/^(?:-|n\/a|none)$/i.test(item));
    if (cited.length === 0) problems.push(`docs/migration/map.md: '${oldFile}' is ${status} without tests`);
    // A test may be named by path or by file name alone (the map is written by hand); a bare name matches any test file with that name.
    for (const file of cited) if (!isFile(path.join(root, file)) && !tests.some(test => path.posix.basename(test.file) === file)) problems.push(`docs/migration/map.md: '${oldFile}' cites test '${file}', which does not exist`);
  }
}

if (problems.length) { console.error(`check:parity found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:parity ok (${artifacts.length} characterization(s), ${rows} map row(s))`);
