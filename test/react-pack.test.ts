// The react-ts-vite pack's check scripts (ADR 0034, 0035): they run in every new React project, so each one is proven here against fixtures that violate exactly one rule.
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const run = promisify(execFile);
const scripts = path.resolve("templates/react-ts-vite/scripts");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-pack-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
async function check(script: string, root: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  try { const { stdout, stderr } = await run("node", [path.join(scripts, script), root], { env: { ...process.env, ...env } }); return { code: 0, out: stdout + stderr }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}

describe("check-ai-files", () => {
  const agents = "# Rules\n- R-001 strict types\n- R-002 tests for logic\n";
  const good = { "AGENTS.md": agents, "CLAUDE.md": "See AGENTS.md.\n", "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }), "docs/ai/enforcement.json": JSON.stringify([{ id: "R-001", gate: "typecheck" }, { id: "R-002", gate: "prose" }]) };
  it("accepts short pointer files and a manifest that maps every rule to a script or prose", async () => {
    const result = await check("check-ai-files.mjs", await project(good));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("2 rules");
  });
  it("fails an AGENTS.md over the size budget", async () => {
    const result = await check("check-ai-files.mjs", await project({ ...good, "AGENTS.md": `${agents}${"- filler line\n".repeat(160)}` }));
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/AGENTS\.md has \d+ lines/);
  });
  it("fails a rule with no manifest entry, a manifest entry with no rule, and a gate that is not an npm script", async () => {
    const result = await check("check-ai-files.mjs", await project({ ...good, "docs/ai/enforcement.json": JSON.stringify([{ id: "R-001", gate: "lint:nowhere" }, { id: "R-009", gate: "prose" }]) }));
    expect(result.code).toBe(1);
    for (const expected of ["R-002 is in AGENTS.md but has no entry", "R-009 is in enforcement.json but not in AGENTS.md", "'lint:nowhere', which is not an npm script"]) expect(result.out).toContain(expected);
  });
  it("fails a pointer file that forks policy: no pointer, repeated rule ids, or too long", async () => {
    expect((await check("check-ai-files.mjs", await project({ ...good, "CLAUDE.md": "My own rules.\n" }))).out).toContain("does not point to AGENTS.md");
    expect((await check("check-ai-files.mjs", await project({ ...good, "CLAUDE.md": "See AGENTS.md. R-001 again.\n" }))).out).toContain("repeats rule ids");
    expect((await check("check-ai-files.mjs", await project({ ...good, "GEMINI.md": `See AGENTS.md.\n${"x\n".repeat(30)}` }))).out).toContain("limit 15");
  });
  it("fails when AGENTS.md or the manifest is missing", async () => {
    const result = await check("check-ai-files.mjs", await project({ "package.json": "{}" }));
    expect(result.code).toBe(1);
    expect(result.out).toContain("AGENTS.md is missing");
    expect(result.out).toContain("enforcement.json is missing");
  });
});

describe("check-style-tokens", () => {
  const css = (body: string) => ({ "src/components/box.css": `.box {\n${body}\n}\n` });
  it("accepts tokens, rem, 100vh min-height, px in a media query, tagged exceptions and anything under src/styles or in tests", async () => {
    const files = {
      ...css("  color: var(--color-text);\n  padding: 1.5rem;\n  min-height: 100vh;\n  border: 1px solid var(--color-focus); /* token-ok: hairline on a 1x panel */"),
      "src/components/q.css": "@media (max-height: 750px) {\n  .a { margin: var(--space-2); }\n}\n",
      "src/styles/tokens.css": ":root { --color-bg: #0b0b12; font-size: 12px; }\n",
      "src/x.test.tsx": "const c = '#fff'; const w = '10px';\n",
      "src/ok.tsx": "const style = { color: 'var(--color-text)' };\n",
    };
    const result = await check("check-style-tokens.mjs", await project(files));
    expect(result.code, result.out).toBe(0);
  });
  it.each([
    ["  color: #fff;", "raw colour"], ["  background: rgba(0, 0, 0, 0.5);", "raw colour"], ["  --accent: hsl(10 20% 30%);", "raw colour"],
    ["  padding: 12px;", "raw px"], ["  margin: -0.5px;", "raw px"],
    ["  height: 50vh;", "viewport unit 50vh"], ["  width: 100vw;", "viewport unit 100vw"], ["  font-size: 2vmin;", "viewport unit 2vmin"], ["  padding: 100vh;", "viewport unit 100vh"],
  ])("fails %s", async (body, expected) => {
    const result = await check("check-style-tokens.mjs", await project(css(body)));
    expect(result.code).toBe(1);
    expect(result.out).toContain(expected);
    expect(result.out).toContain("src/components/box.css:2");
  });
  it("fails inline colours and sizes in TSX strings, ignores code outside strings and comments", async () => {
    const bad = await check("check-style-tokens.mjs", await project({ "src/a.tsx": "export const a = <div style={{ color: '#abc', width: '20px' }} />;\n" }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("raw colour");
    expect(bad.out).toContain("raw px");
    const fine = await check("check-style-tokens.mjs", await project({ "src/b.tsx": "// colour #fff and 12px are described here\nexport const n = 12;\n", "src/c.css": "/* old: #fff 12px 50vh */\n.c { color: var(--color-text); }\n" }));
    expect(fine.code, fine.out).toBe(0);
  });
  it("treats a tag without a reason as no tag", async () => {
    expect((await check("check-style-tokens.mjs", await project(css("  padding: 3px; /* token-ok: */")))).code).toBe(1);
  });
});

describe("check-debt-ledger", () => {
  const header = "| ID | Reason | Risk | Next action | Owner | Tracking | Review date |\n|---|---|---|---|---|---|---|\n";
  const row = (id: string, date = "2099-01-01", reason = "kept for old TVs") => `| ${id} | ${reason} | low | replace with the hook | team | #12 | ${date} |\n`;
  it("accepts tagged code whose ledger rows are complete and not expired", async () => {
    const result = await check("check-debt-ledger.mjs", await project({ "src/a.ts": "// TODO(debt:D-001) move to a worker\n/** @deprecated Use fetchPage instead (debt:D-002) */\n", "docs/technical-debt/LEDGER.md": header + row("D-001") + row("D-002") }));
    expect(result.code, result.out).toBe(0);
  });
  it("fails a tag without a ledger row, a bare TODO, and a deprecation without reference or reason", async () => {
    const result = await check("check-debt-ledger.mjs", await project({ "src/a.ts": "// TODO(debt:D-009) later\n// TODO fix this\n/** @deprecated */\n/** @deprecated Use the new service instead */\n", "docs/technical-debt/LEDGER.md": header + row("D-001") }));
    expect(result.code).toBe(1);
    for (const expected of ["D-009 has no row", "a TODO without a ledger id", "@deprecated needs the replacement or the reason", "needs a ledger reference"]) expect(result.out).toContain(expected);
  });
  it("fails an expired review date, an empty field and a malformed date", async () => {
    const files = { "src/a.ts": "// TODO(debt:D-001) x\n", "docs/technical-debt/LEDGER.md": header + row("D-001", "2020-01-01") + row("D-002", "soon") + row("D-003", "2099-01-01", "-") };
    const result = await check("check-debt-ledger.mjs", await project(files), { CHECK_TODAY: "2026-11-02" });
    expect(result.code).toBe(1);
    for (const expected of ["D-001: review date 2020-01-01 has passed", "D-002: review date 'soon' is not YYYY-MM-DD", "D-003: 'reason' is empty"]) expect(result.out).toContain(expected);
  });
  it("passes a project with no debt and no ledger, and fails a wrong header", async () => {
    expect((await check("check-debt-ledger.mjs", await project({ "src/a.ts": "export const a = 1;\n" }))).code).toBe(0);
    const result = await check("check-debt-ledger.mjs", await project({ "docs/technical-debt/LEDGER.md": "| ID | Why |\n|---|---|\n" }));
    expect(result.out).toContain("header must be");
  });
});

describe("check-page-docs", () => {
  const doc = (cases = "- C-001 shows the offline message\n- C-002 retries when the network returns") => `# Offline\n\n## Purpose\nx\n\n## Visible content\nx\n\n## Actions\nx\n\n## Inputs\nx\n\n## Data\nx\n\n## Cases\n${cases}\n`;
  const page = { "src/pages/offline/index.tsx": "export const Page = () => null;\n" };
  const tests = { "src/pages/offline/index.test.tsx": "it('C-001 shows the offline message', () => {});\nit('C-002 retries', () => {});\n" };
  it("accepts a page with a complete document whose cases are all tested", async () => {
    const result = await check("check-page-docs.mjs", await project({ ...page, ...tests, "docs/pages/offline.md": doc() }));
    expect(result.code, result.out).toBe(0);
  });
  it("fails a page without a document, a missing section, a case without a test and a stale document", async () => {
    expect((await check("check-page-docs.mjs", await project({ ...page }))).out).toContain("page 'offline' has no docs/pages/offline.md");
    expect((await check("check-page-docs.mjs", await project({ ...page, ...tests, "docs/pages/offline.md": doc().replace("## Inputs\nx\n\n", "") }))).out).toContain("missing the section '## Inputs'");
    expect((await check("check-page-docs.mjs", await project({ ...page, ...tests, "docs/pages/offline.md": doc("- C-001 a\n- C-003 an untested case") }))).out).toContain("case C-003 is not cited by a test in src/pages/offline/ or a shared test");
    expect((await check("check-page-docs.mjs", await project({ ...page, ...tests, "docs/pages/offline.md": doc(), "docs/pages/gone.md": doc() }))).out).toContain("docs/pages/gone.md describes a page folder that does not exist");
  });
  it("fails a document with no cases, ignores the template and readme files, and passes a project with no pages", async () => {
    expect((await check("check-page-docs.mjs", await project({ ...page, "docs/pages/offline.md": doc("nothing listed") }))).out).toContain("lists no cases");
    expect((await check("check-page-docs.mjs", await project({ "docs/pages/_TEMPLATE.md": doc(), "docs/pages/README.md": "x\n" }))).code).toBe(0);
  });
});

describe("apply-react-pack", () => {
  const apply = (root: string, ...extra: string[]) => run("node", [path.resolve("scripts/apply-react-pack.mjs"), root, "--name", "Demo App", ...extra]);
  const base = { "package.json": JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }), "src/main.tsx": "import App from './App';\n" };
  it("replaces the Vite default lint script, announces the superseded oxlint and pins the toolchain the gates need", async () => {
    const root = await project({ "package.json": JSON.stringify({ name: "demo", scripts: { lint: "oxlint" }, devDependencies: { oxlint: "^1.0.0" } }), "src/main.tsx": "import App from './App';\n" });
    const { stdout } = await apply(root);
    expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts.lint).toBe("eslint .");
    expect(stdout).toContain("npm uninstall oxlint");
    for (const pin of ["typescript@~6.0.3", "eslint@^9.39.5", "@eslint/js@^9.39.5", "vitest"]) expect(stdout, pin).toContain(pin);
    const custom = await project({ "package.json": JSON.stringify({ name: "demo", scripts: { lint: "biome check" } }), "src/main.tsx": "import App from './App';\n" });
    await apply(custom);
    expect(JSON.parse(await readFile(path.join(custom, "package.json"), "utf8")).scripts.lint).toBe("biome check");
  });
  it("installs the pack into a Vite project, keeps existing scripts, and the result passes its own checks", async () => {
    const root = await project(base);
    const { stdout } = await apply(root);
    expect(stdout).toContain("pack react-ts-vite");
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.test).toBe("vitest run");
    for (const script of ["verify", "typecheck", "lint", "knip", "depcruise", "jscpd", "check:ai", "check:debt", "check:pages", "check:styles", "check:journeys", "test:related"]) expect(manifest.scripts[script], script).toBeTruthy();
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("# Demo App: agent rules");
    expect(await readFile(path.join(root, "ENGINEERING_STANDARDS.md"), "utf8")).toContain("Engineering standards: React + TypeScript + Vite");
    expect((await readFile(path.join(root, "src/main.tsx"), "utf8")).startsWith("import \"./styles/tokens.css\";")).toBe(true);
    for (const script of ["check-ai-files.mjs", "check-debt-ledger.mjs", "check-page-docs.mjs"]) {
      const result = await check(script, root);
      expect(result.code, `${script}: ${result.out}`).toBe(0);
    }
  });
  it("never overwrites an edited file unless --force, and does not add the import twice", async () => {
    const root = await project(base);
    await apply(root);
    await writeFile(path.join(root, "AGENTS.md"), "# my own edits R-001\n");
    const again = await apply(root);
    expect(again.stdout).toContain("kept");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# my own edits R-001\n");
    expect((await readFile(path.join(root, "src/main.tsx"), "utf8")).match(/tokens.css/g)).toHaveLength(1);
    await apply(root, "--force");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("agent rules");
  });
  it("writes approved react-ts standards idempotently and replaces them with --force", async () => {
    const root = await project(base);
    await apply(root);
    const file = path.join(root, "docs/ai/standards/tv-input-focus.md");
    const original = await readFile(file, "utf8");
    expect(original).toContain("Source: docs/standards/react-ts-vite.md (catalog v1)");
    await writeFile(file, "local edit\n");
    await apply(root);
    expect(await readFile(file, "utf8")).toBe("local edit\n");
    await apply(root, "--force");
    expect(await readFile(file, "utf8")).toBe(original);
  });
  it("refuses a folder that is not a project", async () => {
    await expect(apply(await project({ "readme.txt": "x" }))).rejects.toMatchObject({ code: 2 });
  });
});

describe("onboard --pack", () => {
  const orchestrator = path.resolve(".");
  const manifestId = `pack-onboard-${process.pid}`;
  const manifestFile = path.join(orchestrator, "projects", `${manifestId}.json`);
  async function target(): Promise<string> {
    const root = await project({ "package.json": JSON.stringify({ name: "demo", dependencies: { react: "19" }, scripts: {} }) });
    await run("git", ["init", "-q"], { cwd: root });
    return root;
  }
  const onboard = (root: string, write: boolean) => run("node", ["--import", "tsx", "src/cli.ts", "onboard", root, "--name", "Demo App", "--tier", "mvp", "--id", manifestId, "--pack", "react-ts-vite", ...(write ? ["--write"] : [])], { cwd: orchestrator, encoding: "utf8" });
  afterEach(async () => { await rm(manifestFile, { force: true }); });
  it("prints a dry run without changing the repository", async () => {
    const root = await target();
    const result = await onboard(root, false);
    expect(result.stdout).toContain('"npm"');
    expect(result.stderr).toContain("would be applied");
    expect(result.stderr).toContain("npm install -D");
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(root, "scripts", "check-ai-files.mjs"), "utf8")).rejects.toThrow();
    await expect(readFile(manifestFile, "utf8")).rejects.toThrow();
  });
  it("applies files on write and keeps them on an idempotent second run", async () => {
    const root = await target();
    const first = await onboard(root, true);
    expect(first.stdout).toContain("pack react-ts-vite: wrote");
    expect(first.stdout).toContain("npm install -D");
    const files = ["AGENTS.md", "scripts/check-ai-files.mjs", "scripts/check-debt-ledger.mjs", "scripts/check-page-docs.mjs"];
    for (const file of files) await expect(readFile(path.join(root, file), "utf8")).resolves.toBeTruthy();
    expect(await readdir(path.join(root, "docs/ai/standards"))).not.toHaveLength(0);
    const before = await readFile(path.join(root, "AGENTS.md"), "utf8");
    await rm(manifestFile, { force: true });
    const second = await onboard(root, true);
    expect(second.stdout).toContain("kept");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(before);
  });
});

describe("dependency-cruiser config", () => {
  it("loads as CommonJS and declares every forbidden boundary as an error", async () => {
    const require = createRequire(import.meta.url);
    const config = require(path.resolve("templates/react-ts-vite/.dependency-cruiser.cjs")) as { forbidden: Array<{ name: string; severity: string }>; options: Record<string, unknown> };
    const names = ["no-circular", "components-not-import-pages", "hooks-not-import-pages", "services-not-import-ui", "storage-through-index", "input-through-index", "no-prod-imports-test-files", "not-to-unresolvable"];
    expect(config.forbidden.map(rule => rule.name)).toEqual(names);
    expect(config.forbidden.every(rule => rule.severity === "error")).toBe(true);
  });
});
