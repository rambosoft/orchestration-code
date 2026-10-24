import type { OptionValue } from "./bootstrap-options.js";
import { GAME_BASE_BAR, GAME_TIER_BAR, isGame } from "./game.js";

// UI/UX direction for generated projects (ADR 0010). Every client-facing surface of a bootstrapped product gets an explicit visual bar that scales with the chosen
// maturity, so a project is never left with the stock look of its component library. Pure and deterministic: it is imported by the workflow bundle.
export type DesignTier = "prototype" | "mvp" | "production";
type Options = Record<string, OptionValue>;

export function hasUserInterface(options: Options): boolean {
  return options.ui_ux === true && options.platform !== "cli" && options.platform !== "api_backend";
}

export function designTier(options: Options): DesignTier {
  return options.maturity === "production" ? "production" : options.maturity === "mvp" ? "mvp" : "prototype";
}

const BASE_BAR = [
  "Define colour, type, spacing, radius and shadow tokens once and use only those tokens; no raw hex values or one-off pixel sizes in components.",
  "Pick a deliberate type pair (display and body) and a type scale; never ship the default browser or component-library styling anywhere.",
  "Give every page a clear hierarchy: one primary action, generous whitespace, aligned grid, consistent card, button, input and link styles.",
  "Design the loading, empty, error and success state of every screen; use real-looking content and imagery or illustration, never lorem ipsum or grey boxes.",
  "Responsive from 360px to wide desktop with no horizontal scroll; touch targets of at least 44px; visible keyboard focus.",
];
const TIER_BAR: Record<DesignTier, string[]> = {
  prototype: [
    "Prototype bar: it must still look designed and coherent end to end, with a memorable first screen, a consistent palette and tidy typography; depth can be thin, polish cannot be missing.",
  ],
  mvp: [
    "MVP bar: build a small reusable component set (buttons, inputs, cards, navigation, modal, toast, skeleton) on top of the tokens and use it on every page.",
    "Add considered micro-interactions (hover, press, focus, transitions of 150-250ms) that respect prefers-reduced-motion, form validation with inline messages, a custom 404, favicon and page titles.",
    "Text contrast meets WCAG AA; copy is written for the audience, not placeholder text.",
  ],
  production: [
    "Production bar: a documented design system (tokens, components, usage notes) in the repository, and a page-by-page design review before each task is finished.",
    "Meet WCAG 2.2 AA with evidence: contrast, focus order and visible focus, labels, landmarks, error identification and reduced motion; check at 360, 768, 1280 and 1920px.",
    "Polished motion and feedback, optimised images (responsive sizes, lazy loading), fast first paint, branded 404 and error pages, social preview metadata, and dark mode when the audience would expect it.",
    "Capture a screenshot of each key page and fix anything that looks unfinished, misaligned or inconsistent before declaring the task done.",
  ],
};
const DIRECTION: Record<string, string> = {
  clean_minimal: "Direction: clean and minimal; restrained palette, lots of space, one accent colour, refined type.",
  bold_expressive: "Direction: bold and expressive; confident colour, large type, strong imagery and playful, purposeful motion.",
  enterprise_dense: "Direction: dense and professional; compact tables and forms, clear data hierarchy, calm neutral palette, fast scanning.",
};

/** The concrete visual bar for this project: the same for every page, scaled by maturity. Empty when the product has no user interface. */
export function designBar(options: Options): string[] {
  if (!hasUserInterface(options)) return [];
  const direction = DIRECTION[String(options.design_direction)];
  const accessibility = options.accessibility === "wcag_aa" && designTier(options) !== "production" ? ["Accessibility was set to WCAG 2.2 AA: meet it, with contrast and focus checked on every page."] : [];
  if (isGame(options)) return [...GAME_BASE_BAR, ...GAME_TIER_BAR[designTier(options)], ...accessibility, ...(direction ? [direction] : [])];
  return [...BASE_BAR, ...TIER_BAR[designTier(options)], ...accessibility, ...(direction ? [direction] : [])];
}

/** Used by the charter and blueprint prompts; empty for products without a user interface. */
export function designPromptSection(options: Options): string {
  const bar = designBar(options);
  if (!bar.length) return "";
  return `\nUI/UX DIRECTION. This product has client-facing screens and they must look professionally designed, not like a default template or a stock component library. The visual bar for this maturity (${designTier(options)}):\n${bar.map(line => `- ${line}`).join("\n")}\n`;
}

/** Charter fallback: the bar itself, so a project whose charter could not be generated still carries the design direction. */
export function deterministicDesignRules(options: Options): string[] { return designBar(options).slice(0, 8); }

type DesignCharter = { design_rules: string[]; design_system?: string[]; page_directions?: Array<{ page: string; direction: string }> };

/** The block appended to every user-interface task, and to the last task as a whole-product review. Keeps to a size the task description can carry. */
export function designTaskBlock(options: Options, charter: DesignCharter | undefined, last: boolean): string {
  const bar = designBar(options);
  if (!bar.length) return "";
  const rules = [...new Set([...(charter?.design_rules ?? []), ...(charter?.design_system ?? [])])].slice(0, 10);
  const pages = (charter?.page_directions ?? []).slice(0, 12);
  const lines = [
    "UI/UX direction (binding, see docs/DESIGN_DIRECTION.md):",
    ...bar.slice(0, 4 + (designTier(options) === "prototype" ? 1 : 3)).map(line => `- ${line}`),
    ...(rules.length ? ["Project design rules:", ...rules.map(line => `- ${line}`)] : []),
    ...(pages.length ? ["Page directions:", ...pages.map(item => `- ${item.page}: ${item.direction}`)] : []),
    "The screens this task builds or changes must look finished against this direction; say in the pull request what you checked.",
  ];
  if (last) lines.push("This is the last task: before finishing, open every page of the product and fix anything that still looks unstyled, inconsistent with the tokens, or unfinished.");
  return lines.join("\n");
}

/** docs/DESIGN_DIRECTION.md for the repository. Null when there is no user interface. */
export function renderDesignDirection(options: Options, charter: DesignCharter): string | null {
  const bar = designBar(options);
  if (!bar.length) return null;
  const list = (items: string[], empty: string) => items.length ? items.map(item => `- ${item}`).join("\n") : empty;
  return `# Design direction

Every screen a person sees is held to this document. The maturity of the product (${String(options.maturity)}) sets the bar; a screen that shows default browser or component-library styling is not finished.

## Visual bar
${bar.map(line => `- ${line}`).join("\n")}

## Project design rules
${list(charter.design_rules, "- none recorded; derive them from the vision and target users in docs/PROJECT_CONTRACT.md before building the first page")}

## Design system
${list(charter.design_system ?? [], "- tokens and components are defined by the design foundation task")}

## Pages
${list((charter.page_directions ?? []).map(item => `${item.page}: ${item.direction}`), "- the plan names the pages; give each one a direction here when it is built")}

${isGame(options) ? `## Checks before a screen task is done
- Run the PlayMode capture test and look at the screenshot of every screen the task built or changed (Logs/screenshots).
- Nothing sits outside the safe area, touch targets are at least 48dp, text is legible and not conveyed by colour alone.
- Every action has its motion, sound and haptic feedback, and reduced motion is respected.
` : `## Checks before a UI task is done
- Render the page at 360px and at desktop width and look at it.
- Loading, empty, error and success states exist and look designed.
- Keyboard focus is visible, contrast is sufficient, motion respects reduced-motion.
`}`;
}
