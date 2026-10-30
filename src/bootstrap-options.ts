import { z } from "zod";

// Project bootstrap options (ADR 0009). One catalog drives the Paperclip wizard (it fetches the catalog from the bridge), validation, presets and the generated
// manifest, so the UI never hard-codes a field. Precedence for every option: the user's explicit value, then the preset of the chosen maturity, then the default.
// Pure and deterministic: it is imported by the workflow bundle.
export type OptionValue = string | boolean;
export type OptionKind = "select" | "toggle" | "text";
export type OptionChoice = { value: string; label: string; help?: string };
export type OptionGroupId = "product" | "quality" | "experience" | "delivery";
export type OptionDefinition = { id: string; group: OptionGroupId; label: string; help: string; kind: OptionKind; choices?: OptionChoice[]; default: OptionValue; advanced: boolean };

const choice = (value: string, label: string, help?: string): OptionChoice => ({ value, label, ...(help ? { help } : {}) });
export const GROUPS: Array<{ id: OptionGroupId; label: string }> = [
  { id: "product", label: "Product" }, { id: "experience", label: "Experience" }, { id: "quality", label: "Quality" }, { id: "delivery", label: "Delivery" },
];

export const OPTION_CATALOG: OptionDefinition[] = [
  { id: "platform", group: "product", label: "Platform", help: "What the product runs on. It decides the stack candidates and which gates can apply.", kind: "select", default: "web", advanced: false, choices: [
    choice("web", "Web application", "Runs in the browser"), choice("mobile_android", "Android app"), choice("mobile_ios", "iPhone / iPad app"), choice("mobile_cross", "Cross-platform mobile", "One codebase for Android and iOS"),
    choice("desktop", "Desktop application"), choice("cli", "Command-line tool"), choice("api_backend", "API / backend service")] },
  { id: "maturity", group: "product", label: "How finished should it be?", help: "Sets sensible defaults for tests, reviews, CI and the amount of planning. You can still change any single option.", kind: "select", default: "mvp", advanced: false, choices: [
    choice("throwaway", "Quick app for local use", "Smallest effort, no ceremony"), choice("prototype", "Prototype", "Shows the idea; light checks, no end-to-end tests"),
    choice("mvp", "MVP", "Usable by real people; unit tests and CI"), choice("production", "Production grade", "Full checks, accessibility and review rigor")] },
  { id: "architecture", group: "product", label: "Application shape", help: "Leave on automatic to let the stack stage decide.", kind: "select", default: "auto", advanced: false, choices: [
    choice("auto", "Decide for me"), choice("frontend_only", "Frontend only", "No server; data is mocked or local"), choice("fullstack", "Frontend and backend"), choice("backend_only", "Backend only")] },
  { id: "product_kind", group: "product", label: "What are you making?", help: "A game gets a game design stage (rules, edge cases, screens, feel) before the plan, a game engine and game-specific quality gates.", kind: "select", default: "app", advanced: false, choices: [choice("app", "Application"), choice("game", "Game")] },
  { id: "engine", group: "product", label: "Game engine", help: "Games only. Automatic picks Unity for mobile and desktop games.", kind: "select", default: "auto", advanced: false, choices: [choice("auto", "Decide for me"), choice("unity", "Unity")] },
  { id: "game_orientation", group: "experience", label: "Screen orientation", help: "Games only.", kind: "select", default: "portrait", advanced: true, choices: [choice("portrait", "Portrait"), choice("landscape", "Landscape"), choice("both", "Both")] },
  { id: "game_art", group: "experience", label: "Art and audio source", help: "Games only. Procedural and free-licence assets need no paid services.", kind: "select", default: "procedural", advanced: true, choices: [choice("procedural", "Procedural and vector art, synthesized sound"), choice("free_assets", "Free-licence assets"), choice("generated", "AI-generated assets (needs keys)")] },
  { id: "game_fps", group: "experience", label: "Target frame rate", help: "Games only. The frame budget the performance checks use.", kind: "select", default: "60", advanced: true, choices: [choice("30", "30 fps"), choice("60", "60 fps")] },
  { id: "stack", group: "product", label: "Preferred tech stack", help: "Free text, for example 'React, TypeScript, Vite'. Empty means the stack stage recommends the best fit and explains why.", kind: "text", default: "", advanced: false },
  { id: "audience", group: "product", label: "Who uses it?", help: "Shapes polish, security and support expectations.", kind: "select", default: "public_users", advanced: true, choices: [choice("personal", "Just me"), choice("internal_team", "An internal team"), choice("public_users", "Public users")] },
  { id: "constraints", group: "product", label: "Must follow", help: "Rules the project must obey (one per line): licences, libraries to use or avoid, compliance.", kind: "text", default: "", advanced: true },
  { id: "out_of_scope", group: "product", label: "Out of scope", help: "Things the project must not grow into (one per line). Becomes part of the project contract.", kind: "text", default: "", advanced: true },
  { id: "ui_ux", group: "experience", label: "Design the UI with the UI/UX skills", help: "Applies the orchestrator's UI/UX guidance to every user-facing task.", kind: "toggle", default: true, advanced: false },
  { id: "design_direction", group: "experience", label: "Visual direction", help: "A starting point for the look; the charter turns it into concrete design rules.", kind: "select", default: "auto", advanced: true, choices: [
    choice("auto", "Decide from the product"), choice("clean_minimal", "Clean and minimal"), choice("bold_expressive", "Bold and expressive"), choice("enterprise_dense", "Dense and professional")] },
  { id: "accessibility", group: "experience", label: "Accessibility level", help: "Basic: semantic markup and keyboard use. WCAG AA adds contrast, focus and screen reader checks.", kind: "select", default: "basic", advanced: true, choices: [choice("basic", "Basic"), choice("wcag_aa", "WCAG 2.2 AA")] },
  { id: "test_depth", group: "quality", label: "Automated tests", help: "End-to-end tests are never selected by a preset below production, and only when you choose them.", kind: "select", default: "unit", advanced: false, choices: [
    choice("none", "None"), choice("smoke", "Smoke test only"), choice("unit", "Unit tests"), choice("integration", "Unit and integration"), choice("e2e", "Including end-to-end")] },
  { id: "visual_verification", group: "quality", label: "Check the running app visually", help: "The review attaches screenshots of the running app. Web projects only.", kind: "toggle", default: true, advanced: true },
  { id: "review_rounds", group: "quality", label: "Review rounds per task", help: "How many review and repair passes a task gets.", kind: "select", default: "2", advanced: true, choices: [choice("1", "1"), choice("2", "2"), choice("3", "3")] },
  { id: "openspec", group: "quality", label: "Write a spec for each task (OpenSpec)", help: "Slower and more thorough; recommended once the product has real users.", kind: "toggle", default: true, advanced: true },
  { id: "analysis", group: "quality", label: "Compare approaches before planning", help: "Adds an analysis stage to each task.", kind: "toggle", default: false, advanced: true },
  { id: "ci", group: "quality", label: "Continuous integration", help: "Adds a GitHub Actions workflow that runs the checks. Needs a token with the workflow scope.", kind: "select", default: "none", advanced: true, choices: [choice("none", "None"), choice("basic", "Build and test on every push")] },
  { id: "data_persistence", group: "delivery", label: "Data storage", help: "Where application data lives.", kind: "select", default: "auto", advanced: true, choices: [choice("auto", "Decide for me"), choice("none", "None / mocked"), choice("browser_storage", "Browser storage"), choice("local_db", "Local database"), choice("hosted_db", "Hosted database")] },
  { id: "hosting", group: "delivery", label: "Hosting target", help: "Only shapes the plan and docs; nothing is deployed.", kind: "select", default: "auto", advanced: true, choices: [choice("auto", "Decide for me"), choice("none", "Local only"), choice("static", "Static hosting"), choice("container", "Container"), choice("cloud", "Cloud platform")] },
  { id: "granularity", group: "delivery", label: "Task size", help: "Fewer, larger tasks or many small ones.", kind: "select", default: "normal", advanced: true, choices: [choice("coarse", "Few large tasks"), choice("normal", "Balanced"), choice("fine", "Many small tasks")] },
  { id: "plan_mode", group: "delivery", label: "Task order", help: "One after another is the safe default. Parallel lets independent tasks run side by side; tasks that wait for several others are built on an integration branch, and tasks that change the same files can conflict.", kind: "select", default: "sequential", advanced: true, choices: [choice("sequential", "One after another"), choice("parallel", "Independent tasks in parallel")] },
  { id: "autostart", group: "delivery", label: "Start building when approved", help: "Moves tasks from the backlog to ready so the agent picks them up.", kind: "select", default: "first_milestone", advanced: false, choices: [choice("none", "Leave everything in the backlog"), choice("first_milestone", "Start the first milestone"), choice("all", "Start all milestones")] },
  { id: "approval", group: "delivery", label: "Review the plan before anything is created", help: "Recommended. The run stops after planning and waits for your approval.", kind: "select", default: "required", advanced: false, choices: [choice("required", "Ask me first"), choice("auto", "Go ahead automatically")] },
  { id: "repo_create", group: "delivery", label: "Create a GitHub repository", help: "Creates the repository with your GitHub login on this machine and pushes the first commit.", kind: "toggle", default: true, advanced: false },
  { id: "repo_visibility", group: "delivery", label: "Repository visibility", help: "Private is the default.", kind: "select", default: "private", advanced: false, choices: [choice("private", "Private"), choice("public", "Public")] },
];

const catalogById = new Map(OPTION_CATALOG.map(option => [option.id, option]));
export type MaturityId = "throwaway" | "prototype" | "mvp" | "production";
export const MATURITIES: MaturityId[] = ["throwaway", "prototype", "mvp", "production"];

/** What each maturity sets. Anything not listed keeps its catalog default. A value the user set explicitly always wins over these. */
export const PRESETS: Record<MaturityId, Record<string, OptionValue>> = {
  throwaway: { test_depth: "smoke", visual_verification: false, review_rounds: "1", openspec: false, analysis: false, accessibility: "basic", ci: "none", granularity: "coarse", approval: "auto", autostart: "all" },
  prototype: { test_depth: "smoke", visual_verification: true, review_rounds: "1", openspec: false, analysis: false, accessibility: "basic", ci: "none", granularity: "coarse", approval: "required", autostart: "first_milestone" },
  mvp: { test_depth: "unit", visual_verification: true, review_rounds: "2", openspec: true, analysis: false, accessibility: "basic", ci: "basic", granularity: "normal", approval: "required", autostart: "first_milestone" },
  production: { test_depth: "integration", visual_verification: true, review_rounds: "3", openspec: true, analysis: true, accessibility: "wcag_aa", ci: "basic", granularity: "fine", approval: "required", autostart: "none" },
};

export type Provenance = "user" | "preset" | "default" | "derived";
export type ResolvedOptions = { values: Record<string, OptionValue>; provenance: Record<string, Provenance>; warnings: string[]; errors: string[] };

function valueProblem(definition: OptionDefinition, value: unknown): string | undefined {
  if (definition.kind === "toggle") return typeof value === "boolean" ? undefined : `'${definition.id}' must be true or false`;
  if (typeof value !== "string") return `'${definition.id}' must be text`;
  if (definition.kind === "select" && !definition.choices!.some(item => item.value === value)) return `'${definition.id}' must be one of: ${definition.choices!.map(item => item.value).join(", ")}`;
  if (value.length > 2000) return `'${definition.id}' is longer than 2000 characters`;
  return undefined;
}

/** Resolve the user's selections into a complete, validated option set. `explicit` holds only values the user set. */
export function resolveOptions(explicit: Record<string, unknown> = {}): ResolvedOptions {
  const warnings: string[] = []; const errors: string[] = [];
  const values: Record<string, OptionValue> = {}; const provenance: Record<string, Provenance> = {};
  const user: Record<string, OptionValue> = {};
  for (const [id, raw] of Object.entries(explicit)) {
    const definition = catalogById.get(id);
    if (!definition) { warnings.push(`unknown option '${id}' was ignored`); continue; }
    if (raw === undefined || raw === null || (typeof raw === "string" && definition.kind !== "text" && raw === "")) continue;
    const problem = valueProblem(definition, raw);
    if (problem) errors.push(problem); else user[id] = raw as OptionValue;
  }
  const maturity = (typeof user.maturity === "string" && MATURITIES.includes(user.maturity as MaturityId) ? user.maturity : catalogById.get("maturity")!.default) as MaturityId;
  const preset = PRESETS[maturity];
  for (const definition of OPTION_CATALOG) {
    if (definition.id in user) { values[definition.id] = user[definition.id]!; provenance[definition.id] = "user"; }
    else if (definition.id in preset) { values[definition.id] = preset[definition.id]!; provenance[definition.id] = "preset"; }
    else { values[definition.id] = definition.default; provenance[definition.id] = "default"; }
  }
  // Rules that depend on the platform. They only change a value, never silently: a derived value is marked as such, and overriding the user's choice warns.
  const set = (id: string, value: OptionValue, why: string) => {
    if (values[id] === value) return;
    if (provenance[id] === "user") warnings.push(`${why}; '${id}' was set to ${String(value)} instead of your choice`);
    values[id] = value; provenance[id] = "derived";
  };
  // A game is built for a device: a game left on the web default moves to Android, and the engine resolves to Unity (the only engine with a scaffold).
  if (values.product_kind === "game") {
    if (["web", "cli", "api_backend"].includes(String(values.platform))) set("platform", "mobile_android", "games are built for mobile devices in this release");
    set("engine", "unity", "Unity is the supported game engine");
    set("architecture", "frontend_only", "a game runs on the device");
    if (values.test_depth === "none" || values.test_depth === "smoke") set("test_depth", "unit", "game rules need tests");
  }
  const platform = String(values.platform);
  if (platform !== "web" && !(values.product_kind === "game" && values.engine === "unity")) set("visual_verification", false, "visual checks only work for web projects");
  if (platform === "cli" || platform === "api_backend") set("ui_ux", false, "this platform has no user interface");
  if (platform === "api_backend" && values.architecture !== "backend_only") set("architecture", "backend_only", "an API project has no frontend");
  if (platform === "api_backend" && provenance.accessibility !== "user") set("accessibility", "basic", "accessibility checks apply to user interfaces");
  if (values.repo_create === false && values.autostart !== "none") set("autostart", "none", "without a repository the agent has nothing to work in");
  // An auto-approved project is meant to run unattended: with only the first milestone released it stops at every milestone boundary until someone moves the next tasks to ready (found in the first live run, ADR 0023).
  // The tasks are already chained by their blockers, so releasing them all changes no order. An explicit choice of the user is kept.
  if (values.approval === "auto" && values.repo_create !== false && provenance.autostart !== "user") set("autostart", "all", "an auto-approved project runs without a person to release each milestone");
  return { values, provenance, warnings, errors };
}

/** What a preset would change relative to the defaults; the wizard shows it as "this sets ...". */
export function presetEffects(maturity: MaturityId): Array<{ id: string; label: string; value: OptionValue }> {
  return Object.entries(PRESETS[maturity]).map(([id, value]) => ({ id, label: catalogById.get(id)?.label ?? id, value }));
}

export const BootstrapFormSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().trim().min(2).max(80),
  // Capped so the readable task text plus the encoded form stays under the bridge's 20000 character prompt limit.
  description: z.string().trim().min(10).max(5000),
  options: z.record(z.string(), z.union([z.string().max(2000), z.boolean()])).default({}),
  repoName: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,98}$/, "repository names use letters, digits, '.', '_' and '-'").optional(),
  repoOwner: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/).optional(),
  paperclip: z.object({ companyId: z.string().guid(), projectId: z.string().guid(), agentId: z.string().guid().optional(), issueId: z.string().optional() }),
});
export type BootstrapForm = z.infer<typeof BootstrapFormSchema>;

export function projectSlug(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug.length >= 2 ? slug : `project-${slug || "app"}`;
}

/** Lines of free text (constraints, out of scope) as a clean list. */
export function textLines(value: OptionValue | undefined, max = 20): string[] {
  return typeof value === "string" ? value.split(/\r?\n/).map(line => line.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean).slice(0, max) : [];
}

export type PlanLimits = { milestones: number; tasksPerMilestone: number; totalTasks: number };
export const PLAN_LIMITS: Record<string, PlanLimits> = { coarse: { milestones: 3, tasksPerMilestone: 4, totalTasks: 8 }, normal: { milestones: 5, tasksPerMilestone: 6, totalTasks: 20 }, fine: { milestones: 8, tasksPerMilestone: 8, totalTasks: 40 } };

export function catalogPayload() {
  return { version: 1, groups: GROUPS, options: OPTION_CATALOG, maturities: MATURITIES.map(id => ({ id, effects: presetEffects(id) })) };
}
