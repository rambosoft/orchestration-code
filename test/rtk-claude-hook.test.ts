import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acceptRewrite, claudeHookSettings, hookJson, REWRITE_ALLOWED, runHook } from "../src/rtk-claude-hook.js";
import { claudeExecutionArgs, rtkHookScript } from "../src/providers.js";

const payload = (command: unknown, tool = "Bash") => JSON.stringify({ tool_name: tool, tool_input: { command }, hook_event_name: "PreToolUse" });
const rtkInstalled = spawnSync("rtk", ["--version"], { windowsHide: true }).status === 0;
const thisFile = fileURLToPath(import.meta.url);

describe("acceptRewrite", () => {
  it("passes on the rewrites of build, test and version-control commands of every stack", () => {
    for (const [original, rewritten] of [["git status", "rtk git status"], ["mvn test", "rtk mvn test"], ["./gradlew build", "rtk gradlew build"], ["pytest -q", "rtk pytest -q"], ["go test ./...", "rtk go test ./..."], ["cargo build", "rtk cargo build"], ["dotnet build", "rtk dotnet build"], ["npx vitest run", "rtk vitest"], ["npx tsc --noEmit", "rtk tsc --noEmit"], ["cd server && mvn test", "cd server && rtk mvn test"], ["git status && npm run build", "rtk git status && rtk npm run build"]] as const) expect(acceptRewrite(original, rewritten), original).toBe(rewritten);
  });
  it("drops every rewrite that would filter a file read, a search or a listing, even inside a compound command", () => {
    for (const [original, rewritten] of [["cat src/a.ts", "rtk read src/a.ts"], ["grep -rn foo src", "rtk grep -rn foo src"], ["rg foo", "rtk rg foo"], ["find . -name x", "rtk find . -name x"], ["ls -la", "rtk ls -la"], ["cd x && cat a.ts", "cd x && rtk read a.ts"], ["git status && cat a.ts", "rtk git status && rtk read a.ts"], ["curl x", "rtk wget x"]] as const) expect(acceptRewrite(original, rewritten), original).toBeUndefined();
    expect(REWRITE_ALLOWED.has("read")).toBe(false);
    expect(REWRITE_ALLOWED.has("grep")).toBe(false);
  });
  it("ignores a missing, unchanged, multi-line or rtk-free rewrite", () => {
    expect(acceptRewrite("git status", undefined)).toBeUndefined();
    expect(acceptRewrite("git status", "git status")).toBeUndefined();
    expect(acceptRewrite("git status", "rtk git status\nrm -rf x")).toBeUndefined();
    expect(acceptRewrite("git status", "echo hello")).toBeUndefined();
  });
});

describe("runHook", () => {
  const rewrite = (command: string): string | undefined => command === "git status" ? "rtk git status" : command === "cat a.ts" ? "rtk read a.ts" : undefined;
  it("answers with RTK's own hook JSON for an accepted rewrite, for the Bash and the PowerShell tool", () => {
    for (const tool of ["Bash", "PowerShell"]) {
      const out = JSON.parse(runHook(payload("git status", tool), rewrite)) as { hookSpecificOutput: { hookEventName: string; updatedInput: { command: string } } };
      expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput.updatedInput.command).toBe("rtk git status");
    }
    expect(hookJson("rtk git status")).toBe(runHook(payload("git status"), rewrite));
  });
  it("says nothing (the command runs as written) for a refused rewrite, an unknown command, another tool and bad input", () => {
    expect(runHook(payload("cat a.ts"), rewrite)).toBe("");
    expect(runHook(payload("npm test"), rewrite)).toBe("");
    expect(runHook(payload("git status", "Read"), rewrite)).toBe("");
    expect(runHook(payload(42), rewrite)).toBe("");
    expect(runHook(payload("   "), rewrite)).toBe("");
    expect(runHook("not json", rewrite)).toBe("");
    expect(runHook("", rewrite)).toBe("");
  });
  it("never throws when RTK itself fails", () => {
    expect(runHook(payload("git status"), () => { throw new Error("rtk crashed"); })).toBe("");
  });
  it.skipIf(!rtkInstalled)("works with the real rtk: shortens git and builds, leaves reads and searches alone", () => {
    expect(JSON.parse(runHook(payload("git status"))).hookSpecificOutput.updatedInput.command).toBe("rtk git status");
    expect(JSON.parse(runHook(payload("mvn test"))).hookSpecificOutput.updatedInput.command).toBe("rtk mvn test");
    expect(runHook(payload("cat src/stack-traits.ts"))).toBe("");
    expect(runHook(payload("grep -rn foo src"))).toBe("");
    expect(runHook(payload("unity test --mode EditMode"))).toBe("");
  });
});

describe("settings for one Claude run", () => {
  it("registers the hook on the Bash and PowerShell tools with a quoted node command", () => {
    const settings = JSON.parse(claudeHookSettings("C:/Program Files/orch/dist/src/rtk-claude-hook.js", "C:/Program Files/nodejs/node.exe")) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } };
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]!.matcher).toBe("Bash|PowerShell");
    expect(settings.hooks.PreToolUse[0]!.hooks[0]).toEqual({ type: "command", command: '"C:/Program Files/nodejs/node.exe" "C:/Program Files/orch/dist/src/rtk-claude-hook.js"' });
  });
  it("hands the settings to the Claude CLI for any stage, and passes nothing when there are none", () => {
    const settings = '{"enabledPlugins":{"x@y":false}}';
    for (const stage of ["implement", "reproduce", "review", "plan"] as const) {
      const args = claudeExecutionArgs("go", stage, {}, undefined, undefined, [], settings);
      expect(args[args.indexOf("--settings") + 1], stage).toBe(settings);
    }
    expect(claudeExecutionArgs("go", "implement", {})).not.toContain("--settings");
  });
  it("offers the hook script only when it is built and ORCHESTRATOR_RTK_HOOK is not 0", () => {
    expect(rtkHookScript({}, thisFile)).toBe(thisFile);
    expect(rtkHookScript({}, "C:/definitely/not/here.js")).toBeUndefined();
    expect(rtkHookScript({ ORCHESTRATOR_RTK_HOOK: "0" }, thisFile)).toBeUndefined();
  });
});
