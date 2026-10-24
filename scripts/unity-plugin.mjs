// Pins Unity's official agent plugin (Unity-Technologies/unity-agent-plugin) next to the orchestrator: `npm run unity:plugin [-- --update]`.
// The checkout lives in data/unity-agent-plugin (git-ignored) at a fixed commit, so a change upstream never alters a run silently; set UNITY_AGENT_PLUGIN_DIR to it.
// The Unity Companion License covers use in Unity-dependent projects; the plugin is loaded with `claude --plugin-dir` and is never copied into generated repositories.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO = "https://github.com/Unity-Technologies/unity-agent-plugin";
const PIN = process.env.UNITY_AGENT_PLUGIN_REF ?? "3831ddbf8d2f4b7c58d2f53474cfe99b812c77c6";
const dir = path.resolve(process.env.ORCHESTRATOR_DATA_DIR ?? "data", "unity-agent-plugin");
const git = (args, cwd) => { const result = spawnSync("git", args, { cwd, stdio: "inherit" }); if (result.status !== 0) { console.error(`git ${args.join(" ")} failed`); process.exit(1); } };

if (!existsSync(path.join(dir, ".git"))) git(["clone", "--quiet", REPO, dir], process.cwd());
else if (process.argv.includes("--update")) git(["fetch", "--quiet", "origin"], dir);
git(["checkout", "--quiet", "--detach", PIN], dir);
console.log(`Unity agent plugin pinned at ${PIN}\nSet UNITY_AGENT_PLUGIN_DIR=${dir}`);
