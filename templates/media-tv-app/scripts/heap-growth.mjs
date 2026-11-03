#!/usr/bin/env node
// Heap growth over repeated navigation (B-125, ADR 0034): a TV has little memory, and a single-page app leaks when a route leaves something behind. This visits the routes of e2e/heap-routes.json again and
// again without reloading the page (history.pushState plus a popstate event, which routers listen to), forces a garbage collection after each full pass, and fails when the heap keeps growing past the budget
// of docs/ai/performance-budgets.json once the warm-up passes are over. Long tasks are reported (they only warn until real device numbers exist). Needs playwright-core and a Chromium:
// CHROME_PATH, else the one playwright-core knows. The app is served by `vite preview` unless HEAP_URL names a running one. No other dependencies.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Growth per pass in KB between the first sample after the warm-up and the last. Needs at least two samples after the warm-up. */
export function growthPerCycle(samples, warmup) {
  const kept = samples.slice(warmup);
  if (kept.length < 2) throw new Error(`need more than ${warmup + 1} cycles to measure growth`);
  return (kept[kept.length - 1] - kept[0]) / (kept.length - 1) / 1024;
}

/** Runs the passes over the routes on an open page and returns the heap after each pass (bytes, after a forced collection) and the long tasks seen (ms). */
export async function measureHeap({ page, baseUrl, routes, cycles, settleMs = 150 }) {
  await page.addInitScript(() => { window.__longTasks = []; try { new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__longTasks.push(entry.duration); }).observe({ entryTypes: ["longtask"] }); } catch { /* not supported on this engine */ } });
  await page.goto(baseUrl, { waitUntil: "load" });
  const session = await page.context().newCDPSession(page);
  const samples = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const route of routes) {
      await page.evaluate(target => { window.history.pushState({}, "", target); window.dispatchEvent(new PopStateEvent("popstate")); }, route);
      await page.waitForTimeout(settleMs);
    }
    await session.send("HeapProfiler.collectGarbage");
    samples.push((await session.send("Runtime.getHeapUsage")).usedSize);
  }
  return { samples, longTasks: await page.evaluate(() => window.__longTasks ?? []) };
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ } await new Promise(resolve => setTimeout(resolve, 300)); }
  return false;
}

async function main() {
  const root = path.resolve(process.argv[2] ?? ".");
  const readJson = file => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const budgets = readJson("docs/ai/performance-budgets.json");
  const routes = readJson("e2e/heap-routes.json").routes ?? [];
  if (!routes.length) { console.log("test:heap ok (no routes configured in e2e/heap-routes.json yet)"); return; }
  const { chromium } = await import("playwright-core");
  const executablePath = process.env.CHROME_PATH ?? chromium.executablePath();
  if (!executablePath || !existsSync(executablePath)) { console.error("test:heap: no Chromium found; set CHROME_PATH or install one for playwright-core"); process.exit(1); }
  let server; let baseUrl = process.env.HEAP_URL;
  if (!baseUrl) {
    const port = 4173; baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
    if (!await waitFor(baseUrl, 30_000)) { server.kill(); console.error("test:heap: vite preview did not start; run npm run build first"); process.exit(1); }
  }
  const browser = await chromium.launch({ executablePath, args: ["--js-flags=--expose-gc"] });
  try {
    const { samples, longTasks } = await measureHeap({ page: await browser.newPage(), baseUrl, routes, cycles: budgets.heap.cycles });
    const growth = growthPerCycle(samples, budgets.heap.warmupCycles);
    const slow = longTasks.filter(duration => duration > budgets.longTasks.maxMs).length;
    console.log(`test:heap ${growth > budgets.heap.maxGrowthKbPerCycle ? "FAILED" : "ok"}: heap grew ${growth.toFixed(1)} KB per pass over ${routes.length} route(s) (budget ${budgets.heap.maxGrowthKbPerCycle} KB, ${budgets.heap.cycles} passes, ${budgets.heap.warmupCycles} warm-up); ${slow} long task(s) over ${budgets.longTasks.maxMs} ms${budgets.longTasks.enforced ? "" : " (reported only)"}`);
    if (growth > budgets.heap.maxGrowthKbPerCycle || (budgets.longTasks.enforced && slow > 0)) process.exitCode = 1;
  } finally { await browser.close(); server?.kill(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`test:heap: ${error.message}`); process.exit(1); });
