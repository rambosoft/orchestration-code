import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectStack, isDocFile, isGeneratedPath, isNoisyPath, isTestFile, type StackInfo } from "../src/stack-traits.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function tree(files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-stack-")); dirs.push(root);
  for (const file of files) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), "x"); }
  return root;
}

describe("detectStack", () => {
  it("finds each family from its marker files", async () => {
    expect(detectStack(await tree(["package.json"]))).toEqual([{ family: "node", root: "" }]);
    expect(detectStack(await tree(["pom.xml"]))).toEqual([{ family: "jvm", root: "" }]);
    expect(detectStack(await tree(["build.gradle.kts", "settings.gradle.kts"]))).toEqual([{ family: "jvm", root: "" }]);
    expect(detectStack(await tree(["pyproject.toml"]))).toEqual([{ family: "python", root: "" }]);
    expect(detectStack(await tree(["go.mod"]))).toEqual([{ family: "go", root: "" }]);
    expect(detectStack(await tree(["Cargo.toml"]))).toEqual([{ family: "rust", root: "" }]);
    expect(detectStack(await tree(["App/App.csproj"]))).toEqual([{ family: "dotnet", root: "App" }]);
    expect(detectStack(await tree(["README.md"]))).toEqual([]);
  });
  it("recognises a Unity project by its version file, and does not call it a .NET project because Unity generates .csproj files", async () => {
    const stack = detectStack(await tree(["ProjectSettings/ProjectVersion.txt", "Assembly-CSharp.csproj", "Game.sln"]));
    expect(stack).toEqual([{ family: "unity", root: "" }]);
    expect(detectStack(await tree(["ProjectSettings/other.asset"]))).toEqual([]);
  });
  it("reports every part of a monorepo with its folder: a Unity client next to a Spring Boot server", async () => {
    const stack = detectStack(await tree(["client/ProjectSettings/ProjectVersion.txt", "server/pom.xml", "server/src/main/java/A.java", "web/package.json", "node_modules/x/package.json", "server/target/classes/A.class"]));
    expect(stack).toEqual(expect.arrayContaining([{ family: "unity", root: "client" }, { family: "jvm", root: "server" }, { family: "node", root: "web" }]));
    expect(stack).toHaveLength(3);
  });
});

describe("isGeneratedPath", () => {
  const unity: StackInfo = [{ family: "unity", root: "" }];
  it("lists the Unity Editor and build output at the project root and nowhere in Assets", () => {
    for (const generated of [".utmp/RelWithDebInfo/a/b.json", "Library/Bee/x.dll", "Temp/UnityLockfile", "Logs/screenshots/a.png", "Builds/game.aab", "UserSettings/x.asset", "release/app.aab", "keys/up.keystore", "Game.csproj", "Library\\Bee\\x.dll"]) expect(isGeneratedPath(unity, generated), generated).toBe(true);
    for (const source of ["Assets/Scripts/Game.cs", "Assets/Library/Cards.cs", "Assets/Builds/readme.md", "ProjectSettings/ProjectSettings.asset", "Packages/manifest.json", "docs/Library/notes.md"]) expect(isGeneratedPath(unity, source), source).toBe(false);
  });
  it("lists JVM build output but not the Gradle wrapper jar or sources", () => {
    const jvm: StackInfo = [{ family: "jvm", root: "" }];
    for (const generated of ["target/classes/A.class", "build/classes/java/main/A.class", "build/libs/app.jar", "build/test-results/test/TEST-A.xml", ".gradle/caches/x", "out/production/A.class", "A.class"]) expect(isGeneratedPath(jvm, generated), generated).toBe(true);
    for (const source of ["src/main/java/A.java", "gradle/wrapper/gradle-wrapper.jar", "src/main/resources/build/info.txt", "pom.xml", "build.gradle"]) expect(isGeneratedPath(jvm, source), source).toBe(false);
  });
  it("lists Node, .NET, Python and Rust output, and only inside the folder of a monorepo part", () => {
    expect(isGeneratedPath([{ family: "node", root: "" }], "node_modules/x/index.js")).toBe(true);
    expect(isGeneratedPath([{ family: "node", root: "" }], "coverage/lcov.info")).toBe(true);
    expect(isGeneratedPath([{ family: "node", root: "" }], "src/index.ts")).toBe(false);
    expect(isGeneratedPath([{ family: "dotnet", root: "" }], "bin/Debug/App.dll")).toBe(true);
    expect(isGeneratedPath([{ family: "python", root: "" }], "pkg/__pycache__/a.cpython-312.pyc")).toBe(true);
    expect(isGeneratedPath([{ family: "python", root: "" }], "pkg/a.py")).toBe(false);
    expect(isGeneratedPath([{ family: "rust", root: "" }], "target/debug/app")).toBe(true);
    const monorepo: StackInfo = [{ family: "unity", root: "client" }, { family: "jvm", root: "server" }];
    expect(isGeneratedPath(monorepo, "server/target/classes/A.class")).toBe(true);
    expect(isGeneratedPath(monorepo, "client/Library/Bee/x.dll")).toBe(true);
    expect(isGeneratedPath(monorepo, "Library/x")).toBe(false);
    expect(isGeneratedPath(monorepo, "target/classes/A.class")).toBe(false);
    expect(isGeneratedPath(monorepo, "client/target/x")).toBe(false);
  });
  it("lists nothing when no stack was detected, so an unknown project loses no file", () => {
    expect(isGeneratedPath([], "Library/x.dll")).toBe(false);
    expect(isGeneratedPath([], "target/classes/A.class")).toBe(false);
  });
});

describe("file conventions", () => {
  it("knows the test file conventions of every family", () => {
    for (const test of ["test/shop.test.ts", "src/a.spec.tsx", "Assets/Tests/EditMode/RulesTests.cs", "server/src/test/java/com/x/OrderServiceTest.java", "src/main/kotlin/AuthIT.kt", "tests/test_orders.py", "pkg/orders_test.go", "tests/integration.rs", "e2e/login.ts"]) expect(isTestFile(test), test).toBe(true);
    for (const source of ["src/shop.ts", "Assets/Scripts/Rules.cs", "src/main/java/com/x/OrderService.java", "pkg/orders.go", "latest/notes.ts"]) expect(isTestFile(source), source).toBe(false);
  });
  it("knows documents and noise (lock files, minified bundles, build folders)", () => {
    expect(isDocFile("docs/PLAN.md")).toBe(true);
    expect(isDocFile("src/a.ts")).toBe(false);
    for (const noisy of ["package-lock.json", "Packages/packages-lock.json", "web/yarn.lock", "go.sum", "dist/app.min.js", "public/app.js.map", "build/out.txt", "src/__snapshots__/a.snap"]) expect(isNoisyPath(noisy), noisy).toBe(true);
    expect(isNoisyPath("src/build.ts")).toBe(false);
  });
});
