// A failing Unity command must not hide the acceptance trace (ADR 0025): the one repair pass of a task has to see every problem the gate already knows, not the first one only.
// The Unity CLI is replaced by a stub on PATH that exits 1, so the real activity runs its real gate without an Editor.
import { afterEach, describe, expect, it } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeStage } from "../src/activities.js";

// On Windows the variable is called Path; setting only PATH would leave the real Unity CLI first.
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH";
const originalPath = process.env[pathKey];
afterEach(() => { process.env[pathKey] = originalPath; });

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-gate-trace-"));
  await mkdir(path.join(root, "Assets", "Tests", "EditMode"), { recursive: true });
  await writeFile(path.join(root, "Assets", "Tests", "EditMode", "RulesTests.cs"), "// Covers: T9-AC1\n[Test] public void Rule() { Assert.Pass(); }\n");
  const bin = path.join(root, "bin"); await mkdir(bin);
  // Windows only starts .exe files without a shell, so node.exe stands in: `unity test ...` makes node look for a file called test and exit 1.
  if (process.platform === "win32") await copyFile(process.execPath, path.join(bin, "unity.exe"));
  else { await writeFile(path.join(bin, "unity"), "#!/bin/sh\necho simulated failing test >&2\nexit 1\n"); await chmod(path.join(bin, "unity"), 0o755); }
  process.env[pathKey] = `${bin}${path.delimiter}${originalPath ?? ""}`;
  return root;
}
const prompt = "Build the pause screen.\n\nTask id: T9\n\nAcceptance criteria:\n- T9-AC1: the timer stops\n- T9-AC2: the settings open\n";
const input = (root: string) => ({ runId: "gate-trace", taskId: "t", projectId: "p", profile: "implementation", stage: "verify" as const, prompt, attempt: 1, provider: "fake", projectRoot: root, artifactsDir: path.join(root, "artifacts"), plugins: [], verificationOnly: true, qualityCommands: [{ executable: "unity" as const, args: ["test", "--mode", "EditMode"] }] });

describe("quality gate", () => {
  it("reports the missing acceptance test together with the failing Unity command, so one repair pass fixes both", async () => {
    const root = await project();
    try {
      const result = await executeStage(input(root) as never);
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("quality check failed: unity");
      const text = result.findings.join("\n");
      expect(text).toContain("acceptance criteria without a test: T9-AC2");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
