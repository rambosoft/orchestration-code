import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SkillGuidance } from "./skills-text.js";

export const SKILL_DIGEST_MAX_CHARS = 1400;
export const DEFAULT_SKILLS_BUDGET_CHARS = 3000;
export const CatalogSchema = z.object({ version: z.number().int().positive(), skills: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), areas: z.array(z.string()), tasks: z.array(z.string()), stages: z.array(z.string()), digest: z.string().min(1), /** The pack scripts that enforce this skill's rules (B-119); an approved skill names at least one, or says it is prose-only. */ gates: z.array(z.string()).optional(), proseOnly: z.boolean().optional(), status: z.enum(["approved", "candidate", "retired"]), source: z.object({ origin: z.string().min(1), note: z.string().optional(), plugin: z.string().optional(), version: z.string().optional(), path: z.string().optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }) })) });
export type Skill = z.infer<typeof CatalogSchema>["skills"][number] & { text: string };
export type Catalog = { version: number; skills: Skill[] };

export { STANDARDS_POINTER } from "./skills-text.js";

/** Reads skills/catalog.json under `root`. Only approved entries need a digest (bounded, read now); candidate and retired entries stay listed for review but never reach a prompt. */
export function loadCatalog(root = process.cwd()): Catalog {
  const file = path.join(root, "skills", "catalog.json");
  if (!existsSync(file)) throw new Error(`skills catalog not found: ${file}`);
  const parsed = CatalogSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const ids = new Set<string>();
  const skills: Skill[] = [];
  for (const skill of parsed.skills) {
    if (ids.has(skill.id)) throw new Error(`duplicate skill id '${skill.id}' in catalog`);
    ids.add(skill.id);
    if (skill.status !== "approved") continue;
    let text: string;
    try { text = readFileSync(path.resolve(root, skill.digest), "utf8").trim(); } catch { throw new Error(`missing digest for skill '${skill.id}': ${skill.digest}`); }
    if (text.length > SKILL_DIGEST_MAX_CHARS) throw new Error(`digest for skill '${skill.id}' exceeds ${SKILL_DIGEST_MAX_CHARS} characters`);
    skills.push({ ...skill, text });
  }
  return { version: parsed.version, skills };
}

/** Project `include` first (even when area or task do not match), then catalog entries matching the stack profile and task type; `exclude` always wins. Whole skills only; the character budget holds per stage (a skill without stages counts against every stage), so a skill for one stage never crowds out another stage's. A run without a task type is a plain `task`. */
export function selectSkills(catalog: Catalog, query: { profile?: string; taskType?: string; include?: string[]; exclude?: string[]; budgetChars?: number } = {}): Skill[] {
  const excluded = new Set(query.exclude ?? []); const include = query.include ?? []; const taskType = query.taskType ?? "task";
  const approved = catalog.skills.filter(skill => skill.status === "approved" && !excluded.has(skill.id));
  const matches = (skill: Skill) => (!query.profile || skill.areas.includes("any") || skill.areas.includes(query.profile)) && (skill.tasks.includes("any") || skill.tasks.includes(taskType));
  const ordered = [...include.flatMap(id => approved.filter(skill => skill.id === id)), ...approved.filter(skill => !include.includes(skill.id) && matches(skill))];
  const result: Skill[] = []; const budget = query.budgetChars ?? DEFAULT_SKILLS_BUDGET_CHARS;
  const totals = new Map<string, number>(); const ALL = "*";
  const used = (stage: string) => (stage === ALL ? 0 : totals.get(stage) ?? 0) + (totals.get(ALL) ?? 0);
  for (const skill of ordered) {
    const stages = skill.stages.length ? skill.stages : [ALL];
    const affected = skill.stages.length ? skill.stages : [ALL, ...totals.keys()];
    if (result.some(item => item.id === skill.id) || affected.some(stage => used(stage) + skill.text.length > budget)) continue;
    result.push(skill); for (const stage of stages) totals.set(stage, (totals.get(stage) ?? 0) + skill.text.length);
  }
  return result;
}

/** Renders the approved area standards that match a stack profile, independent of task type; no profile, no files. */
export function renderStandardsFiles(catalog: Catalog, profile?: string): Record<string, string> {
  const skills = catalog.skills.filter(skill => skill.status === "approved" && profile !== undefined && (skill.areas.includes("any") || skill.areas.includes(profile))).sort((a, b) => a.id.localeCompare(b.id));
  return Object.fromEntries(skills.map(skill => [`docs/ai/standards/${skill.id}.md`, `# ${skill.title}\n\n${skill.text}\n\nSource: ${skill.source.origin} (catalog v${catalog.version})\n`]));
}

/** The run-input form of the selection (data on existing steps, ADR 0033 point 8); undefined when nothing is selected or `ORCHESTRATOR_SKILLS=off`. */
export function skillGuidance(catalog: Catalog, skills: Skill[], environment: NodeJS.ProcessEnv = process.env): SkillGuidance | undefined {
  if (environment.ORCHESTRATOR_SKILLS === "off" || !skills.length) return undefined;
  return { catalogVersion: catalog.version, skills: skills.map(({ id, title, stages, text }) => ({ id, title, stages, text })) };
}
