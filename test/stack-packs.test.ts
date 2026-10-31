// Stack packs (ADR 0017): an existing repository of any supported stack becomes a valid, gated project manifest in one step. The fixtures are the smallest repositories each pack recognises.
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectManifestSchema } from "../src/contracts.js";
import { detectStackProfile, onboardManifest } from "../src/stack-packs.js";
import { STACK_PROFILE_IDS, allowedExecutables, stackCommandProblems } from "../src/stack-profiles.js";

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-pack-")); dirs.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
const pkg = (deps: Record<string, string>, scripts: Record<string, string>) => JSON.stringify({ name: "x", dependencies: deps, scripts });
const commands = (manifest: Record<string, unknown>) => (manifest.qualityCommands as Array<{ executable: string; args: string[]; severity?: string; report?: unknown }>).map(c => `${c.executable} ${c.args.join(" ")}${c.severity ? ` (${c.severity})` : ""}`);

describe("detectStackProfile", () => {
  it("recognises each supported stack from the repository itself", async () => {
    expect(detectStackProfile(await repo({ "package.json": pkg({ react: "19" }, { build: "vite build" }) }))).toBe("react-ts");
    expect(detectStackProfile(await repo({ "angular.json": "{}", "package.json": pkg({}, {}) }))).toBe("angular");
    expect(detectStackProfile(await repo({ "package.json": pkg({ "@angular/core": "20" }, {}) }))).toBe("angular");
    expect(detectStackProfile(await repo({ "pom.xml": "<parent><artifactId>spring-boot-starter-parent</artifactId></parent>" }))).toBe("spring-boot");
    expect(detectStackProfile(await repo({ "build.gradle.kts": 'plugins { id("org.springframework.boot") version "3.4.0" }' }))).toBe("spring-boot");
    expect(detectStackProfile(await repo({ "package.json": pkg({ express: "5" }, {}) }))).toBe("node-web");
    expect(detectStackProfile(await repo({ "Assets/.keep": "", "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.11f1\n" }))).toBe("unity-mobile");
  });
  it("returns nothing for a repository no pack knows, and prefers the server over the web client in one repository", async () => {
    expect(detectStackProfile(await repo({ "README.md": "hi" }))).toBeUndefined();
    expect(detectStackProfile(await repo({ "pom.xml": "<artifactId>spring-boot-starter</artifactId>", "package.json": pkg({ react: "19" }, {}) }))).toBe("spring-boot");
  });
});

describe("onboardManifest", () => {
  const base = { name: "My App", tier: "prototype" as const };
  it("builds a React manifest from the repository's own scripts, in watch-free form", async () => {
    const root = await repo({ "README.md": "x", "package.json": pkg({ react: "19" }, { lint: "eslint .", test: "vitest", build: "vite build" }) });
    const prototype = onboardManifest({ root, ...base }).manifest;
    expect(commands(prototype)).toEqual(["npm run build"]);
    const mvp = onboardManifest({ root, ...base, tier: "mvp" }).manifest;
    expect(commands(mvp)).toEqual(["npm run lint (warn)", "npm test -- --run", "npm run build"]);
    expect(mvp).toMatchObject({ id: "my-app", tier: "mvp", stack: { profile: "react-ts" }, defaultProfile: "implementation", providerRouting: { implement: { provider: "claude" }, review: { provider: "codex" } } });
    expect(ProjectManifestSchema.safeParse(mvp).success).toBe(true);
  });
  it("makes an Angular test run once instead of watching, and uses the lock file's package manager", async () => {
    const root = await repo({ "angular.json": "{}", "pnpm-lock.yaml": "", "package.json": pkg({ "@angular/core": "20" }, { test: "ng test", build: "ng build" }) });
    expect(commands(onboardManifest({ root, ...base, tier: "mvp" }).manifest)).toEqual(["pnpm test -- --watch=false --browsers=ChromeHeadless", "pnpm run build"]);
  });
  it("reads Spring Boot failures from the JUnit reports of Maven or Gradle", async () => {
    const maven = onboardManifest({ root: await repo({ "pom.xml": "<artifactId>spring-boot-starter-parent</artifactId>" }), ...base, tier: "mvp" }).manifest;
    expect(commands(maven)).toEqual(["mvn -B -q test", "mvn -B -q -DskipTests package"]);
    expect((maven.qualityCommands as Array<{ report?: unknown }>)[0]!.report).toEqual({ format: "junit", path: "target/surefire-reports/TEST-*.xml" });
    const gradle = onboardManifest({ root: await repo({ "build.gradle": "plugins { id 'org.springframework.boot' }" }), ...base, tier: "mvp" }).manifest;
    expect((gradle.qualityCommands as Array<{ report?: unknown }>)[0]!.report).toEqual({ format: "junit", path: "build/test-results/test/TEST-*.xml" });
    expect(ProjectManifestSchema.safeParse(maven).success && ProjectManifestSchema.safeParse(gradle).success).toBe(true);
  });
  it("onboards a Unity project with its editor version and the Unity gates", async () => {
    const root = await repo({ "Assets/.keep": "", "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.11f1\n" });
    const { manifest, notes } = onboardManifest({ root, ...base });
    expect(manifest.stack).toMatchObject({ profile: "unity-mobile", unity: { editorVersion: "6000.3.11f1" } });
    expect(commands(manifest)[0]).toContain("unity test --mode EditMode");
    expect(notes.join(" ")).toContain("check-unity-hygiene");
  });
  it("refuses a repository it cannot gate, with the reason", async () => {
    expect(() => onboardManifest({ root: path.join(os.tmpdir(), "orch-pack-does-not-exist"), ...base })).toThrow(/does not exist/);
    const noScripts = await repo({ "package.json": pkg({ react: "19" }, {}) });
    expect(() => onboardManifest({ root: noScripts, ...base })).toThrow(/no quality gate/);
    const unknown = await repo({ "README.md": "x" });
    expect(() => onboardManifest({ root: unknown, ...base })).toThrow(/no stack pack recognises/);
    expect(() => onboardManifest({ root: unknown, ...base, tier: "bogus" as never })).toThrow(/tier must be/);
  });
});

describe("stack profile tools", () => {
  it("allows Maven and Gradle only for Spring Boot and Unity only for Unity", () => {
    expect(allowedExecutables("spring-boot")).toEqual(expect.arrayContaining(["mvn", "gradle"]));
    for (const profile of STACK_PROFILE_IDS.filter(id => id !== "spring-boot")) expect(allowedExecutables(profile)).not.toContain("mvn");
    expect(stackCommandProblems({ profile: "react-ts" }, [{ where: "gate", command: { executable: "mvn", args: ["test"] } }])).toHaveLength(1);
    expect(stackCommandProblems({ profile: "spring-boot" }, [{ where: "gate", command: { executable: "mvn", args: ["test"] } }])).toHaveLength(0);
    expect(stackCommandProblems({ profile: "spring-boot" }, [{ where: "gate", command: { executable: "unity", args: ["test"] } }])).toHaveLength(1);
  });
});
