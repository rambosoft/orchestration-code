import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeStage } from "../src/activities.js";
import { coverageTable } from "../src/acceptance.js";
import { PREFILTER_ALLOW, prefilterEnabled, prefilterFindings, prefilterProblem } from "../src/review-prefilter.js";
import { runCommand } from "../src/workspaces.js";

const diffOf = (file: string, ...added: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${added.length} @@\n${added.map(line => `+${line}`).join("\n")}\n`;

describe("prefilterFindings", () => {
  it("finds unfinished markers, stubs and placeholder copy in the lines a change adds to source files", () => {
    const findings = prefilterFindings([
      diffOf("Assets/Scripts/Runtime/Menu.cs", "    // TODO wire the Continue button", "    throw new System.NotImplementedException();", "    label.text = \"Coming soon\";"),
      diffOf("src/shop.ts", "  // FIXME total ignores shipping", "  const title = 'Lorem ipsum dolor';"),
    ].join(""));
    expect(findings.map(finding => `${finding.file}:${finding.rule}`)).toEqual([
      "Assets/Scripts/Runtime/Menu.cs:unfinished-marker", "Assets/Scripts/Runtime/Menu.cs:not-implemented-stub", "Assets/Scripts/Runtime/Menu.cs:placeholder-copy",
      "src/shop.ts:unfinished-marker", "src/shop.ts:placeholder-copy",
    ]);
  });
  it("finds skipped and assertion-free tests, but only in test files", () => {
    const findings = prefilterFindings([
      diffOf("Assets/Tests/PlayMode/MenuTests.cs", "    [Ignore(\"flaky\")]", "    Assert.Pass();"),
      diffOf("test/shop.test.ts", "  it.skip('totals', () => {});", "  xit('x', () => {});"),
      diffOf("Assets/Scripts/Runtime/Menu.cs", "    Assert.Pass();", "    // [Ignore] attribute docs"),
    ].join(""));
    expect(findings.map(finding => `${finding.file}:${finding.rule}`)).toEqual([
      "Assets/Tests/PlayMode/MenuTests.cs:skipped-test", "Assets/Tests/PlayMode/MenuTests.cs:assertion-free-pass",
      "test/shop.test.ts:skipped-test", "test/shop.test.ts:skipped-test",
    ]);
  });
  it("never blames existing code, documents or data files, and honours the allow token", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n // TODO old context line\n-// TODO removed\n+const fine = 1;\n",
      diffOf("docs/PLAN.md", "- TODO write the plan"), diffOf("data/items.json", "\"note\": \"TODO\""), diffOf("Assets/Scenes/Main.unity.meta", "TODO"),
      diffOf("src/b.ts", `// TODO(#123) tracked in the backlog ${PREFILTER_ALLOW}`),
    ].join("");
    expect(prefilterFindings(diff)).toEqual([]);
  });
  it("never judges generated build output of the Unity profile (the first game committed .utmp/ with C sources and logs)", () => {
    const diff = [diffOf(".utmp/RelWithDebInfo/x/arm64-v8a/gen.c", "/* TODO generated */"), diffOf("Library/Bee/log.txt", "FIXME"), diffOf("Builds/notes.log", "coming soon"), diffOf("Assets/Scripts/Menu.cs", "// TODO real")].join("");
    expect(prefilterFindings(diff, [{ family: "unity", root: "" }]).map(finding => finding.file)).toEqual(["Assets/Scripts/Menu.cs"]);
    expect(prefilterFindings(diff).map(finding => finding.file)).toContain(".utmp/RelWithDebInfo/x/arm64-v8a/gen.c");
  });
  it("is clean for an empty or malformed diff", () => {
    expect(prefilterFindings("")).toEqual([]);
    expect(prefilterFindings("+ TODO but no file header")).toEqual([]);
  });
  it("words the repair prompt with the evidence, the escape hatch and the rule about tests", () => {
    const problem = prefilterProblem(prefilterFindings(diffOf("src/a.ts", "// TODO finish")))!;
    expect(problem).toContain("src/a.ts: unfinished-marker: // TODO finish");
    expect(problem).toContain(PREFILTER_ALLOW);
    expect(problem).toContain("Never skip, ignore or weaken a test");
    expect(prefilterProblem([])).toBeUndefined();
    const many = prefilterProblem(Array.from({ length: 15 }, (_, index) => ({ file: `f${index}`, rule: "unfinished-marker", text: "TODO" })))!;
    expect(many).toContain("(3 more)");
  });
  it("can be switched off", () => {
    expect(prefilterEnabled({})).toBe(true);
    expect(prefilterEnabled({ ORCHESTRATOR_PREFILTER: "0" })).toBe(false);
  });
});

describe("coverageTable", () => {
  const files = [
    { file: "Assets/Tests/EditMode/RulesTests.cs", text: "using NUnit;\n// Covers: T3-AC1, R-002\n[Test] public void Merges() {}\n" },
    { file: "Assets/Tests/PlayMode/MenuTests.cs", text: "// Deferred: T3-AC3 -> T8 the store comes later\n// Covers: T3-AC2\n" },
  ];
  it("lists the test that covers each criterion, the deferred ones and the uncovered ones", () => {
    const table = coverageTable(["T3-AC1", "T3-AC2", "T3-AC3", "T3-AC4"], files)!;
    expect(table).toContain("- T3-AC1: Assets/Tests/EditMode/RulesTests.cs:2");
    expect(table).toContain("- T3-AC2: Assets/Tests/PlayMode/MenuTests.cs:2");
    expect(table).toContain("- T3-AC3: deferred to T8");
    expect(table).toContain("- T3-AC4: NOT COVERED by any test");
    expect(table).toContain("judge whether each listed test really proves");
  });
  it("is undefined when there are no numbered criteria", () => {
    expect(coverageTable([], files)).toBeUndefined();
  });
});

describe("verify activity prefilter", () => {
  const dirs: string[] = [];
  afterEach(async () => { delete process.env.ORCHESTRATOR_PREFILTER; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  async function repo() {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-prefilter-")); dirs.push(root);
    const artifacts = await mkdtemp(path.join(os.tmpdir(), "orch-prefilter-art-")); dirs.push(artifacts);
    await runCommand("git", ["init", "-b", "main"], root);
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await runCommand("git", ["add", "--all"], root);
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"], root);
    const verify = (attempt = 1) => executeStage({ runId: "r", taskId: "t", projectId: "p", profile: "implementation", stage: "verify", prompt: "task", attempt, provider: "fake", plugins: [], verificationOnly: true, projectRoot: root, artifactsDir: artifacts, qualityCommands: [{ executable: "node", args: ["-e", "process.exit(0)"] }] });
    return { root, verify };
  }

  it("fails the verification, with the evidence, when the change adds a TODO", async () => {
    const { root, verify } = await repo();
    await writeFile(path.join(root, "b.ts"), "// TODO connect the button\nexport const b = 2;\n");
    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("quality check failed: review-prefilter");
    expect(result.findings.join("\n")).toContain("b.ts: unfinished-marker: // TODO connect the button");
  });
  it("passes a clean change, and a TODO that carries the allow token, and ignores one in a document", async () => {
    const { root, verify } = await repo();
    await writeFile(path.join(root, "b.ts"), `export const b = 2; // TODO(#9) later ${PREFILTER_ALLOW}\n`);
    await writeFile(path.join(root, "NOTES.md"), "TODO write the notes\n");
    expect((await verify()).ok).toBe(true);
  });
  it("is skipped when switched off", async () => {
    process.env.ORCHESTRATOR_PREFILTER = "0";
    const { root, verify } = await repo();
    await writeFile(path.join(root, "b.ts"), "// TODO connect the button\n");
    expect((await verify()).ok).toBe(true);
  });
});
