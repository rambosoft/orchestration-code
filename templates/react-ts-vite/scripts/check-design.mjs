#!/usr/bin/env node
// Checks the design documents of critical areas (B-159, R-024): docs/design/<area>.md follows docs/design/_TEMPLATE.md, and a document that says `Status: approved` really is: no open questions, protected
// constraints with unique ids, and a review record from a reviewer other than its author whose latest verdict is approved. The orchestrator applies the same rules when it admits a critical task
// (src/design-gate.ts in the orchestrator; test/design-gate.test.ts keeps the two equal). No dependencies.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const SECTIONS = ["Purpose", "Protected constraints", "Interfaces", "Failure modes", "Test plan", "Open questions", "Review record"];

function parse(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const sections = new Map(); let current; const body = []; const head = [];
  const flush = () => { if (current) sections.set(current, body.join("\n").trim()); body.length = 0; };
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { flush(); current = SECTIONS.find(name => name.toLowerCase() === heading[1].toLowerCase()) ?? heading[1]; continue; }
    if (current) body.push(line); else head.push(line);
  }
  flush();
  const headText = head.join("\n");
  const field = name => new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, "im").exec(headText)?.[1];
  const status = field("Status")?.toLowerCase();
  const constraints = [...(sections.get("Protected constraints") ?? "").matchAll(/^- (D-\d{3}) (.+)$/gm)].map(match => match[1]);
  const reviews = [...(sections.get("Review record") ?? "").matchAll(/^- (\S+) (\d{4}-\d{2}-\d{2}) (approved|changes): (.+)$/gm)].map(match => ({ reviewer: match[1], verdict: match[3] }));
  return { title: /^#\s+(.+?)\s*$/m.exec(headText)?.[1] ?? "", status: status === "draft" || status === "approved" ? status : undefined, area: field("Area"), author: field("Author"), sections, constraints, reviews };
}

function problemsOf(raw) {
  const design = parse(raw); const problems = [];
  if (!design.title.toLowerCase().startsWith("design")) problems.push("the title must start with 'Design'");
  if (!design.status) problems.push("a 'Status: draft' or 'Status: approved' line is required");
  if (!design.area || !/^[a-z0-9-]{1,40}$/.test(design.area)) problems.push("an 'Area: <slug>' line is required");
  if (!design.author) problems.push("an 'Author: <the provider that wrote it>' line is required");
  for (const section of SECTIONS) {
    if (!design.sections.has(section)) problems.push(`the section '## ${section}' is missing`);
    else if (!design.sections.get(section)) problems.push(`the section '## ${section}' is empty`);
  }
  if (design.sections.has("Protected constraints")) {
    if (!design.constraints.length) problems.push("'## Protected constraints' needs at least one '- D-001 <constraint>' line");
    if (new Set(design.constraints).size !== design.constraints.length) problems.push("constraint ids must be unique");
  }
  if (design.status === "approved") {
    const open = (design.sections.get("Open questions") ?? "").trim().toLowerCase().replace(/[.\s]+$/, "");
    if (design.sections.has("Open questions") && open !== "none") problems.push("an approved design has no open questions: '## Open questions' must say 'none'");
    const author = design.author?.toLowerCase();
    if (!design.reviews.some(review => review.verdict === "approved" && review.reviewer.toLowerCase() !== author)) problems.push("an approved design needs a review record from a reviewer other than its author ('- <reviewer> <yyyy-mm-dd> approved: <note>')");
    if (design.reviews.length && design.reviews[design.reviews.length - 1].verdict !== "approved") problems.push("the latest review asked for changes");
  }
  return problems;
}

const dir = path.join(root, "docs/design");
const files = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".md") && !name.startsWith("_")).sort() : [];
const failures = [];
for (const name of files) for (const problem of problemsOf(readFileSync(path.join(dir, name), "utf8"))) failures.push(`docs/design/${name}: ${problem}`);
if (failures.length) { console.error(`check:design found ${failures.length} problem(s):\n- ${failures.join("\n- ")}`); process.exit(1); }
console.log(`check:design ok (${files.length} design document(s))`);
