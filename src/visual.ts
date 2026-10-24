import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VisualConfig } from "./contracts.js";
import { childEnv } from "./env.js";
import { killProcessTree, toolCommand } from "./process-control.js";
import { captureUnityScreenshots } from "./unity.js";

// Screenshot capture of the running app for the reviewer (ADR 0007). Every problem is reported as a warning: capture never throws, and a review
// that cannot be illustrated still runs on text.

export type VisualResult = { images: string[]; warnings: string[] };
export type PageLike = {
  setDefaultTimeout(ms: number): void;
  goto(url: string, options?: { waitUntil?: "load"; timeout?: number }): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  click(selector: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  close(): Promise<void>;
};
export type BrowserLike = { newPage(options: { viewport: { width: number; height: number } }): Promise<PageLike>; close(): Promise<void> };
export type ServerHandle = { stop(): void; /** Why the process ended, when it ended before the capture finished. */ exited(): string | undefined };
export type VisualDeps = {
  findBrowser?: () => string | undefined;
  launch?: (executablePath: string) => Promise<BrowserLike>;
  startServer?: (config: VisualConfig, cwd: string, signal?: AbortSignal) => ServerHandle;
  now?: () => number;
};
export const CAPTURE_DEADLINE_MS = 180_000;
const STEP_TIMEOUT_MS = 10_000;

type FsView = { exists(file: string): boolean; list(dir: string): string[] };
const realFs: FsView = { exists: existsSync, list: dir => { try { return readdirSync(dir); } catch { return []; } } };

/** Chromium that Playwright already downloaded (newest revision first), or a system Edge/Chrome. ORCHESTRATOR_BROWSER_PATH wins and is never second-guessed. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, fs: FsView = realFs): string | undefined {
  if (env.ORCHESTRATOR_BROWSER_PATH) return fs.exists(env.ORCHESTRATOR_BROWSER_PATH) ? env.ORCHESTRATOR_BROWSER_PATH : undefined;
  const p = platform === "win32" ? path.win32 : path.posix;
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, platform === "win32" ? (env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, "ms-playwright") : undefined) : p.join(env.HOME ?? os.homedir(), ".cache", "ms-playwright")].filter((root): root is string => Boolean(root));
  const layouts: Array<[string, string]> = platform === "win32"
    ? [["chromium_headless_shell-", "chrome-headless-shell-win64/chrome-headless-shell.exe"], ["chromium-", "chrome-win64/chrome.exe"], ["chromium-", "chrome-win/chrome.exe"]]
    : [["chromium_headless_shell-", "chrome-headless-shell-linux64/chrome-headless-shell"], ["chromium-", "chrome-linux64/chrome"], ["chromium-", "chrome-linux/chrome"]];
  for (const root of roots) {
    for (const [prefix, executable] of layouts) {
      const revisions = fs.list(root).filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))).sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
      for (const revision of revisions) { const candidate = p.join(root, revision, ...executable.split("/")); if (fs.exists(candidate)) return candidate; }
    }
  }
  const system = platform === "win32"
    ? [env["ProgramFiles(x86)"] && p.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"), env.ProgramFiles && p.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe")]
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  return system.find((candidate): candidate is string => Boolean(candidate) && fs.exists(candidate as string));
}

function defaultStartServer(config: VisualConfig, cwd: string, signal?: AbortSignal): ServerHandle {
  const web = config.command!; // captureScreenshots only starts a server for engine "web", which the schema guarantees has a command
  const { command, args } = toolCommand(web.executable, web.args);
  // BROWSER=none stops dev servers from opening a window on the operator's desktop.
  const child = spawn(command, args, { cwd: path.resolve(cwd, web.cwd ?? "."), shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { ...childEnv(), BROWSER: "none" } });
  let tail = ""; let ended: string | undefined;
  child.stderr?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-600); });
  child.on("error", error => { ended = `could not start: ${error.message}`; });
  child.on("close", code => { ended = `exited with code ${code ?? "unknown"}${tail.trim() ? `: ${tail.trim().replace(/\s+/g, " ").slice(-300)}` : ""}`; });
  const onAbort = () => killProcessTree(child);
  signal?.addEventListener("abort", onAbort, { once: true });
  return { stop: () => { signal?.removeEventListener("abort", onAbort); killProcessTree(child); }, exited: () => ended };
}

async function defaultLaunch(executablePath: string): Promise<BrowserLike> {
  const { chromium } = await import("playwright-core");
  return await chromium.launch({ executablePath, headless: true }) as unknown as BrowserLike;
}

async function waitReady(url: string, timeoutMs: number, server: ServerHandle, signal: AbortSignal | undefined, now: () => number): Promise<string | undefined> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (signal?.aborted) return "cancelled";
    const ended = server.exited();
    if (ended) return `the start command ${ended}`;
    try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return undefined; } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return `nothing answered at ${url} within ${Math.round(timeoutMs / 1000)}s`;
}

export async function captureScreenshots(config: VisualConfig, options: { cwd: string; outDir: string; signal?: AbortSignal }, deps: VisualDeps = {}): Promise<VisualResult> {
  if (config.engine === "unity") return captureUnityScreenshots(config, options);
  const images: string[] = []; const warnings: string[] = [];
  const url = config.url;
  if (!config.command || !url) return { images, warnings: ["visual capture skipped: the web visual config has no command or url"] };
  const now = deps.now ?? Date.now;
  let server: ServerHandle | undefined; let browser: BrowserLike | undefined;
  try {
    const executable = (deps.findBrowser ?? (() => findBrowser()))();
    if (!executable) return { images, warnings: [`visual capture skipped: no Chromium found (install one with "npx playwright install chromium" or set ORCHESTRATOR_BROWSER_PATH${process.env.ORCHESTRATOR_BROWSER_PATH ? `; the configured path ${process.env.ORCHESTRATOR_BROWSER_PATH} does not exist` : ""})`] };
    await mkdir(options.outDir, { recursive: true });
    const deadline = now() + CAPTURE_DEADLINE_MS;
    server = (deps.startServer ?? defaultStartServer)(config, options.cwd, options.signal);
    const notReady = await waitReady(url, config.readyTimeoutMs, server, options.signal, now);
    if (notReady) return { images, warnings: [`visual capture skipped: ${notReady}`] };
    browser = await (deps.launch ?? defaultLaunch)(executable);
    for (const viewport of config.viewports) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        page.setDefaultTimeout(STEP_TIMEOUT_MS);
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        for (const step of config.steps) {
          if (options.signal?.aborted) throw new Error("cancelled");
          if (now() > deadline) { warnings.push(`visual capture stopped after ${CAPTURE_DEADLINE_MS / 1000}s; remaining steps skipped`); return { images, warnings }; }
          if (step.do === "press") await page.keyboard.press(step.key);
          else if (step.do === "wait") await page.waitForTimeout(step.ms);
          else if (step.do === "click") await page.click(step.selector);
          else {
            if (images.length >= config.maxImages) { warnings.push(`screenshot limit of ${config.maxImages} reached; later shots skipped`); break; }
            const file = path.join(options.outDir, `${viewport.name}-${step.name}.png`);
            await page.screenshot({ path: file });
            if (!images.includes(file)) images.push(file);
          }
        }
      } catch (error) {
        warnings.push(`visual capture in viewport ${viewport.name} stopped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally { await page.close().catch(() => undefined); }
    }
    if (!images.length && !warnings.length) warnings.push("visual capture produced no screenshots: the configured steps contain no shot");
  } catch (error) {
    warnings.push(`visual capture failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  } finally {
    await browser?.close().catch(() => undefined);
    server?.stop();
  }
  return { images, warnings };
}

/** Appended to the review prompt. Written so that a reviewer that cannot open images says so instead of guessing. */
export function visualReviewSection(images: string[]): string {
  return `\n\nVISUAL EVIDENCE\nScreenshots of the running application after this change are attached or saved at:\n${images.map(image => `- ${image}`).join("\n")}\nJudge the rendered result against the task and execution brief: does it look finished and consistent with the rest of the product, is anything cut off, overlapping, blurry or misaligned, and do the states the task asked for look distinct? Report only what you can actually see in the images. If you cannot view them, say so in a note and do not infer how the result looks from the code. Visual problems that contradict the task are blocking findings; taste preferences are notes.`;
}
