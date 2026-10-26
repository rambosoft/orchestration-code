import { describe, expect, it } from "vitest";
import { buildIssuePlan, buildManifest, charterPrompt, blueprintPrompt, deterministicCharter, deterministicStack, planLimits, uiUxSkillsFor, validateBlueprint, validateCharter, DEFAULT_BOOTSTRAP_CONFIG, type BootstrapRunInput } from "../src/bootstrap.js";
import { PLAN_LIMITS, resolveOptions } from "../src/bootstrap-options.js";
import { designBar, designTaskBlock, hasUserInterface, renderDesignDirection } from "../src/design-direction.js";
import { renderDocs } from "../src/bootstrap-docs.js";
import { buildPluginConfig, configurePlugin, findBridgeSecret, SECRET_KEY, type Call } from "../src/plugin-setup.js";

const run = (explicit: Record<string, unknown> = {}): BootstrapRunInput => {
  const resolved = resolveOptions(explicit);
  return { form: { version: 1, name: "Aurora Store", description: "An online store for lamps with search and checkout.", options: {}, paperclip: { companyId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222" } }, options: resolved.values, provenance: resolved.provenance };
};
const task = (key: string) => ({ key, title: `Task ${key}`, description: "Build it.", type: "task", acceptance: ["It works"], depends_on: [] });
const blueprint = () => validateBlueprint(JSON.stringify({ summary: "s", milestones: [{ key: "M1", title: "m", goal: "g", tasks: [task("T1"), task("T2")] }] }), PLAN_LIMITS.normal!);

describe("design direction", () => {
  it("raises the visual bar with the maturity but never drops below a designed look", () => {
    const prototype = designBar(run({ maturity: "prototype" }).options).join(" ");
    const mvp = designBar(run({ maturity: "mvp" }).options).join(" ");
    const production = designBar(run({ maturity: "production" }).options).join(" ");
    for (const bar of [prototype, mvp, production]) expect(bar).toContain("default browser or component-library styling");
    expect(prototype).not.toContain("component set");
    expect(mvp).toContain("reusable component set");
    expect(production).toContain("documented design system");
    expect(production).toContain("WCAG 2.2 AA");
  });
  it("applies to user interfaces only", () => {
    expect(hasUserInterface(run({ platform: "web" }).options)).toBe(true);
    expect(designBar(run({ platform: "api_backend" }).options)).toEqual([]);
    expect(designBar(run({ platform: "web", ui_ux: false }).options)).toEqual([]);
    expect(renderDesignDirection(run({ platform: "cli" }).options, deterministicCharter(run({ platform: "cli" })))).toBeNull();
  });
  it("is part of the charter, blueprint and task prompts and the fallback charter", () => {
    const input = run({ maturity: "mvp" });
    const stack = deterministicStack(input);
    const charter = deterministicCharter(input);
    expect(charter.design_rules.length).toBeGreaterThan(3);
    expect(charterPrompt(input, stack)).toContain("page_directions");
    expect(charterPrompt(input, stack)).toContain("Answer shape: follow the numbered steps");
    expect(charterPrompt(input, stack)).toContain("UI/UX DIRECTION");
    expect(blueprintPrompt(input, stack, charter, planLimits("normal"), true)).toContain("whole-product visual polish");
    expect(charterPrompt(run({ platform: "api_backend" }), stack)).not.toContain("UI/UX DIRECTION");
  });
  it("reads page directions from the model and tolerates their absence", () => {
    const charter = validateCharter(JSON.stringify({ vision: "v", goals: ["g"], design_system: ["Palette: ink #111, amber #f5a524"], page_directions: [{ page: "Home", direction: "Full-bleed hero with a lamp photo" }, "junk"] }));
    expect(charter.page_directions).toEqual([{ page: "Home", direction: "Full-bleed hero with a lamp photo" }]);
    expect(validateCharter(JSON.stringify({ vision: "v", goals: ["g"] })).page_directions).toEqual([]);
  });
  it("puts the direction on every building task and a whole-product review on the last one, but not on read-only tasks or projects without a UI", () => {
    const input = run({ maturity: "production" });
    const charter = { ...deterministicCharter(input), page_directions: [{ page: "Home", direction: "Hero with product photo" }] };
    const plan = buildIssuePlan(blueprint(), input.options, true, charter).filter(issue => issue.kind === "task");
    for (const issue of plan) { expect(issue.description).toContain("UI/UX direction"); expect(issue.description).toContain("Home: Hero with product photo"); expect(issue.description).toContain("docs/PROJECT_CONTRACT.md"); }
    expect(plan[0]!.description).not.toContain("last task");
    expect(plan[1]!.description).toContain("This is the last task");
    const research = validateBlueprint(JSON.stringify({ summary: "s", milestones: [{ key: "M1", title: "m", goal: "g", tasks: [{ ...task("T1"), type: "research" }] }] }), PLAN_LIMITS.normal!);
    expect(buildIssuePlan(research, input.options, true, charter).find(issue => issue.kind === "task")!.description).not.toContain("UI/UX direction");
    expect(buildIssuePlan(blueprint(), run({ platform: "api_backend" }).options, true).every(issue => !issue.description.includes("UI/UX direction"))).toBe(true);
    expect(designTaskBlock(input.options, charter, false).length).toBeLessThan(3000);
  });
  it("writes docs/DESIGN_DIRECTION.md and points the agent guide at it, only for user interfaces", () => {
    const docs = (options: BootstrapRunInput) => renderDocs({ form: options.form, options: options.options, provenance: options.provenance, stack: deterministicStack(options), charter: deterministicCharter(options), blueprint: blueprint() });
    const files = docs(run({ maturity: "mvp" }));
    expect(files["docs/DESIGN_DIRECTION.md"]).toContain("Visual bar");
    expect(files["CLAUDE.md"]).toContain("docs/DESIGN_DIRECTION.md");
    expect(files["README.md"]).toContain("Design direction");
    const backend = docs(run({ platform: "api_backend" }));
    expect(backend["docs/DESIGN_DIRECTION.md"]).toBeUndefined();
    expect(backend["CLAUDE.md"]).not.toContain("DESIGN_DIRECTION");
  });
  it("makes the generated manifest apply the UI/UX skills to every task, whatever its wording", () => {
    expect(uiUxSkillsFor(run({ platform: "web" }).options)).toEqual(["ui-ux-pro-max", "frontend-design"]);
    expect(uiUxSkillsFor(run({ platform: "mobile_cross" }).options)).toContain("vercel-react-native-skills");
    expect(uiUxSkillsFor(run({ platform: "cli" }).options)).toEqual([]);
    const input = run({ platform: "web" });
    const manifest = buildManifest({ projectId: "aurora", form: input.form, options: input.options, hasRepository: true, config: DEFAULT_BOOTSTRAP_CONFIG }) as { uiUx: { include: string[] } };
    expect(manifest.uiUx.include).toContain("ui-ux-pro-max");
  });
});

describe("plugin setup", () => {
  const fake = (state: { secrets: Array<{ id: string; key?: string }>; config?: Record<string, unknown>; companies?: Array<{ id: string; name: string }> }) => {
    const calls: Array<{ method: string; route: string; body?: unknown }> = [];
    const call: Call = async <T,>(method: "GET" | "POST", route: string, body?: unknown) => {
      calls.push({ method, route, body });
      if (route === "/api/companies") return (state.companies ?? [{ id: "c1", name: "Acme" }]) as T;
      if (route.endsWith("/secrets") && method === "GET") return state.secrets as T;
      if (route.endsWith("/secrets")) { const created = { id: "s-new", key: SECRET_KEY }; state.secrets.push(created); return created as T; }
      if (route.includes("/config?")) return { configJson: state.config } as T;
      return {} as T;
    };
    return { call, calls };
  };
  it("creates the secret once and saves a secret reference, never the token itself", async () => {
    const { call, calls } = fake({ secrets: [] });
    const result = await configurePlugin(call, { token: "tok-123" });
    expect(result).toMatchObject({ companyId: "c1", secretCreated: true, bridgeUrl: "http://orchestrator:3101" });
    const saved = calls.find(item => item.route === "/api/plugins/orchestrator.project-bootstrap/config" && item.method === "POST")!;
    expect(saved.body).toEqual({ companyId: "c1", configJson: { bridgeUrl: "http://orchestrator:3101", bridgeToken: { type: "secret_ref", secretId: "s-new", version: "latest" } } });
    expect(JSON.stringify(saved.body)).not.toContain("tok-123");
  });
  it("reuses an existing secret and keeps a custom bridge URL", async () => {
    const { call, calls } = fake({ secrets: [{ id: "s-old", key: SECRET_KEY }], config: { bridgeUrl: "http://bridge:9" } });
    const result = await configurePlugin(call, { token: "t" });
    expect(result).toMatchObject({ secretCreated: false, bridgeUrl: "http://bridge:9" });
    expect(calls.some(item => item.method === "POST" && item.route.endsWith("/secrets"))).toBe(false);
    expect(findBridgeSecret([{ id: "x", name: SECRET_KEY }])?.id).toBe("x");
    expect(buildPluginConfig({ bridgeUrl: "http://a" }, "s", "http://b").bridgeUrl).toBe("http://b");
  });
  it("asks which company when there are several", async () => {
    const { call } = fake({ secrets: [], companies: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    await expect(configurePlugin(call, { token: "t" })).rejects.toThrow("--company");
    await expect(configurePlugin(call, { token: "t", companyId: "zzz" })).rejects.toThrow("was not found");
    await expect(configurePlugin(call, { token: "t", companyId: "b" })).resolves.toMatchObject({ companyId: "b" });
  });
});
