import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deviceOnlyCriteria, validateBlueprint } from "../src/bootstrap.js";
import { PLAN_LIMITS } from "../src/bootstrap-options.js";
import { TEMPLATES } from "../src/bootstrap-templates.js";
// @ts-expect-error plain ESM script shipped as a template file
import { checkUnityHygiene } from "../templates/unity-mobile-2d/scripts/check-unity-hygiene.mjs";

const plan = (...acceptance: string[]) => JSON.stringify({ summary: "s", milestones: [{ key: "M1", title: "Feel", goal: "g", tasks: [{ key: "T1", title: "Haptics", description: "d", acceptance, depends_on: [] }] }] });

describe("criteria only a device can verify", () => {
  it.each([
    "A device run shows feedback starts within 100ms",
    "Measured on a physical Android phone, the frame time stays under 16ms",
    "The build is accepted on the Play Store",
    "Haptics are verified on-device",
    "Using a real device the effects remain readable",
  ])("rejects '%s' in a game plan and says what to write instead", criterion => {
    expect(() => validateBlueprint(plan(criterion), PLAN_LIMITS.normal!, true)).toThrow(/physical device/);
    expect(() => validateBlueprint(plan(criterion), PLAN_LIMITS.normal!, true)).toThrow(/frame count/);
  });
  it("accepts testable proxies, and leaves non-game plans alone", () => {
    expect(() => validateBlueprint(plan("Feedback is requested by the next frame after the swipe", "The platform haptic call is recorded once per merge"), PLAN_LIMITS.normal!, true)).not.toThrow();
    expect(() => validateBlueprint(plan("A device run shows feedback within 100ms"), PLAN_LIMITS.normal!)).not.toThrow();
  });
  it("names the task and the criterion", () => {
    const blueprint = validateBlueprint(plan("Fine criterion"), PLAN_LIMITS.normal!);
    expect(deviceOnlyCriteria(blueprint)).toEqual([]);
    expect(deviceOnlyCriteria({ ...blueprint, milestones: [{ ...blueprint.milestones[0]!, tasks: [{ ...blueprint.milestones[0]!.tasks[0]!, acceptance: ["On a real phone the board is legible"] }] }] })[0]).toContain("T1: On a real phone");
  });
});

describe("the PlayMode gate", () => {
  it("retries a failing test once so a timing flake is reported instead of failing the run", () => {
    const gates = TEMPLATES["unity-mobile-2d"]!.unity!.gates("production", "unit");
    const playMode = gates.find(gate => gate.args.includes("PlayMode"))!;
    expect(playMode.args).toEqual(expect.arrayContaining(["--retries", "1"]));
    expect(gates.find(gate => gate.args.includes("EditMode"))!.args).not.toContain("--retries");
  });
});

describe("hygiene: wall-clock assertions", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function project(testCode: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-wall-")); roots.push(root);
    const put = async (file: string, content: string) => { const full = path.join(root, file); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, content); };
    await put("ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.3.11f1\n");
    await put("ProjectSettings/EditorSettings.asset", "EditorSettings:\n  m_SerializationMode: 2\n");
    await put("Packages/manifest.json", JSON.stringify({ dependencies: { "com.unity.test-framework": "1.6.0" } }));
    await put(".gitignore", "/Library/\n/Temp/\n/Obj/\n/Logs/\n/UserSettings/\n/Builds/\n/.utmp/\n");
    await put("Assets/Tests/PlayMode/SwipeTests.cs", testCode); await put("Assets/Tests/PlayMode/SwipeTests.cs.meta", "x"); await put("Assets/Tests.meta", "x"); await put("Assets/Tests/PlayMode.meta", "x");
    return root;
  }
  it("flags a threshold on real time and passes the same check done in frames", async () => {
    const bad = checkUnityHygiene(await project("class T {\n var shown = Time.realtimeSinceStartup - swiped;\n Assert.Less(shown, 0.1f, \"fast\");\n}"));
    expect((bad.problems as string[]).filter(line => line.startsWith("wall-clock"))).toHaveLength(1);
    expect(bad.problems.join("\n")).toContain("count frames");
    const good = checkUnityHygiene(await project("class T {\n var frames = Time.frameCount - swipedAtFrame;\n Assert.LessOrEqual(frames, 1);\n}"));
    expect((good.problems as string[]).filter(line => line.startsWith("wall-clock"))).toEqual([]);
  });
  it("lets a test that waits for time without asserting on it alone, and accepts an explicit opt-out", async () => {
    const wait = checkUnityHygiene(await project("class T {\n var timeout = Time.realtimeSinceStartup + 10f;\n while (!done && Time.realtimeSinceStartup < timeout) yield return null;\n Assert.IsTrue(done);\n}"));
    expect((wait.problems as string[]).filter(line => line.startsWith("wall-clock"))).toEqual([]);
    const optOut = checkUnityHygiene(await project("class T {\n // Covers: wall-clock-ok startup budget measured on purpose\n var t = Stopwatch.StartNew();\n Assert.Less(t.ElapsedMilliseconds, 5000);\n}"));
    expect((optOut.problems as string[]).filter(line => line.startsWith("wall-clock"))).toEqual([]);
  });
});
