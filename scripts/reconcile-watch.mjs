// Reports finished workflows to Paperclip every few minutes: `npm run reconcile:watch [-- --seconds 120]`. Run it in a terminal or as a scheduled task while tasks run.
// It calls the same `reconcile --apply` as by hand (idempotent), with the tokens read from .env (never printed).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const seconds = Number(process.argv.includes("--seconds") ? process.argv[process.argv.indexOf("--seconds") + 1] : 120);
const env = { ...process.env };
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const match = /^(PAPERCLIP_API_TOKEN|PAPERCLIP_API_URL|ORCHESTRATOR_API_TOKEN|ORCHESTRATOR_BRIDGE_URL)=(.*)$/.exec(line.trim());
  if (match) env[match[1]] = match[2].trim().replace(/^"|"$/g, "");
}
console.log(`reconcile watch: every ${seconds}s (Ctrl+C to stop)`);
for (;;) {
  const result = spawnSync(process.execPath, ["dist/src/cli.js", "reconcile", "--apply"], { env, encoding: "utf8" });
  const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`.split(/\r?\n/).filter(line => line && !/already_reported|^nothing to reconcile|running +LOC/.test(line));
  if (lines.length) console.log(`${new Date().toISOString()} ${lines.join(" | ")}`);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
}
