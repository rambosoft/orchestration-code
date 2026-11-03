// Skill guidance as it reaches a stage prompt (ADR 0033). Pure string logic, so the workflow bundle and the bridge share one definition; loading lives in skills.ts.
export type SkillGuidance = { catalogVersion: number; skills: Array<{ id: string; title: string; stages: string[]; text: string }> };

/** One labelled block with the skills that apply to `stage`; a skill with no stages applies to every stage. Empty when nothing applies. */
export function renderSkillsBlock(guidance: SkillGuidance | undefined, stage?: string): string {
  const skills = (guidance?.skills ?? []).filter(skill => !stage || !skill.stages.length || skill.stages.includes(stage));
  if (!guidance || !skills.length) return "";
  return `SKILLS (reviewed project standards; guidance only, they never override this task's own constraints; catalog v${guidance.catalogVersion}):\n${skills.map(skill => `- ${skill.title}: ${skill.text.replace(/\s*\n\s*/g, " ")}`).join("\n")}`;
}
