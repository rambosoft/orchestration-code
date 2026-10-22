import type { UiUxConfig, UiUxSkillId } from "./contracts.js";

export const DEFAULT_UI_UX_CONFIG: UiUxConfig = {
  enabled: true,
  autoSelect: true,
  include: [],
  exclude: [],
};

type SkillDefinition = {
  id: UiUxSkillId;
  name: string;
  catalogVersion: string;
  upstreamVersion: string;
  license: string;
  source: string;
  frameworks: string[];
  stages: Array<"plan" | "implement" | "review">;
  guidance: string;
};

// These are independently written, compact orchestration guides. Source links
// are retained for attribution and deliberate review; no upstream skill files
// or executable assets are vendored here.
export const UI_UX_SKILLS: SkillDefinition[] = [
  {
    id: "ui-ux-pro-max",
    name: "UI UX Pro Max design intelligence (curated prompt guidance)",
    catalogVersion: "1.0.0",
    upstreamVersion: "v2.0 reference; no upstream assets bundled",
    license: "MIT (source project); curated summary maintained here",
    source: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
    frameworks: ["*"],
    stages: ["plan", "implement", "review"],
    guidance: "Establish the product, audience, primary task, and existing design language before choosing a visual direction. Make a coherent, product-specific set of decisions for layout, hierarchy, color roles, typography, spacing, and interaction states. Reuse the project's existing tokens and components; do not create a parallel design system or add decorative effects without a product reason. Check responsive reflow, contrast, keyboard focus, touch targets, reduced motion, loading, empty, and error states. This integration supplies curated prompt guidance; it does not run the upstream searchable design database or claim to generate its full design-system report.",
  },
  {
    id: "frontend-design",
    name: "Distinctive frontend design (independent guidance; Anthropic reference)",
    catalogVersion: "1.0.0",
    upstreamVersion: "not published; reference only",
    license: "Anthropic skill terms require separate review; full text not redistributed",
    source: "https://github.com/anthropics/skills/tree/main/skills/frontend-design",
    frameworks: ["web", "react", "vue", "angular", "svelte"],
    stages: ["plan", "implement", "review"],
    guidance: "Choose visual details from the product's real subject matter and audience. Before coding, state a concise direction covering palette, type roles, layout, and one memorable element; check that the choices are specific to this product rather than a generic template. Treat copy and visual structure as part of usability. Use motion sparingly, respect reduced-motion preferences, and critique the rendered result when screenshots or a preview are available. This is original summary guidance, not a copy of the referenced skill.",
  },
  {
    id: "vercel-composition-patterns",
    name: "React composition patterns",
    catalogVersion: "1.0.0",
    upstreamVersion: "1.0.0 reference; no upstream assets bundled",
    license: "MIT (source project); curated summary maintained here",
    source: "https://github.com/vercel-labs/agent-skills/tree/main/skills/composition-patterns",
    frameworks: ["react", "react-native"],
    stages: ["plan", "implement", "review"],
    guidance: "When designing or changing reusable React components, avoid growing boolean-prop combinations. Prefer explicit variants, composition through children, and compound components where related pieces share state. Keep state-management details behind a clear provider interface. Apply React-version-specific APIs only when the installed React version supports them; preserve the project's established component conventions when they are appropriate.",
  },
  {
    id: "vercel-react-native-skills",
    name: "React Native and Expo UI/performance practices",
    catalogVersion: "1.0.0",
    upstreamVersion: "1.0.0 reference; no upstream assets bundled",
    license: "MIT (source project); curated summary maintained here",
    source: "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-native-skills",
    frameworks: ["react-native"],
    stages: ["plan", "implement", "review"],
    guidance: "For React Native or Expo UI work, preserve native platform behavior and safe-area handling. Use React Native text and interaction primitives correctly, make list rendering and images suitable for their usage scale, and keep animation work on performant properties. Check touchability, loading/fallback states, platform-specific navigation, and accessibility. Do not add native dependencies unless the task and current project setup justify them.",
  },
];

const uiIntent = /\b(ui|ux|user experience|interface|frontend|front-end|screen|page|component|design|styling|visual|accessibility|responsive|layout|interaction|dashboard|form|button|navigation|mobile app|react native|expo)\b/i;

export function resolveUiUxConfig(global: UiUxConfig, project?: Partial<UiUxConfig>): UiUxConfig {
  const projectInclude = project?.include ?? [];
  const include = [...new Set([...global.include, ...projectInclude])];
  // An explicit project inclusion is a deliberate override of a global exclusion.
  const exclude = [...new Set([...(global.exclude ?? []), ...(project?.exclude ?? [])])].filter(id => !projectInclude.includes(id));
  return {
    enabled: project?.enabled ?? global.enabled,
    autoSelect: project?.autoSelect ?? global.autoSelect,
    include,
    exclude,
  };
}

export function selectUiUxSkills(input: { prompt: string; frameworks?: string[]; config?: UiUxConfig }): SkillDefinition[] {
  const config = input.config ?? DEFAULT_UI_UX_CONFIG;
  if (!config.enabled) return [];
  const frameworks = new Set((input.frameworks ?? []).map(value => value.toLowerCase()));
  const hasUiIntent = config.autoSelect && uiIntent.test(input.prompt);
  const included = new Set(config.include);
  const excluded = new Set(config.exclude);
  return UI_UX_SKILLS.filter(skill => {
    if (excluded.has(skill.id)) return false;
    if (included.has(skill.id)) return true;
    if (!hasUiIntent) return false;
    if (skill.id === "ui-ux-pro-max") return true;
    return skill.frameworks.some(framework => framework === "*" || frameworks.has(framework));
  });
}

export function uiUxGuidance(input: { prompt: string; frameworks?: string[]; config?: UiUxConfig }): string {
  const selected = selectUiUxSkills(input);
  if (!selected.length) return "";
  const stack = input.frameworks?.length ? input.frameworks.join(", ") : "not identified; inspect the project before choosing framework-specific patterns";
  return [
    "APPLICABLE UI/UX GUIDANCE (orchestrator-managed summaries)",
    `Detected project technologies: ${stack}.`,
    "Use the relevant guidance below as task-specific design and implementation constraints. Preserve explicit product requirements and the existing design system. Do not claim a visual/accessibility check was performed unless it was actually checked.",
    ...selected.map(skill => `\n${skill.name} (catalog ${skill.catalogVersion}; upstream: ${skill.upstreamVersion})\nSource: ${skill.source}\nLicense/redistribution: ${skill.license}\nApplicable stages: ${skill.stages.join(", " )}\n${skill.guidance}`),
  ].join("\n");
}

export function planningPrompt(taskPrompt: string, guidance: string): string {
  if (!guidance) return taskPrompt;
  return `${taskPrompt}\n\n${guidance}\n\nFor this UI/UX task, include a concise design and UX plan before implementation: product/audience, existing design system to preserve, key interaction states, responsive/accessibility checks, and any visual direction choices that materially affect the implementation.`;
}

export function reviewUiUxGuidance(taskPrompt: string, guidance: string): string {
  if (!guidance) return taskPrompt;
  return `${taskPrompt}\n\nUI/UX REVIEW CHECKS\nReview the changed UI against the task and existing product conventions. Check responsive behavior, keyboard focus and semantics, contrast where observable, reduced motion where relevant, interaction/loading/empty/error states, and framework-specific component correctness. Report only substantiated issues with evidence; treat visual polish as non-blocking unless it violates the request or a usability requirement.\n\n${guidance}`;
}
