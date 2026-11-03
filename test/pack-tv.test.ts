// The media-tv-app overlay pack (B-125): the registry of protected components, the heap-growth test that fails on a seeded leak, and applying and onboarding the pack on top of react-ts-vite.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { findBrowser } from "../src/visual.js";
import { onboardManifest, readPack } from "../src/stack-packs.js";
import { ProjectManifestSchema } from "../src/contracts.js";

const run = promisify(execFile);
const pack = path.resolve("templates/media-tv-app");
const dirs: string[] = []; const servers: Server[] = [];
afterAll(async () => { for (const server of servers) server.close(); for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const temp = async (prefix = "orch-tv-") => { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };
async function put(root: string, files: Record<string, string>) { for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); } }
async function node(script: string, ...args: string[]): Promise<{ code: number; out: string }> {
  try { const { stdout, stderr } = await run("node", [script, ...args]); return { code: 0, out: stdout + stderr }; }
  catch (error) { const failure = error as { code?: number; stdout?: string; stderr?: string }; return { code: failure.code ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` }; }
}
const registryFile = () => readFile(path.join(pack, "docs/ai/component-registry.json"), "utf8");
const APPROVED = "# Design: carousel\nStatus: approved\nArea: carousel\nAuthor: codex\n";

describe("check-registry", () => {
  const check = (root: string) => node(path.join(pack, "scripts/check-registry.mjs"), root);
  it("passes the registry the pack ships, which lists the carousel as protected", async () => {
    const root = await temp(); await put(root, { "docs/ai/component-registry.json": await registryFile() });
    const result = await check(root);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("2 component(s), 2 protected");
    expect((JSON.parse(await registryFile()) as { components: Array<{ id: string }> }).components.map(component => component.id)).toContain("carousel");
  });
  it("fails a protected component whose folder exists without an approved design, and passes once it has one and a README", async () => {
    const root = await temp(); await put(root, { "docs/ai/component-registry.json": await registryFile(), "src/components/carousel/Row.tsx": "export {};\n" });
    const without = await check(root);
    expect(without.code).toBe(1);
    expect(without.out).toContain("src/components/carousel exists but its design docs/design/carousel.md does not");
    await put(root, { "docs/design/carousel.md": APPROVED.replace("approved", "draft") });
    expect((await check(root)).out).toContain("is not approved yet");
    await put(root, { "docs/design/carousel.md": APPROVED });
    expect((await check(root)).out).toContain("README.md (the module contract, R-022) is missing");
    await put(root, { "src/components/carousel/README.md": "# carousel\n" });
    expect((await check(root)).code).toBe(0);
  });
  it.each([
    ["no carousel", (registry: { components: unknown[] }) => { registry.components = registry.components.filter(component => (component as { id: string }).id !== "carousel"); }, "must list the carousel"],
    ["a duplicate id", (registry: { components: unknown[] }) => { registry.components.push(registry.components[0]); }, "duplicate id"],
    ["a path that leaves the repository", (registry: { components: Array<{ path: string }> }) => { registry.components[0]!.path = "../outside"; }, "path must be a repository-relative folder"],
    ["a missing reason", (registry: { components: Array<{ reason: string }> }) => { registry.components[0]!.reason = "short"; }, "a reason of at least 20 characters"],
    ["a protected component without a design", (registry: { components: Array<{ design?: string }> }) => { delete registry.components[0]!.design; }, "names its design"],
  ])("fails %s", async (_name, mutate, expected) => {
    const registry = JSON.parse(await registryFile()) as { components: never[] };
    mutate(registry as never);
    const root = await temp(); await put(root, { "docs/ai/component-registry.json": JSON.stringify(registry) });
    const result = await check(root);
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
  });
  it("fails a missing registry", async () => { expect((await check(await temp())).code).toBe(1); });
});

describe("heap growth", () => {
  const browserPath = findBrowser();
  const page = (leak: boolean) => `<!doctype html><title>t</title><div id=v>home</div><script>
    window.__keep = [];
    function render() { document.getElementById('v').textContent = location.pathname; ${leak ? "window.__keep.push(new Array(150000).fill(Math.random()));" : ""} }
    window.addEventListener('popstate', render); render();
  </script>`;
  async function serve(leak: boolean): Promise<string> {
    const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(page(leak)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  }
  async function measure(leak: boolean) {
    const { measureHeap, growthPerCycle } = await import(pathToFileURL(path.join(pack, "scripts/heap-growth.mjs")).href) as { measureHeap: (input: unknown) => Promise<{ samples: number[]; longTasks: number[] }>; growthPerCycle: (samples: number[], warmup: number) => number };
    const browser = await chromium.launch({ executablePath: browserPath!, args: ["--js-flags=--expose-gc"] });
    try {
      const { samples } = await measureHeap({ page: await browser.newPage(), baseUrl: await serve(leak), routes: ["/a", "/b", "/c"], cycles: 8, settleMs: 30 });
      return { samples, growth: growthPerCycle(samples, 2) };
    } finally { await browser.close(); }
  }
  it.skipIf(!browserPath)("fails a seeded leak: the heap grows by megabytes per pass, far over the 256 KB budget", async () => {
    const { growth } = await measure(true);
    expect(growth).toBeGreaterThan(1_000);
  }, 120_000);
  it.skipIf(!browserPath)("passes a page that does not leak", async () => {
    const { growth } = await measure(false);
    expect(growth).toBeLessThan(256);
  }, 120_000);
  it("computes growth after the warm-up and refuses too few samples", async () => {
    const { growthPerCycle } = await import(pathToFileURL(path.join(pack, "scripts/heap-growth.mjs")).href) as { growthPerCycle: (samples: number[], warmup: number) => number };
    expect(growthPerCycle([0, 9_999_999, 1_024_000, 2_048_000, 3_072_000], 2)).toBeCloseTo(1_000, 5);
    expect(() => growthPerCycle([1, 2, 3], 2)).toThrow("need more than 3 cycles");
  });
  it("passes when no routes are configured and fails when the budget file is missing", async () => {
    const root = await temp();
    await put(root, { "docs/ai/performance-budgets.json": await readFile(path.join(pack, "docs/ai/performance-budgets.json"), "utf8"), "e2e/heap-routes.json": await readFile(path.join(pack, "e2e/heap-routes.json"), "utf8") });
    const empty = await node(path.join(pack, "scripts/heap-growth.mjs"), root);
    expect(empty.code, empty.out).toBe(0);
    expect(empty.out).toContain("no routes configured");
    expect((await node(path.join(pack, "scripts/heap-growth.mjs"), await temp())).code).toBe(1);
  });
});

describe("the overlay applied and onboarded", () => {
  it("merges its gates into the base: the registry check joins the parallel group, the heap test is a milestone gate at the end", () => {
    const merged = readPack("media-tv-app");
    const base = readPack("react-ts-vite");
    expect(merged.gates.length).toBe(base.gates.length + 2);
    const registryAt = merged.gates.findIndex(gate => gate.script === "check:registry");
    expect(merged.gates[registryAt]!.parallel).toBe(true);
    expect(registryAt).toBeLessThan(merged.gates.findIndex(gate => !gate.parallel));
    expect(merged.gates.at(-1)).toEqual({ script: "test:heap", scope: "milestone" });
    expect(merged.devDependencies).toContain("playwright-core");
    expect(merged.devDependencies).toContain("vitest");
    expect(merged.scripts["test:heap"]).toBe("node scripts/heap-growth.mjs");
  });
  it("onboards with the merged gates and a valid manifest", async () => {
    const root = await temp();
    await put(root, { "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest run", build: "vite build" } }), "README.md": "x\n" });
    const { manifest } = onboardManifest({ root, name: "TV App", tier: "prototype", profile: "react-ts", pack: "media-tv-app" });
    const commands = (manifest.qualityCommands as Array<{ args: string[] }>).map(command => command.args.join(" "));
    expect(commands).toContain("run check:registry");
    expect(commands.at(-1)).toBe("run test:heap");
    expect(ProjectManifestSchema.safeParse(manifest).success).toBe(true);
    expect(() => onboardManifest({ root, name: "TV App", tier: "prototype", profile: "react-ts", pack: "nope" as never })).toThrow("unknown pack");
  });
  it("applies on top of the base pack: base files, overlay files and both scripts, without overwriting", async () => {
    const root = await temp();
    await put(root, { "package.json": JSON.stringify({ name: "demo", scripts: {} }), "src/main.tsx": "export {};\n" });
    const apply = await node(path.resolve("scripts/apply-react-pack.mjs"), root, "--name", "Demo", "--pack", "media-tv-app");
    expect(apply.code, apply.out).toBe(0);
    expect(apply.out).toContain("pack media-tv-app: wrote 6");
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["check:registry"]).toBe("node scripts/check-registry.mjs");
    expect(manifest.scripts["check:design"]).toBe("node scripts/check-design.mjs");
    for (const file of ["docs/ai/component-registry.json", "scripts/heap-growth.mjs", "e2e/heap-routes.json", "AGENTS.md"]) expect(await readFile(path.join(root, file), "utf8")).not.toBe("");
    const again = await node(path.resolve("scripts/apply-react-pack.mjs"), root, "--name", "Demo", "--pack", "media-tv-app");
    expect(again.out).toContain("pack media-tv-app: wrote 0, kept 6");
    expect((await node(path.join(root, "scripts/check-registry.mjs"), root)).code).toBe(0);
  }, 60_000);
  it("rejects an unknown pack", async () => {
    const root = await temp(); await put(root, { "package.json": "{}" });
    expect((await node(path.resolve("scripts/apply-react-pack.mjs"), root, "--name", "x", "--pack", "nope")).code).toBe(2);
  });
});
