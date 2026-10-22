import { runAndWait } from "./client.js";
import path from "node:path";
import { resolveProjectUiUx } from "./uiux-config.js";

const root = path.resolve("demo/project");
const uiUx = await resolveProjectUiUx({}, root);
const result = await runAndWait({ taskId: `demo-${Date.now()}`, projectId: "demo-typescript", profile: process.argv[2] ?? "implementation", prompt: process.argv.slice(3).join(" ") || "Review the demo service and describe a small safe change.", provider: process.env.DEMO_PROVIDER === "openrouter" || process.env.DEMO_PROVIDER === "claude" || process.env.DEMO_PROVIDER === "codex" || process.env.DEMO_PROVIDER === "gemini" ? process.env.DEMO_PROVIDER : "fake", projectRoot: root, artifactsDir: path.resolve("data/artifacts/demo"), plugins: [], uiUx: uiUx.config, uiUxFrameworks: uiUx.frameworks });
console.log(JSON.stringify(result, null, 2));
if (result.status !== "completed") process.exitCode = 1;
