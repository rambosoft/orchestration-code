import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script shipped as a template file
import { checkUnityHygiene } from "../templates/unity-mobile-2d/scripts/check-unity-hygiene.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function put(root: string, file: string, content: string) { const full = path.join(root, file); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, content); }
/** An asset plus its .meta, the way Unity writes them. */
async function asset(root: string, file: string, content: string) { await put(root, file, content); await put(root, `${file}.meta`, "fileFormatVersion: 2\n"); }

async function cleanProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-hygiene-"));
  roots.push(root);
  await put(root, "ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.3.11f1\n");
  await put(root, "ProjectSettings/EditorSettings.asset", "EditorSettings:\n  m_SerializationMode: 2\n  m_ExternalVersionControlSupport: Visible Meta Files\n");
  await put(root, "Packages/manifest.json", JSON.stringify({ dependencies: { "com.unity.test-framework": "1.6.0" } }));
  await put(root, ".gitignore", "/Library/\n/Temp/\n/Obj/\n/Logs/\n/UserSettings/\n/ProjectSettings/PackageManagerSettings.asset\n/Builds/\n/.utmp/\n");
  await put(root, "Assets.meta", "x");
  await asset(root, "Assets/Scripts.meta".replace(".meta", "") + "/Logic/Spike.Logic.asmdef", JSON.stringify({ name: "Spike.Logic", noEngineReferences: true }));
  await asset(root, "Assets/Scripts/Logic/Merge.cs", "namespace Spike { public static class Merge { } }");
  await asset(root, "Assets/Tests/EditMode/Spike.EditTests.asmdef", JSON.stringify({ name: "Spike.EditTests", references: ["UnityEngine.TestRunner"], defineConstraints: ["UNITY_INCLUDE_TESTS"] }));
  await asset(root, "Assets/Tests/EditMode/MergeTests.cs", "// Covers: R-001\npublic class MergeTests { }");
  for (const dir of ["Assets/Scripts", "Assets/Scripts/Logic", "Assets/Tests", "Assets/Tests/EditMode"]) await put(root, `${dir}.meta`, "fileFormatVersion: 2\n");
  return root;
}
const rules = (problems: string[]) => problems.map(line => line.split(":")[0]);

describe("unity hygiene script", () => {
  it("passes a clean project", async () => {
    const result = checkUnityHygiene(await cleanProject());
    expect(result.problems).toEqual([]);
  });

  it("reports a folder that is not a Unity project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-hygiene-")); roots.push(root);
    expect(checkUnityHygiene(root).notUnity).toBe(true);
  });

  it("finds missing and orphan .meta files", async () => {
    const root = await cleanProject();
    await put(root, "Assets/Scripts/NoMeta.cs", "class A {}");
    await put(root, "Assets/Scripts/Gone.cs.meta", "x");
    const problems = checkUnityHygiene(root).problems as string[];
    expect(problems.find(line => line.startsWith("meta-missing"))).toContain("NoMeta.cs");
    expect(problems.find(line => line.startsWith("meta-orphan"))).toContain("Gone.cs.meta");
  });

  it("checks settings, packages and gitignore", async () => {
    const root = await cleanProject();
    await put(root, "ProjectSettings/EditorSettings.asset", "EditorSettings:\n  m_SerializationMode: 1\n  m_ExternalVersionControlSupport: Hidden Meta Files\n");
    await put(root, "Packages/manifest.json", "{\"dependencies\":{}}");
    await put(root, ".gitignore", "/Library/\n");
    const problems = checkUnityHygiene(root).problems as string[];
    expect(rules(problems)).toEqual(expect.arrayContaining(["settings", "packages", "gitignore"]));
    expect(problems.find(line => line.startsWith("gitignore") && line.includes("PackageManagerSettings.asset"))).toBeTruthy();
  });

  it("requires UNITY_INCLUDE_TESTS on test assemblies and flags the duplicate reference combination", async () => {
    const root = await cleanProject();
    await asset(root, "Assets/Tests/PlayMode/Spike.PlayTests.asmdef", JSON.stringify({ name: "Spike.PlayTests", references: ["UnityEngine.TestRunner"], optionalUnityReferences: ["TestAssemblies"] }));
    await put(root, "Assets/Tests/PlayMode.meta", "x");
    const problems = (checkUnityHygiene(root).problems as string[]).filter(line => line.startsWith("asmdef-tests"));
    expect(problems.some(line => line.includes("UNITY_INCLUDE_TESTS"))).toBe(true);
    expect(problems.some(line => line.includes("duplicate reference"))).toBe(true);
  });

  it("keeps the logic assembly free of the engine", async () => {
    const root = await cleanProject();
    await asset(root, "Assets/Scripts/Logic/Spike.Logic.asmdef", JSON.stringify({ name: "Spike.Logic" }));
    await asset(root, "Assets/Scripts/Logic/View.cs", "using UnityEngine;\nclass V {}");
    const problems = (checkUnityHygiene(root).problems as string[]).filter(line => line.startsWith("asmdef-logic"));
    expect(problems).toHaveLength(2);
  });

  it("flags hot-path hazards but not test code", async () => {
    const root = await cleanProject();
    await asset(root, "Assets/Scripts/Hud.cs", "class Hud { void Update() { var x = new Vector3(1,2,3); } }");
    await asset(root, "Assets/Scripts/Loader.cs", "class L { void A() { Resources.Load(\"x\"); } }");
    await asset(root, "Assets/Tests/EditMode/Ok.cs", "class T { void Update() { var x = new Foo(); Resources.Load(\"x\"); } }");
    const problems = (checkUnityHygiene(root).problems as string[]).join("\n");
    expect(problems).toContain("hot-path: Assets/Scripts/Hud.cs");
    expect(problems).toContain("resources: Assets/Scripts/Loader.cs");
    expect(problems).not.toContain("Ok.cs");
  });

  it("traces every rule id of the rules spec to a test", async () => {
    const root = await cleanProject();
    await put(root, "docs/RULES_SPEC.md", "R-001 spawn\nR-002 merge once\n");
    const lenient = checkUnityHygiene(root);
    expect(lenient.problems).toEqual([]);
    expect(lenient.warnings).toHaveLength(1);
    expect(lenient.warnings[0]).toContain("R-002");
    const strict = checkUnityHygiene(root, { strictRules: true });
    expect(strict.problems).toHaveLength(1);
    expect(strict.problems[0]).toContain("R-002");
  });
});
