import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { ProjectManifestSchema, QualityCommandSchema, VisualConfigSchema, type StageInput, type VisualConfig } from "../src/contracts.js";
import { captureScreenshots, findBrowser, visualReviewSection, type BrowserLike, type PageLike } from "../src/visual.js";
import { codexExecutionArgs } from "../src/providers.js";

// ADR 0007: the screenshot capture must never throw or block a run, and a warn-severity quality command must never fail one.
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); for (const server of servers.splice(0)) server.close(); });
const tmp = async () => { const dir = await mkdtemp(path.join(os.tmpdir(), "orch-visual-")); dirs.push(dir); return dir; };
async function listen(): Promise<string> {
  const server = http.createServer((_req, res) => { res.end("ok"); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}
const config = (url: string, overrides: Partial<VisualConfig> = {}): VisualConfig => VisualConfigSchema.parse({ command: { executable: "npm", args: ["run", "dev"] }, url, ...overrides });

function fakeBrowser(log: string[], failOn?: string): BrowserLike {
  const page = (): PageLike => ({
    setDefaultTimeout: () => undefined,
    goto: async () => { log.push("goto"); if (failOn === "goto") throw new Error("net::ERR_CONNECTION_REFUSED\n  at details"); },
    keyboard: { press: async key => { log.push(`press:${key}`); } },
    click: async selector => { log.push(`click:${selector}`); if (failOn === "click") throw new Error("selector not found"); },
    waitForTimeout: async ms => { log.push(`wait:${ms}`); },
    screenshot: async options => { log.push(`shot:${path.basename(options.path)}`); },
    close: async () => { log.push("page-closed"); },
  });
  return { newPage: async () => page(), close: async () => { log.push("browser-closed"); } };
}

describe("manifest schema", () => {
  it("defaults gate severity to blocking and accepts warn", () => {
    expect(QualityCommandSchema.parse({ executable: "npm", args: ["test"] }).severity).toBeUndefined();
    expect(QualityCommandSchema.parse({ executable: "npm", args: ["run", "knip"], severity: "warn" }).severity).toBe("warn");
    expect(() => QualityCommandSchema.parse({ executable: "npm", args: [], severity: "ignore" })).toThrow();
    expect(() => QualityCommandSchema.parse({ executable: "bash", args: [] })).toThrow();
  });
  it("accepts only local pages and well-formed steps", () => {
    for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000", "http://[::1]:8080/x"]) expect(() => config(url)).not.toThrow();
    for (const url of ["https://example.com/", "http://localhost.evil.com/", "http://10.0.0.5:3000/", "file:///etc/passwd"]) expect(() => config(url)).toThrow();
    expect(() => config("http://localhost:1/", { steps: [{ do: "shot", name: "Has Spaces" }] })).toThrow();
    expect(() => config("http://localhost:1/", { steps: [{ do: "wait", ms: 60_000 }] })).toThrow();
    expect(() => config("http://localhost:1/", { steps: [{ do: "eval", code: "1" } as never] })).toThrow();
    expect(config("http://localhost:1/").steps).toEqual([{ do: "shot", name: "initial" }]);
  });
  it("carries visual and severity through a project manifest", () => {
    const manifest = ProjectManifestSchema.parse({ id: "p1", name: "P", root: "p", defaultProfile: "implementation", repository: { targetBranch: "main" }, providers: { default: "fake" },
      qualityCommands: [{ executable: "npm", args: ["test"] }, { executable: "npm", args: ["run", "knip"], severity: "warn" }],
      visual: { command: { executable: "npm", args: ["run", "dev"] }, url: "http://localhost:5173/" } });
    expect(manifest.qualityCommands[1]?.severity).toBe("warn");
    expect(manifest.visual?.required).toBe(false);
  });
});

describe("findBrowser", () => {
  const fsOf = (files: string[]) => ({ exists: (file: string) => files.includes(file), list: (dir: string) => [...new Set(files.filter(file => file.startsWith(`${dir}\\`)).map(file => file.slice(dir.length + 1).split("\\")[0] as string))] });
  const root = "C:\\Users\\u\\AppData\\Local\\ms-playwright";
  const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  it("uses the newest downloaded revision, preferring the headless shell", () => {
    const shell = (revision: number) => `${root}\\chromium_headless_shell-${revision}\\chrome-headless-shell-win64\\chrome-headless-shell.exe`;
    expect(findBrowser(env, "win32", fsOf([shell(1208), shell(1243), shell(1228)]))).toBe(shell(1243));
  });
  it("falls back to full chromium and to a system browser", () => {
    const full = `${root}\\chromium-1243\\chrome-win64\\chrome.exe`;
    expect(findBrowser(env, "win32", fsOf([full]))).toBe(full);
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(findBrowser({ ...env, "ProgramFiles(x86)": "C:\\Program Files (x86)" }, "win32", fsOf([edge]))).toBe(edge);
    expect(findBrowser(env, "win32", fsOf([]))).toBeUndefined();
  });
  it("trusts an explicit path only when it exists", () => {
    expect(findBrowser({ ORCHESTRATOR_BROWSER_PATH: "D:\\b\\chrome.exe" }, "win32", fsOf(["D:\\b\\chrome.exe"]))).toBe("D:\\b\\chrome.exe");
    expect(findBrowser({ ORCHESTRATOR_BROWSER_PATH: "D:\\missing.exe" }, "win32", fsOf([`${root}\\chromium-1243\\chrome-win64\\chrome.exe`]))).toBeUndefined();
  });
});

describe("captureScreenshots", () => {
  const server = (log: string[]) => () => ({ stop: () => { log.push("server-stopped"); }, exited: () => undefined });
  it("runs the steps in order, saves named shots and cleans up", async () => {
    const url = await listen(); const log: string[] = []; const outDir = await tmp();
    const result = await captureScreenshots(config(url, { steps: [{ do: "shot", name: "initial" }, { do: "press", key: "Space" }, { do: "wait", ms: 250 }, { do: "shot", name: "jump" }, { do: "click", selector: "#restart" }] }), { cwd: outDir, outDir },
      { findBrowser: () => "chrome", launch: async () => fakeBrowser(log), startServer: server(log) });
    expect(result.warnings).toEqual([]);
    expect(result.images.map(file => path.basename(file))).toEqual(["desktop-initial.png", "desktop-jump.png"]);
    expect(log).toEqual(["goto", "shot:desktop-initial.png", "press:Space", "wait:250", "shot:desktop-jump.png", "click:#restart", "page-closed", "browser-closed", "server-stopped"]);
  });
  it("captures every viewport and stops at the image limit with a warning", async () => {
    const url = await listen(); const log: string[] = []; const outDir = await tmp();
    const viewports = [{ name: "desktop", width: 1280, height: 720 }, { name: "phone", width: 390, height: 844 }];
    const full = await captureScreenshots(config(url, { viewports }), { cwd: outDir, outDir }, { findBrowser: () => "chrome", launch: async () => fakeBrowser(log), startServer: server(log) });
    expect(full.images.map(file => path.basename(file))).toEqual(["desktop-initial.png", "phone-initial.png"]);
    const capped = await captureScreenshots(config(url, { viewports, maxImages: 1 }), { cwd: outDir, outDir }, { findBrowser: () => "chrome", launch: async () => fakeBrowser(log), startServer: server(log) });
    expect(capped.images).toHaveLength(1);
    expect(capped.warnings.join()).toContain("limit of 1");
  });
  it("degrades to a warning when no browser exists, without starting the app", async () => {
    const log: string[] = [];
    const result = await captureScreenshots(config("http://127.0.0.1:1/"), { cwd: ".", outDir: await tmp() }, { findBrowser: () => undefined, startServer: server(log) });
    expect(result.images).toEqual([]);
    expect(result.warnings[0]).toContain("no Chromium found");
    expect(log).toEqual([]);
  });
  it("degrades to a warning when the app exits early or never answers, and always stops it", async () => {
    const log: string[] = [];
    const crashed = await captureScreenshots(config("http://127.0.0.1:1/"), { cwd: ".", outDir: await tmp() }, { findBrowser: () => "chrome", startServer: () => ({ stop: () => { log.push("stopped"); }, exited: () => "exited with code 1: vite crashed" }) });
    expect(crashed.warnings[0]).toContain("vite crashed");
    const silent = await captureScreenshots(config("http://127.0.0.1:1/", { readyTimeoutMs: 1000 }), { cwd: ".", outDir: await tmp() }, { findBrowser: () => "chrome", startServer: () => ({ stop: () => { log.push("stopped"); }, exited: () => undefined }) });
    expect(silent.warnings[0]).toContain("nothing answered");
    expect(log).toEqual(["stopped", "stopped"]);
  }, 15_000);
  it("keeps going after a failing viewport or step and reports it", async () => {
    const url = await listen(); const log: string[] = []; const outDir = await tmp();
    const viewports = [{ name: "desktop", width: 1280, height: 720 }, { name: "phone", width: 390, height: 844 }];
    const result = await captureScreenshots(config(url, { viewports, steps: [{ do: "click", selector: "#x" }, { do: "shot", name: "after" }] }), { cwd: outDir, outDir }, { findBrowser: () => "chrome", launch: async () => fakeBrowser(log, "click"), startServer: server(log) });
    expect(result.images).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("selector not found");
    expect(log.filter(entry => entry === "page-closed")).toHaveLength(2);
    expect(log.at(-1)).toBe("server-stopped");
  });
  it("never throws, even when the browser cannot launch", async () => {
    const url = await listen(); const log: string[] = []; const outDir = await tmp();
    const result = await captureScreenshots(config(url), { cwd: outDir, outDir }, { findBrowser: () => "chrome", launch: async () => { throw new Error("spawn EACCES"); }, startServer: server(log) });
    expect(result.warnings[0]).toContain("spawn EACCES");
    expect(log).toEqual(["server-stopped"]);
  });
  it("stops when cancelled", async () => {
    const url = await listen(); const log: string[] = []; const outDir = await tmp(); const controller = new AbortController(); controller.abort();
    const result = await captureScreenshots(config(url), { cwd: outDir, outDir, signal: controller.signal }, { findBrowser: () => "chrome", launch: async () => fakeBrowser(log), startServer: server(log) });
    expect(result.images).toEqual([]);
    expect(log).toContain("server-stopped");
  });
});

describe("prompt and provider wiring", () => {
  it("lists every image and tells the reviewer not to guess", () => {
    const section = visualReviewSection(["/a/desktop-initial.png", "/a/desktop-jump.png"]);
    expect(section).toContain("- /a/desktop-initial.png");
    expect(section).toContain("- /a/desktop-jump.png");
    expect(section).toMatch(/cannot view them, say so/);
  });
  it("attaches images to codex before the model flags and keeps the stdin marker last", () => {
    const args = codexExecutionArgs("p", "review", undefined, "m", ["/a/one.png", "/a/two.png"]);
    expect(args).toContain("--image=/a/one.png"); expect(args).toContain("--image=/a/two.png");
    expect(args.indexOf("--image=/a/two.png")).toBeLessThan(args.indexOf("--model"));
    expect(args.at(-1)).toBe("-");
    expect(codexExecutionArgs("p", "review", undefined, "m")).not.toContain("--image=");
  });
});

describe("activity integration", () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock("../src/visual.js"); });
  const base = async (overrides: Partial<StageInput>): Promise<StageInput> => { const dir = await tmp(); return { runId: "r", taskId: "t", projectId: "p", profile: "implementation", stage: "review", prompt: "review it", attempt: 1, provider: "fake", projectRoot: dir, artifactsDir: dir, plugins: [], ...overrides }; };

  it("a warn-severity command that fails becomes a warning; a blocking one still fails", async () => {
    const { executeStage } = await import("../src/activities.js");
    const failing = { executable: "node" as const, args: ["-e", "console.log('3 unused exports'); process.exit(1)"] };
    const passed = await executeStage(await base({ stage: "verify", verificationOnly: true, qualityCommands: [{ ...failing, severity: "warn" }, { executable: "node", args: ["-e", "process.exit(0)"] }] }));
    expect(passed.ok).toBe(true);
    expect(passed.metadata?.warnings).toEqual([expect.stringContaining("3 unused exports")]);
    const blocked = await executeStage(await base({ stage: "verify", verificationOnly: true, runId: "r2", qualityCommands: [failing] }));
    expect(blocked.ok).toBe(false);
  });

  it("collapses whitespace in the warning text", async () => {
    const { executeStage } = await import("../src/activities.js");
    const noisy = { executable: "node" as const, args: ["-e", "console.log('a\\n\\n   b'); process.exit(2)"], severity: "warn" as const };
    const result = await executeStage(await base({ stage: "verify", verificationOnly: true, qualityCommands: [noisy, { executable: "node", args: ["-e", "0"] }] }));
    expect(String((result.metadata?.warnings as string[])[0])).toContain("a b");
  });

  it("attaches captured screenshots and capture warnings to the review result", async () => {
    const dir = await tmp();
    vi.doMock("../src/visual.js", () => ({ captureScreenshots: async () => ({ images: [path.join(dir, "desktop-initial.png")], warnings: ["screenshot limit of 1 reached; later shots skipped"] }), visualReviewSection: (images: string[]) => `\nVISUAL ${images.length}` }));
    const { executeStage } = await import("../src/activities.js");
    const result = await executeStage(await base({ projectRoot: dir, artifactsDir: dir, visual: config("http://127.0.0.1:1/") }));
    expect(result.metadata?.warnings).toEqual(["screenshot limit of 1 reached; later shots skipped"]);
    expect(result.metadata?.screenshots).toEqual([path.join(dir, "desktop-initial.png")]);
    expect(result.artifactRefs).toContain(path.join(dir, "desktop-initial.png"));
  });

  it("capture trouble only warns by default and fails the review when visual.required is set", async () => {
    const dir = await tmp();
    vi.doMock("../src/visual.js", () => ({ captureScreenshots: async () => ({ images: [], warnings: ["visual capture skipped: no Chromium found"] }), visualReviewSection: () => "" }));
    const { executeStage } = await import("../src/activities.js");
    const lenient = await executeStage(await base({ projectRoot: dir, artifactsDir: dir, visual: config("http://127.0.0.1:1/") }));
    expect(lenient.ok).toBe(true);
    expect(lenient.metadata?.warnings).toEqual(["visual capture skipped: no Chromium found"]);
    await expect(executeStage(await base({ projectRoot: dir, artifactsDir: dir, runId: "r3", visual: config("http://127.0.0.1:1/", { required: true }) }))).rejects.toThrow(/visual verification is required/);
  });

  it("does nothing for projects without a visual block", async () => {
    const { executeStage } = await import("../src/activities.js");
    const result = await executeStage(await base({}));
    expect(result.metadata?.warnings).toBeUndefined();
    expect(result.metadata?.screenshots).toBeUndefined();
  });
});
