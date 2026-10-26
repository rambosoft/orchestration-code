import { describe, expect, it } from "vitest";
import { ProjectManifestSchema } from "../src/contracts.js";
import { reproductionCommandProblem } from "../src/bug.js";
import { allowedExecutables, parseUnityEditorVersion, stackCommandProblems, unityCommandProblem } from "../src/stack-profiles.js";

const base = { id: "demo-project", name: "Demo", root: "demo", defaultProfile: "implementation" };
const unityStack = { profile: "unity-mobile", unity: { editorVersion: "6000.3.11f1", executeMethods: ["Builder.Android"] } };

describe("stack profiles", () => {
  it("keeps node-web as the default and only allows the core executables there", () => {
    expect(allowedExecutables()).toEqual(["node", "npm", "pnpm", "yarn"]);
    expect(allowedExecutables("unity-mobile")).toContain("unity");
    expect(ProjectManifestSchema.parse(base).stack).toBeUndefined();
    expect(ProjectManifestSchema.parse({ ...base, qualityCommands: [{ executable: "npm", args: ["test"] }] }).qualityCommands).toHaveLength(1);
  });

  it("rejects unity commands unless the manifest uses the unity-mobile profile", () => {
    const withoutStack = ProjectManifestSchema.safeParse({ ...base, qualityCommands: [{ executable: "unity", args: ["test", "--mode", "EditMode"] }] });
    expect(withoutStack.success).toBe(false);
    expect(JSON.stringify(withoutStack.error?.issues)).toContain("not allowed for stack profile node-web");
    const nodeStack = ProjectManifestSchema.safeParse({ ...base, stack: { profile: "node-web" }, qualityCommandsByProfile: { bug: [{ executable: "unity", args: ["test"] }] } });
    expect(nodeStack.success).toBe(false);
    expect(nodeStack.error?.issues[0]?.path).toEqual(["qualityCommandsByProfile", "bug", 0, "executable"]);
  });

  it("accepts the Unity CLI gates for unity-mobile and defaults the unity block", () => {
    const parsed = ProjectManifestSchema.parse({ ...base, stack: unityStack, qualityCommands: [
      { executable: "unity", args: ["test", "--mode", "EditMode", "--output", "Logs/edit.xml"] },
      { executable: "unity", args: ["build", "--target", "Android", "--execute-method", "Builder.Android"], severity: "warn" },
      { executable: "node", args: ["scripts/check-unity-hygiene.mjs"] },
    ] });
    expect(parsed.stack?.profile).toBe("unity-mobile");
    expect(ProjectManifestSchema.parse({ ...base, stack: { profile: "unity-mobile" } }).stack?.unity.executeMethods).toEqual([]);
  });

  it("rejects an invalid editor version, an invalid executeMethods entry and an unknown profile", () => {
    expect(ProjectManifestSchema.safeParse({ ...base, stack: { profile: "unity-mobile", unity: { editorVersion: "latest" } } }).success).toBe(false);
    expect(ProjectManifestSchema.safeParse({ ...base, stack: { profile: "unity-mobile", unity: { executeMethods: ["rm -rf"] } } }).success).toBe(false);
    expect(ProjectManifestSchema.safeParse({ ...base, stack: { profile: "godot" } }).success).toBe(false);
  });
});

describe("unityCommandProblem", () => {
  const problem = (args: string[], methods: string[] = []) => unityCommandProblem({ executable: "unity", args }, methods);

  it("allows test, build and recompile with the CLI's own flags", () => {
    expect(problem(["test", "--mode", "PlayMode", "--filter", "Merge", "--timeout", "600"])).toBeUndefined();
    expect(problem(["build", "--target", "Android", "--android-export-type", "aab", "-o", "Builds/app.aab"])).toBeUndefined();
    expect(problem(["recompile"])).toBeUndefined();
  });

  it.each([
    [["run", "--command", "x"], "may only run"],
    [["install", "6000.3.11f1"], "may only run"],
    [[], "may only run"],
    [["test", "--", "-executeMethod", "Evil.Run"], "after `--`"],
    [["test", "--editor-path", "C:/evil/Unity.exe"], "not allowed"],
    [["test", "-e", "C:/evil/Unity.exe"], "not allowed"],
    [["build", "--args", "-executeMethod Evil.Run"], "not allowed"],
    [["test", "--allow-install"], "not allowed"],
    [["test", "--output", "../outside.xml"], "relative"],
    [["test", "--output", "C:/Windows/x.xml"], "relative"],
    [["test", "bad\nline"], "control characters"],
  ])("rejects %j", (args, message) => {
    expect(problem(args as string[])).toContain(message);
  });

  it("only accepts --execute-method for a declared method, in both spellings", () => {
    expect(problem(["build", "--target", "Android", "--execute-method", "Builder.Android"], ["Builder.Android"])).toBeUndefined();
    expect(problem(["build", "--execute-method=Builder.Android"], ["Builder.Android"])).toBeUndefined();
    expect(problem(["build", "--execute-method", "Builder.Android"])).toContain("not declared");
    expect(problem(["build", "--execute-method=Other.Method"], ["Builder.Android"])).toContain("not declared");
    expect(problem(["build", "--execute-method", "not a method"], ["Builder.Android"])).toContain("Class.Method");
    expect(problem(["build", "--execute-method"], ["Builder.Android"])).toContain("Class.Method");
  });

  it("reports every offending command with its location", () => {
    const problems = stackCommandProblems({ profile: "unity-mobile", unity: { executeMethods: [] } }, [
      { where: "a", command: { executable: "unity", args: ["test"] } },
      { where: "b", command: { executable: "unity", args: ["install"] } },
      { where: "c", command: { executable: "python", args: ["x.py"] } },
    ]);
    expect(problems.map(item => item.where)).toEqual(["b", "c"]);
  });
});

describe("related guards", () => {
  it("parses the editor version from ProjectVersion.txt", () => {
    expect(parseUnityEditorVersion("m_EditorVersion: 6000.3.11f1\nm_EditorVersionWithRevision: 6000.3.11f1 (3000ef702840)\n")).toBe("6000.3.11f1");
    expect(parseUnityEditorVersion("nothing here")).toBeUndefined();
  });

  it("does not accept the Unity CLI as a model-chosen reproduction command", () => {
    expect(reproductionCommandProblem({ executable: "unity", args: ["test"] })).toContain("not supported");
    expect(reproductionCommandProblem({ executable: "npm", args: ["test"] })).toBeUndefined();
  });
});
