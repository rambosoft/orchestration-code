// Foreground view of the reconcile service: `npm run reconcile:watch`. The worker already runs the same loop (src/reconcile-service.ts); use this to watch it or on a machine without the worker.
// Reads the tokens from .env (never printed) and starts `dist/src/cli.js reconcile-watch`.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const env = { ...process.env };
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = /^(PAPERCLIP_API_TOKEN|PAPERCLIP_API_URL|ORCHESTRATOR_API_TOKEN|ORCHESTRATOR_BRIDGE_URL|ORCHESTRATOR_DATA_DIR|TEMPORAL_ADDRESS)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].trim().replace(/^"|"$/g, "");
  }
}
const seconds = process.argv.includes("--seconds") ? process.argv[process.argv.indexOf("--seconds") + 1] : undefined;
if (seconds) env.ORCHESTRATOR_RECONCILE_SECONDS = seconds;
spawn(process.execPath, ["dist/src/cli.js", "reconcile-watch"], { env, stdio: "inherit" }).on("exit", code => process.exit(code ?? 1));
