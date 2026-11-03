#!/usr/bin/env node
// Checks the registry of protected components (B-125, ADR 0034): docs/ai/component-registry.json lists the components the whole app depends on (the carousel first). Once a protected component's folder exists,
// its design (R-024) must exist and be approved, and the folder needs the README contract (R-022). The registry itself must be well formed and name the carousel. No dependencies.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const problems = [];
const file = path.join(root, "docs/ai/component-registry.json");
let registry;
try { registry = JSON.parse(readFileSync(file, "utf8")); } catch (error) { console.error(`check:registry: docs/ai/component-registry.json is missing or not valid JSON (${error.message})`); process.exit(1); }

const components = Array.isArray(registry.components) ? registry.components : [];
if (registry.schemaVersion !== 1) problems.push("schemaVersion must be 1");
if (!Array.isArray(registry.components)) problems.push("'components' must be an array");
if (!components.some(component => component?.id === "carousel")) problems.push("the registry must list the carousel (id 'carousel'): it is the component the TV constraints exist for");

const safe = relative => typeof relative === "string" && relative.length > 0 && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes("..");
const seen = new Set();
for (const [index, component] of components.entries()) {
  const label = `component #${index + 1} ('${component?.id ?? "?"}')`;
  if (typeof component?.id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(component.id)) { problems.push(`${label}: id must be a lowercase slug`); continue; }
  if (seen.has(component.id)) problems.push(`${label}: duplicate id`);
  seen.add(component.id);
  if (!safe(component.path)) problems.push(`${label}: path must be a repository-relative folder`);
  if (typeof component.reason !== "string" || component.reason.trim().length < 20) problems.push(`${label}: a reason of at least 20 characters is required (why this component is protected)`);
  if (component.protected !== true) continue;
  if (!safe(component.design)) { problems.push(`${label}: a protected component names its design (docs/design/<name>.md)`); continue; }
  const folder = safe(component.path) ? path.join(root, component.path) : undefined;
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) continue;
  const design = path.join(root, component.design);
  if (!existsSync(design)) { problems.push(`${label}: ${component.path} exists but its design ${component.design} does not (R-024: design first)`); continue; }
  if (!/^Status:[ \t]*approved[ \t]*$/im.test(readFileSync(design, "utf8").replace(/\r\n/g, "\n"))) problems.push(`${label}: its design ${component.design} is not approved yet`);
  if (!existsSync(path.join(folder, "README.md"))) problems.push(`${label}: ${component.path}/README.md (the module contract, R-022) is missing`);
}

if (problems.length) { console.error(`check:registry found ${problems.length} problem(s):\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check:registry ok (${components.length} component(s), ${components.filter(component => component.protected === true).length} protected)`);
