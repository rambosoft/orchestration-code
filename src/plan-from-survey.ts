import { BacklogItemSchema, type Survey } from "./survey.js";
import type { E2eSpec } from "./e2e.js";
import { inferArea } from "./area-routing.js";
import { laneFor } from "./lanes.js";
import { estimateSize, proposeSplit, type SizeLimits } from "./task-size.js";

export type BacklogItem = Survey["refactor_backlog"][number];

export function parseSurveyBacklog(markdown: string): BacklogItem[] {
  const machineHeading = /^## Machine-readable backlog\s*$/im.exec(markdown);
  const section = machineHeading ? markdown.slice(machineHeading.index + machineHeading[0].length).split(/^## /m, 1)[0] : undefined;
  if (section) {
    const block = /```json\s*([\s\S]*?)```/i.exec(section)?.[1];
    if (block) {
      let parsed: unknown;
      try { parsed = JSON.parse(block); } catch (error) { throw new Error("Machine-readable backlog contains invalid JSON: " + String(error)); }
      const rows = (parsed as { backlog?: unknown } | null)?.backlog;
      if (!Array.isArray(rows)) throw new Error("Machine-readable backlog must contain a backlog array");
      return rows.map((row, index) => {
        const result = BacklogItemSchema.safeParse(row);
        if (!result.success) throw new Error("Invalid machine-readable backlog item " + (index + 1) + ": " + result.error.issues.map(issue => issue.message).join("; "));
        return result.data;
      });
    }
  }
  const lines = markdown.split(/\r?\n/);
  const heading = lines.findIndex(line => /^## Refactor backlog\s*$/i.test(line.trim()));
  if (heading < 0) throw new Error("No survey backlog found (expected a machine-readable backlog or Refactor backlog table)");
  const table = lines.slice(heading + 1).findIndex(line => /^\s*\|\s*id\s*\|/i.test(line));
  if (table < 0) throw new Error("Refactor backlog table was not found");
  const physicalLines = lines.slice(heading + 1 + table);
  const tableLines: string[] = [];
  for (const line of physicalLines) {
    if (/^\s*\|/.test(line)) tableLines.push(line.trim());
    else if (tableLines.length && line.trim() && !/^## /.test(line.trim())) tableLines[tableLines.length - 1] += " " + line.trim();
    else if (tableLines.length) break;
  }
  const headers = tableLines[0]!.split("|").slice(1, -1).map(value => value.trim().toLowerCase());
  const rows: BacklogItem[] = [];
  for (const line of tableLines.slice(2)) {
    const cells = line.split("|").slice(1, -1).map(value => value.trim());
    if (cells.length !== headers.length) continue;
    const values = Object.fromEntries(headers.map((header, index) => [header, cells[index]!.replace(/^\*\*(.*)\*\*$/, "$1")]));
    const get = (...names: string[]) => names.map(name => values[name]).find(value => value !== undefined) ?? "";
    const yes = (value: string) => /^\*?\*?yes\*?\*?$/i.test(value.trim());
    const oldPaths = get("old paths", "old_paths").split(/<br\s*\/?\s*>/i).map(value => value.trim()).filter(Boolean);
    const raw = { id: get("id"), title: get("title"), kind: get("kind"), size: get("size"), old_paths: oldPaths, target: get("target"), depends_on: get("depends on", "depends_on").split(/[,;]\s*/).filter(value => value && value !== "-"), tests: [], changes_behaviour: yes(get("changes behaviour", "changes_behaviour")), area: get("area") || "general", critical: yes(get("critical")), notes: undefined };
    const result = BacklogItemSchema.safeParse(raw);
    if (!result.success) throw new Error("Invalid Refactor backlog table row: " + result.error.issues.map(issue => issue.message).join("; "));
    rows.push(result.data);
  }
  if (!rows.length) throw new Error("Refactor backlog table contains no backlog items");
  return rows;
}

export function planFromBacklog(items: BacklogItem[], options: { projectId: string; prefix: string; reference?: boolean; characterize?: boolean; /** Only these backlog ids (one milestone); dependencies on the others count as done elsewhere. */ only?: string[]; /** Approved design document per area (B-159): a critical task of that area carries `Design:`. */ designs?: Record<string, string>; /** Area and criticality per backlog id, when the guess from the old paths is not what the plan says. */ areas?: Record<string, { area: string; critical: boolean }>; /** Task size gate: items estimated large are left out and listed in `needsSplit`; small items get a `Lane: light` line. Absent: no sizing. */ limits?: SizeLimits; /** With `limits`: merge consecutive small same-area items (generation time only, before any issue exists). */ mergeSmall?: boolean }): { spec: Pick<E2eSpec, "projectId" | "tasks">; plan: string; needsDecision: BacklogItem[]; needsDesign: string[]; needsSplit: Array<{ id: string; title: string; files: number; areas: number; reasons: string[]; proposal: Array<{ title: string; files: string[] }> }> } {
  if (options.only?.length) {
    const wanted = new Set(options.only);
    const unknown = options.only.filter(id => !items.some(item => item.id === id));
    if (unknown.length) throw new Error("Unknown backlog id(s) in --only: " + unknown.join(", "));
    items = items.filter(item => wanted.has(item.id)).map(item => ({ ...item, depends_on: item.depends_on.filter(dep => wanted.has(dep)) }));
  }
  const byId = new Map(items.map(item => [item.id, item]));
  for (const item of items) for (const dep of item.depends_on) if (!byId.has(dep)) throw new Error("Unknown dependency " + dep + " referenced by " + item.id);
  const needsDecision = items.filter(item => item.changes_behaviour);
  const sizes = new Map(items.map(item => [item.id, options.limits ? estimateSize({ files: item.old_paths }, options.limits) : undefined]));
  const splitItems = items.filter(item => !item.changes_behaviour && sizes.get(item.id)?.hint === "large");
  const needsSplit = splitItems.map(item => { const size = sizes.get(item.id)!; return { id: item.id, title: item.title, files: size.files, areas: size.areas, reasons: size.reasons, proposal: proposeSplit(item.old_paths, options.limits!) }; });
  // An item waiting for a decision and an item waiting for a split are handled alike: dependents carry it as a pending prerequisite.
  const decisionIds = new Set([...needsDecision, ...splitItems].map(item => item.id));
  const splitIds = new Set(splitItems.map(item => item.id));
  const pending = items.filter(item => !item.changes_behaviour && !splitIds.has(item.id));
  const rank = { S: 0, M: 1, L: 2 };
  const compare = (a: BacklogItem, b: BacklogItem) => rank[a.size] - rank[b.size] || a.id.localeCompare(b.id);
  const ordered: BacklogItem[] = [];
  const remaining = new Set(pending.map(item => item.id));
  while (remaining.size) {
    const ready = [...remaining].map(id => byId.get(id)!).filter(item => item.depends_on.every(dep => decisionIds.has(dep) || !remaining.has(dep))).sort(compare);
    if (!ready.length) throw new Error("Dependency cycle among backlog ids: " + [...remaining].sort().join(", "));
    for (const item of ready) { ordered.push(item); remaining.delete(item.id); }
  }
  const routed = ordered.map(item => options.areas?.[item.id] ? { ...item, ...options.areas[item.id]! } : item.area === "general" && !item.critical ? { ...item, ...inferArea(item.old_paths) } : item);
  type Planned = BacklogItem & { members: string[] };
  const planned: Planned[] = [];
  for (const item of routed) {
    const previous = planned[planned.length - 1];
    const small = (member: BacklogItem) => sizes.get(member.id)?.hint === "small" && !member.critical;
    if (options.mergeSmall && previous && previous.members.length === 1 && small(previous) && small(item) && previous.area === item.area && !item.depends_on.includes(previous.id) && !previous.depends_on.includes(item.id)) {
      previous.members.push(item.id);
      Object.assign(previous, { id: previous.id + "+" + item.id, title: previous.title + " + " + item.title, old_paths: [...previous.old_paths, ...item.old_paths], target: previous.target + "; " + item.target, tests: [...previous.tests, ...item.tests], depends_on: [...new Set([...previous.depends_on, ...item.depends_on])] });
    } else planned.push({ ...item, members: [item.id] });
  }
  const mergedId = new Map(planned.flatMap(item => item.members.map(member => [member, item.id] as const)));
  const criteria = ["1. The stated goal is implemented at the target.", "2. Existing behaviour is covered by tests and remains equal.", "3. Migration records and required documentation are updated.", "4. npm run verify passes."].join("\n");
  const acceptance = (item: Planned) => (item.members.length > 1 ? item.members.map(member => "Acceptance criteria for " + member + ":\n" + criteria) : ["Acceptance criteria:\n" + criteria]).join("\n");
  const tasks = planned.map(item => {
    const own = new Set(item.members);
    const deps = [...new Set(item.depends_on.map(dep => mergedId.get(dep) ?? dep))].filter(dep => !own.has(dep));
    const inChain = deps.filter(dep => !decisionIds.has(dep));
    const pendingDeps = deps.filter(dep => decisionIds.has(dep));
    const files = item.old_paths.map(file => "- " + (options.reference ? "reference repository: " : "") + file).join("\n") || "- none listed";
    const characterize = options.characterize ? "CHARACTERIZE FIRST (B-110): before porting, write docs/characterization/" + item.id.toLowerCase() + ".json from the OLD files (format and rules: docs/characterization/README.md; legacy file:line sources, basis static or observed), list each case under ## Cases of its page document and cite it in a test; npm run check:parity must pass." : "";
    const design = options.designs?.[item.area];
    const critical = item.critical ? (design ? "CRITICAL AREA: build inside the approved design " + design + "; its protected constraints are binding and the task is refused at admission without it." : "CRITICAL AREA: no approved design exists for area " + item.area + " yet; this task cannot start until docs/design/" + item.area + ".md is approved and merged (B-159).") : "This is not marked as a critical area.";
    const hint = sizes.get(item.members[0]!)?.hint;
    const lane = hint && hint !== "normal" ? ["Lane: " + laneFor(hint)] : [];
    const prompt = ["Area: " + item.area, ...lane, ...(item.critical ? ["Critical: yes", ...(design ? ["Design: " + design] : [])] : []), "Goal: " + item.title, "Title: " + item.title, "Kind: " + item.kind + "; size: " + item.size + "; area: " + item.area + ".", critical, "OLD files to read:" , files, "Target: " + item.target, characterize, "Tests that must prove equal behaviour: " + (item.tests.join("; ") || "add or update tests that demonstrate the existing behaviour is preserved"), "Dependencies already in this chain: " + (inChain.join(", ") || "none"), pendingDeps.length ? "Dependencies pending a decision: " + pendingDeps.join(", ") + ". Continue this task while recording that prerequisite as pending." : "", "Port behaviour, not code. Restructure the implementation and extract logic to hooks or utils where appropriate. Follow AGENTS.md and keep npm run verify green. Record changes that would alter architecture or visible behaviour in docs/migration/findings.md and unfinished work in docs/migration/todo.md. Add a row per ported file to docs/migration/map.md. Page folders get docs/pages/<page>.md with case ids cited by tests. Support Chrome 53: do not use CSS max(), min(), or clamp(); use rem tokens.", acceptance(item)].filter(Boolean).join("\n");
    if (prompt.length >= 3500) throw new Error("Prompt for " + item.id + " exceeds 3500 characters");
    return { taskId: options.prefix + "-" + item.id, title: item.title, prompt };
  });
  const needsDesign = [...new Set(planned.filter(item => item.critical && !options.designs?.[item.area]).map(item => item.area))].sort();
  const groups = new Map<string, BacklogItem[]>();
  for (const item of planned) groups.set(item.area, [...(groups.get(item.area) ?? []), item]);
  const plan = ["# Survey task plan", ...[...groups].map(([area, group]) => "## " + area + "\n" + group.map(item => "- " + options.prefix + "-" + item.id + " — " + item.title + " (" + item.size + ")").join("\n")), "## Needs a decision", needsDecision.length ? needsDecision.map(item => "- " + item.id + " — " + item.title + " (" + item.area + ", " + item.size + ")").join("\n") : "- none", ...(needsSplit.length ? ["## Needs a split (too large for the tier)\n" + needsSplit.map(item => "- " + item.id + " — " + item.title + " (" + item.files + " files, " + item.areas + " areas): " + item.proposal.map(part => part.title + " [" + part.files.length + "]").join("; ")).join("\n")] : [])].join("\n\n");
  return { spec: { projectId: options.projectId, tasks }, plan, needsDecision, needsDesign, needsSplit };
}
