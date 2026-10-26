import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectReviewDigest, reviewPromptWithDigest } from "../src/activities.js";
import { buildDigest, classifyFile, parseNumstat, trimFileDiff, type FileChange } from "../src/diff-digest.js";
import type { StackInfo } from "../src/stack-traits.js";
import { runCommand } from "../src/workspaces.js";

const UNITY: StackInfo = [{ family: "unity", root: "" }];
const change = (file: string, added = 5, removed = 1, binary = false): FileChange => ({ path: file, added, removed, binary });
const fileDiff = (file: string, lines = 3) => `diff --git a/${file} b/${file}\nindex 111..222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,${lines} @@\n${Array.from({ length: lines }, (_, index) => `+line ${index} of ${file}`).join("\n")}\n`;

describe("parseNumstat", () => {
  it("reads counts, binary files and renames", () => {
    expect(parseNumstat("12\t3\tsrc/a.ts\n-\t-\tArt/logo.png\n1\t0\tsrc/{old => new}/b.ts\n0\t4\tx.cs => y.cs\n\nnot a line\n")).toEqual([
      { path: "src/a.ts", added: 12, removed: 3, binary: false }, { path: "Art/logo.png", added: 0, removed: 0, binary: true },
      { path: "src/new/b.ts", added: 1, removed: 0, binary: false }, { path: "y.cs", added: 0, removed: 4, binary: false },
    ]);
  });
});

describe("classifyFile", () => {
  it("sorts files of every supported stack into reviewable and not reviewable kinds", () => {
    const kinds = (file: string, stack: StackInfo = UNITY, binary = false) => classifyFile(change(file, 1, 1, binary), stack);
    expect(kinds("Assets/Scripts/Rules.cs")).toBe("source");
    expect(kinds("Assets/Tests/EditMode/RulesTests.cs")).toBe("test");
    expect(kinds("server/src/main/java/com/x/Order.java", [{ family: "jvm", root: "server" }])).toBe("source");
    expect(kinds("server/src/test/java/com/x/OrderTest.java", [{ family: "jvm", root: "server" }])).toBe("test");
    expect(kinds("server/src/main/resources/application.yml", [{ family: "jvm", root: "server" }])).toBe("config");
    expect(kinds("docs/PLAN.md")).toBe("doc");
    expect(kinds("Assets/Scenes/Main.unity")).toBe("asset");
    expect(kinds("Assets/Art/logo.png")).toBe("binary");
    expect(kinds("Assets/Art/data.bin", UNITY, true)).toBe("binary");
    expect(kinds("Assets/Scripts/Rules.cs.meta")).toBe("meta");
    expect(kinds("Packages/packages-lock.json")).toBe("lock");
    expect(kinds("web/dist/app.min.js")).toBe("noise");
    expect(kinds(".utmp/RelWithDebInfo/x/gen.c")).toBe("generated");
    expect(kinds("server/target/classes/Order.class", [{ family: "jvm", root: "server" }])).toBe("generated");
    expect(kinds("notes.weird")).toBe("other");
  });
});

describe("trimFileDiff", () => {
  it("drops git header noise and cuts a long diff at a line boundary with a note", () => {
    expect(trimFileDiff(fileDiff("a.ts", 2), 1000)).toEqual({ text: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n+line 0 of a.ts\n+line 1 of a.ts", cut: false });
    const cut = trimFileDiff(fileDiff("a.ts", 200), 400);
    expect(cut.cut).toBe(true);
    expect(cut.text).toMatch(/\[\.\.\. \d+ more lines of this file's diff left out: read the file\]$/);
    expect(cut.text.length).toBeLessThan(520);
  });
});

describe("buildDigest", () => {
  const read = async (file: string) => fileDiff(file);
  it("shows source before tests before config before docs, whatever the alphabetical order", async () => {
    const digest = await buildDigest({ stack: UNITY, readDiff: read, changes: [change("docs/A.md"), change("config/a.json"), change("Assets/Tests/ATests.cs"), change("Assets/Scripts/Z.cs"), change(".utmp/x/a.c")] });
    expect(digest.shown).toEqual(["Assets/Scripts/Z.cs", "Assets/Tests/ATests.cs", "config/a.json", "docs/A.md"]);
    expect(digest.text.indexOf("### Assets/Scripts/Z.cs")).toBeLessThan(digest.text.indexOf("### Assets/Tests/ATests.cs"));
  });
  it("counts generated and binary files in the header instead of printing them, and says generated output is a finding", async () => {
    const generated = Array.from({ length: 300 }, (_, index) => change(`.utmp/RelWithDebInfo/x/f${index}.o`, 0, 0, true));
    const digest = await buildDigest({ stack: UNITY, readDiff: read, changes: [change("Assets/Scripts/Rules.cs"), change("Art/logo.png", 0, 0, true), change("Assets/A.cs.meta"), ...generated] });
    expect(digest.text).toContain("Not reviewable and left out: 1 binary, 1 meta, 300 generated");
    expect(digest.text).toContain("300 generated build file(s) are part of this change");
    expect(digest.text).not.toContain("f17.o");
    expect(digest.text).toContain("### Assets/Scripts/Rules.cs");
  });
  it("summarises scenes and prefabs without reading them", async () => {
    let reads = 0;
    const digest = await buildDigest({ stack: UNITY, readDiff: async file => { reads++; return fileDiff(file); }, changes: [change("Assets/Scenes/Main.unity", 4000, 10), change("Assets/Scripts/A.cs")] });
    expect(reads).toBe(1);
    expect(digest.text).toContain("Assets/Scenes/Main.unity +4000 -10 (generated YAML scene/asset data: summary only");
  });
  it("stays inside the budget, lists what did not fit, and cuts one huge file instead of dropping the rest", async () => {
    const big = async (file: string) => fileDiff(file, file.includes("Big") ? 3000 : 20);
    const digest = await buildDigest({ stack: UNITY, readDiff: big, budget: { total: 3000, perFile: { source: 1500, test: 1500, config: 500, doc: 500, other: 500 } }, changes: [change("Assets/Big.cs", 3000), ...Array.from({ length: 8 }, (_, index) => change(`Assets/S${index}.cs`, 20))] });
    expect(digest.text.length).toBeLessThan(3000 + 1500);
    expect(digest.text).toContain("Not shown because the size budget is used up");
    expect(digest.shown.length).toBeGreaterThan(1);
    expect(digest.omitted.length).toBeGreaterThan(0);
  });
  it("on a follow-up round lists a file the repair did not touch as unchanged and shows the one it did", async () => {
    const first = await buildDigest({ stack: UNITY, readDiff: read, changes: [change("Assets/A.cs"), change("Assets/B.cs")] });
    const second = await buildDigest({ stack: UNITY, previous: first.hashes, changes: [change("Assets/A.cs"), change("Assets/B.cs")], readDiff: async file => file.endsWith("B.cs") ? `${fileDiff(file)}+fixed\n` : fileDiff(file) });
    expect(second.shown).toEqual(["Assets/B.cs"]);
    expect(second.text).toContain("Unchanged since the previous review round (not repeated):\n- Assets/A.cs +5 -1");
    expect(second.text).not.toContain("### Assets/A.cs");
  });
});

describe("collectReviewDigest on a real repository", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  async function repo() {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-digest-")); dirs.push(root);
    const artifacts = await mkdtemp(path.join(os.tmpdir(), "orch-digest-art-")); dirs.push(artifacts);
    await runCommand("git", ["init", "-b", "main"], root);
    await mkdir(path.join(root, "ProjectSettings"), { recursive: true }); await mkdir(path.join(root, "Assets", "Scripts"), { recursive: true });
    await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.11f1\n");
    await writeFile(path.join(root, "Assets", "Scripts", "Menu.cs"), "class Menu {}\n");
    await runCommand("git", ["add", "--all"], root);
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"], root);
    return { root, artifacts };
  }
  const stageAll = (root: string) => runCommand("git", ["add", "--intent-to-add", "--all"], root);

  it("shows the code even when build output that sorts first would have filled a 60 000 character window (the first game's reviews)", async () => {
    const { root, artifacts } = await repo();
    await mkdir(path.join(root, ".utmp", "RelWithDebInfo", "x"), { recursive: true });
    for (let index = 0; index < 120; index++) await writeFile(path.join(root, ".utmp", "RelWithDebInfo", "x", `f${index}.json`), `{"n":${index}}\n`.repeat(800));
    await writeFile(path.join(root, "Assets", "Scripts", "Menu.cs"), "class Menu { void Continue() { /* wired */ } }\n");
    await stageAll(root);
    const digest = await collectReviewDigest(root, artifacts, 1);
    expect(digest.text).toContain("### Assets/Scripts/Menu.cs");
    expect(digest.text).toContain("Continue() { /* wired */ }");
    expect(digest.text).toContain("120 generated build file(s) are part of this change");
    expect(digest.text.length).toBeLessThan(8000);
    expect(reviewPromptWithDigest("TASK", digest.text)).toContain("TASK\n\nImplementation under review");
  });
  it("sends the same digest on a retry of the same round and only the changed files on the next round", async () => {
    const { root, artifacts } = await repo();
    await writeFile(path.join(root, "Assets", "Scripts", "Menu.cs"), "class Menu { int a; }\n");
    await writeFile(path.join(root, "Assets", "Scripts", "Shop.cs"), "class Shop {}\n");
    await stageAll(root);
    const first = await collectReviewDigest(root, artifacts, 1);
    expect((await collectReviewDigest(root, artifacts, 1)).text).toBe(first.text);
    await writeFile(path.join(root, "Assets", "Scripts", "Menu.cs"), "class Menu { int a; int b; }\n");
    const second = await collectReviewDigest(root, artifacts, 2);
    expect(second.shown).toEqual(["Assets/Scripts/Menu.cs"]);
    expect(second.text).toContain("Unchanged since the previous review round (not repeated):\n- Assets/Scripts/Shop.cs");
    expect(JSON.parse(await readFile(path.join(artifacts, "review-diff-2.json"), "utf8")).hashes["Assets/Scripts/Menu.cs"]).toBeTruthy();
  });
  it("works for a repository with no recognised stack", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-digest-plain-")); dirs.push(root);
    const artifacts = await mkdtemp(path.join(os.tmpdir(), "orch-digest-art-")); dirs.push(artifacts);
    await runCommand("git", ["init", "-b", "main"], root);
    await writeFile(path.join(root, "a.py"), "x = 1\n");
    await runCommand("git", ["add", "--all"], root);
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"], root);
    await writeFile(path.join(root, "a.py"), "x = 2\n");
    expect((await collectReviewDigest(root, artifacts, 1)).text).toContain("### a.py");
  });
});
