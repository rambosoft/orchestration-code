// The device-tier matrix and the legacy bundle gates of the react-ts-vite pack (B-114): each gate has a seeded violation that fails and a clean project that passes.
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const pack = path.resolve("templates/react-ts-vite");
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-legacy-"));
  dirs.push(root);
  await mkdir(path.join(root, "docs/ai"), { recursive: true });
  await cp(path.join(pack, "docs/ai/device-tiers.json"), path.join(root, "docs/ai/device-tiers.json"));
  await cp(path.join(pack, "docs/ai/legacy-banned.json"), path.join(root, "docs/ai/legacy-banned.json"));
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
async function script(name: string, root: string, ...extra: string[]): Promise<{ code: number; out: string }> {
  try { const { stdout, stderr } = await run("node", [path.join(pack, "scripts", name), root, ...extra]); return { code: 0, out: stdout + stderr }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}
const config = "import react from '@vitejs/plugin-react'\nimport legacy from '@vitejs/plugin-legacy'\nexport default { plugins: [react(), legacy({ targets: ['Chrome >= 53'] })] }\n";
const tiers = async () => JSON.parse(await readFile(path.join(pack, "docs/ai/device-tiers.json"), "utf8")) as { tiers: Array<Record<string, unknown>>; budget: Record<string, number> } & Record<string, unknown>;

describe("check-device-tiers", () => {
  it("accepts the pack matrix with a configured legacy plugin", async () => {
    const result = await script("check-device-tiers.mjs", await project({ "vite.config.ts": config }));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("legacy Chrome 53");
  });
  it.each([
    ["no legacy plugin in the vite config", { "vite.config.ts": "export default { plugins: [] }\n" }, "does not use @vitejs/plugin-legacy"],
    ["a missing target", { "vite.config.ts": "import legacy from '@vitejs/plugin-legacy'\nexport default { plugins: [legacy({ targets: ['defaults'] })] }\n" }, "does not pass the legacy target 'Chrome >= 53'"],
    ["polyfills turned off", { "vite.config.ts": `${config}// polyfills: false\nexport const x = { polyfills: false }\n` }, "turns the legacy polyfills off"],
    ["no vite config", {}, "no vite.config.* found"],
  ])("fails %s", async (_name, files, expected) => {
    const result = await script("check-device-tiers.mjs", await project(files));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it.each([
    ["a shipping tier without a floor", (data: Awaited<ReturnType<typeof tiers>>) => { data.tiers.push({ id: "extra", ship: true }); }, "shipping tier 'extra' has no browserFloor"],
    ["a duplicate tier", (data: Awaited<ReturnType<typeof tiers>>) => { data.tiers.push({ id: "legacy", ship: false }); }, "duplicate tier 'legacy'"],
    ["a legacy tier without a floor", (data: Awaited<ReturnType<typeof tiers>>) => { Object.assign(data.tiers.find(tier => tier.id === "legacy")!, { browserFloor: "53" }); }, "legacy.browserFloor must be a number"],
    ["targets that do not match the floor", (data: Awaited<ReturnType<typeof tiers>>) => { Object.assign(data.tiers.find(tier => tier.id === "legacy")!, { browserFloor: 60 }); }, "must contain 'Chrome >= 60'"],
    ["no budget", (data: Awaited<ReturnType<typeof tiers>>) => { delete (data as Record<string, unknown>).budget; }, "budget.totalGrowthPercent"],
    ["no legacy tier", (data: Awaited<ReturnType<typeof tiers>>) => { data.tiers = data.tiers.filter(tier => tier.id !== "legacy"); }, "the 'legacy' tier is required"],
  ])("fails a matrix with %s", async (_name, change, expected) => {
    const data = await tiers();
    change(data);
    const root = await project({ "vite.config.ts": config, "docs/ai/device-tiers.json": JSON.stringify(data) });
    const result = await script("check-device-tiers.mjs", root);
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it("fails without the matrix file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-legacy-"));
    dirs.push(root);
    expect((await script("check-device-tiers.mjs", root)).code).toBe(1);
  });
});

describe("check-legacy-apis", () => {
  const css = (body: string) => ({ "src/components/box.css": `.box {\n${body}\n}\n` });
  it("accepts flexbox, rem, media-query aspect-ratio features, plain :focus and tagged exceptions, and ignores tests", async () => {
    const files = { ...css("  display: flex;\n  margin: 1rem;"), "src/a.css": "@media (max-aspect-ratio: 1/1) {\n  html { font-size: 2.4vw; }\n}\n:focus { outline: 1px solid; }\n.x { aspect-ratio: 1; } /* legacy-ok: padding-top fallback below */\n", "src/a.test.ts": "new IntersectionObserver(() => {});\n", "src/b.ts": "// IntersectionObserver is explained here\nexport const n = 1;\n" };
    const result = await script("check-legacy-apis.mjs", await project(files));
    expect(result.code, result.out).toBe(0);
  });
  it.each([
    ["display: grid", css("  display: grid;"), "css-grid needs Chrome 57"],
    ["flex gap", css("  gap: 1rem;"), "css-gap needs Chrome 84"],
    ["position: sticky", css("  position: sticky;"), "css-sticky needs Chrome 56"],
    ["aspect-ratio", css("  aspect-ratio: 16 / 9;"), "css-aspect-ratio needs Chrome 88"],
    ["inset", css("  inset: 0;"), "css-inset needs Chrome 87"],
    ["clamp()", css("  width: clamp(1rem, 2vw, 3rem);"), "css-math-functions needs Chrome 79"],
    [":focus-visible", { "src/a.css": "button:focus-visible { outline: 2px solid; }\n" }, "css-focus-visible needs Chrome 86"],
    [":focus-within", { "src/a.css": ".row:focus-within { opacity: 1; }\n" }, "css-focus-within needs Chrome 60"],
    ["dvh", css("  height: 100dvh;"), "css-dynamic-viewport needs Chrome 108"],
    ["IntersectionObserver", { "src/a.ts": "export const o = new IntersectionObserver(() => {});\n" }, "js-intersection-observer needs Chrome 58"],
    ["structuredClone", { "src/a.tsx": "export const c = structuredClone({});\n" }, "js-structured-clone needs Chrome 98"],
  ])("fails %s", async (_name, files, expected) => {
    const result = await script("check-legacy-apis.mjs", await project(files));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it("applies only the rules newer than the floor in the matrix, so raising the floor relaxes them", async () => {
    const data = await tiers();
    Object.assign(data.tiers.find(tier => tier.id === "legacy")!, { browserFloor: 90, vite: { plugin: "@vitejs/plugin-legacy", targets: ["Chrome >= 90"] } });
    const result = await script("check-legacy-apis.mjs", await project({ ...css("  aspect-ratio: 1;\n  display: grid;"), "docs/ai/device-tiers.json": JSON.stringify(data) }));
    expect(result.code, result.out).toBe(0);
  });
  it("fails without the rules file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-legacy-"));
    dirs.push(root);
    expect((await script("check-legacy-apis.mjs", root)).code).toBe(1);
  });
});

describe("check-legacy-syntax", () => {
  const legacy = "var a=function(){return[1,2].map(function(n){return n*2})};";
  const html = '<html><script nomodule crossorigin id="vite-legacy-polyfill" src="/assets/polyfills-legacy-x.js"></script></html>';
  const built = { "dist/index.html": html, "dist/assets/index-legacy-abc.js": legacy, "dist/assets/polyfills-legacy-xyz.js": "!function(){var x=1}();", "dist/assets/index-abc.js": "export const modern = (a) => a?.b ?? 1;" };
  it("accepts legacy chunks that parse as classic ES2015 scripts and ignores the modern chunk", async () => {
    const result = await script("check-legacy-syntax.mjs", await project(built));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("2 legacy chunk(s) parse as ES2016");
  });
  it.each([
    ["optional chaining in a legacy chunk", { "dist/assets/index-legacy-abc.js": "var a = b?.c;" }, "not valid ES2016 classic script"],
    ["an async function in a legacy chunk", { "dist/assets/index-legacy-abc.js": "async function f(){ await 1 }" }, "not valid ES2016 classic script"],
    ["an ES module in a legacy chunk", { "dist/assets/index-legacy-abc.js": "export const a = 1;" }, "not valid ES2016 classic script"],
    ["a missing nomodule entry", { "dist/index.html": "<html></html>" }, "no nomodule legacy entry"],
  ])("fails %s", async (_name, change, expected) => {
    const result = await script("check-legacy-syntax.mjs", await project({ ...built, ...change }));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it("fails when no legacy chunk was built or dist does not exist", async () => {
    const none = await script("check-legacy-syntax.mjs", await project({ "dist/index.html": html, "dist/assets/index-abc.js": "export {};" }));
    expect(none.code).toBe(1);
    expect(none.out).toContain("no legacy chunk");
    const missing = await script("check-legacy-syntax.mjs", await project({}));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("dist/ does not exist");
  });
});

describe("check-legacy-budget", () => {
  const chunk = (size: number) => "a".repeat(size);
  const dist = (total: number, largest: number) => ({ "dist/assets/index-legacy-a.js": chunk(largest), "dist/assets/polyfills-legacy-b.js": chunk(total - largest) });
  it("reports sizes without a baseline, records one with --update, then enforces it", async () => {
    const root = await project(dist(1000, 600));
    const first = await script("check-legacy-budget.mjs", root);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain("no baseline yet");
    const recorded = await script("check-legacy-budget.mjs", root, "--update");
    expect(recorded.code).toBe(0);
    expect(JSON.parse(await readFile(path.join(root, "docs/ai/legacy-budget.json"), "utf8"))).toEqual({ schemaVersion: 1, totalBytes: 1000, largestBytes: 600 });
    expect((await script("check-legacy-budget.mjs", root)).code).toBe(0);
  });
  it("fails growth over 10% total and over 5% for the largest file, and passes growth inside the limits", async () => {
    const baseline = { "docs/ai/legacy-budget.json": JSON.stringify({ schemaVersion: 1, totalBytes: 1000, largestBytes: 600 }) };
    expect((await script("check-legacy-budget.mjs", await project({ ...baseline, ...dist(1100, 630) }))).code).toBe(0);
    const total = await script("check-legacy-budget.mjs", await project({ ...baseline, ...dist(1101, 600) }));
    expect(total.code).toBe(1);
    expect(total.out).toContain("legacy total is 1101 bytes, over the budget of 1100");
    const largest = await script("check-legacy-budget.mjs", await project({ ...baseline, ...dist(1000, 631) }));
    expect(largest.code).toBe(1);
    expect(largest.out).toContain("legacy largest file is 631 bytes, over the budget of 630");
  });
  it("fails when dist or the legacy chunks are missing", async () => {
    expect((await script("check-legacy-budget.mjs", await project({}))).out).toContain("dist/ does not exist");
    expect((await script("check-legacy-budget.mjs", await project({ "dist/assets/index-a.js": "x" }))).out).toContain("no legacy chunk");
  });
});

describe("apply-react-pack on a Vite project", () => {
  const apply = (root: string) => run("node", [path.resolve("scripts/apply-react-pack.mjs"), root, "--name", "Demo App"]);
  const starter = {
    "package.json": JSON.stringify({ name: "demo", scripts: { build: "vite build" } }),
    "vite.config.ts": "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n",
    "src/main.tsx": "import App from './App'\n",
    "src/App.tsx": "export default function App() { return <p>count is 0</p> }\n",
    "src/App.css": ".a { color: #fff; }\n", "src/index.css": "body { margin: 12px; }\n",
    "src/assets/hero.png": "x", "src/assets/react.svg": "x", "src/assets/vite.svg": "x",
  };
  it("adds the legacy plugin from the matrix, replaces the untouched starter, writes the AI map block, and is idempotent", async () => {
    const root = await project(starter);
    const { stdout } = await apply(root);
    const config = await readFile(path.join(root, "vite.config.ts"), "utf8");
    expect(config).toContain("import legacy from '@vitejs/plugin-legacy'");
    expect(config).toContain("plugins: [react(), legacy({ targets: ['Chrome >= 53'] })]");
    expect(stdout).toContain("starter: the untouched Vite counter demo was replaced");
    expect(await readFile(path.join(root, "src/App.tsx"), "utf8")).not.toContain("count is");
    for (const gone of ["src/App.css", "src/assets/hero.png"]) await expect(readFile(path.join(root, gone))).rejects.toThrow();
    expect(await readFile(path.join(root, "docs/ai/INDEX.md"), "utf8")).toContain("<!-- generated:begin");
    expect((await script("check-device-tiers.mjs", root)).code).toBe(0);
    const again = await apply(root);
    expect(again.stdout).toContain("legacy plugin already configured");
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).toBe(config);
  });
  it("never rewrites an app that has left the starter, and reports a vite config it cannot patch", async () => {
    const custom = { ...starter, "src/App.tsx": "export default function App() { return <p>my real app</p> }\n", "vite.config.ts": "import { defineConfig } from 'vite'\nconst plugins = []\nexport default defineConfig({ plugins })\n" };
    const root = await project(custom);
    const { stdout } = await apply(root);
    expect(await readFile(path.join(root, "src/App.tsx"), "utf8")).toContain("my real app");
    expect(await readFile(path.join(root, "src/App.css"), "utf8")).toContain("#fff");
    expect(stdout).toContain("could not patch vite.config.ts");
    expect((await script("check-device-tiers.mjs", root)).code).toBe(1);
  });
});

describe("pack wiring for the legacy tier", () => {
  it("copies the matrix, rules and gates, gates the checks after the build, and installs the plugin and parser", async () => {
    const data = JSON.parse(await readFile(path.join(pack, "pack.json"), "utf8")) as { copy: string[]; scripts: Record<string, string>; gates: Array<{ script: string; parallel?: boolean }>; devDependencies: string[] };
    for (const file of ["knip.json", "docs/ai/device-tiers.json", "docs/ai/legacy-banned.json", "scripts/check-device-tiers.mjs", "scripts/check-legacy-apis.mjs", "scripts/check-legacy-syntax.mjs", "scripts/check-legacy-budget.mjs"]) expect(data.copy).toContain(file);
    expect(data.devDependencies).toEqual(expect.arrayContaining(["@vitejs/plugin-legacy@^8", "acorn"]));
    const order = data.gates.map(gate => gate.script);
    expect(order.indexOf("build")).toBeLessThan(order.indexOf("check:legacy-syntax"));
    expect(order.indexOf("check:legacy-syntax")).toBeLessThan(order.indexOf("check:legacy-budget"));
    expect(data.gates.find(gate => gate.script === "check:legacy-syntax")?.parallel).toBeUndefined();
    expect(data.scripts.verify).toMatch(/npm run build && npm run check:legacy-syntax && npm run check:legacy-budget/);
  });
});
