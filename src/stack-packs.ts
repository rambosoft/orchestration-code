// Stack packs (ADR 0017): what the orchestrator knows about running a task on an existing repository of a given stack. Each pack finds out which profile a repository is, and builds the project
// manifest for it: the quality gates (from the repository's own scripts or build file), the test report to read failures from, and the allowed tools. `npm run onboard` uses it to register an
// existing project in one command, at the tier the operator chooses. A new stack is one entry in PACKS plus a fixture in test/stack-packs.test.ts.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BOOTSTRAP_CONFIG } from "./bootstrap.js";
import { unityGates } from "./bootstrap-templates.js";
import { ProjectManifestSchema, type QualityCommand } from "./contracts.js";
import { TIERS, type Tier } from "./lanes.js";
import { parseUnityEditorVersion, type StackProfileId } from "./stack-profiles.js";
import { detectStack } from "./stack-traits.js";

export type TestDepth = "smoke" | "unit" | "integration";
type Repo = { root: string; read: (file: string) => string | undefined; has: (file: string) => boolean };
type Pack = {
  label: string;
  /** Lower number is checked first. */
  priority: number;
  matches: (repo: Repo) => boolean;
  gates: (repo: Repo, depth: TestDepth, tier: Tier) => { gates: QualityCommand[]; notes: string[] };
  uiUx: boolean;
};

const repoAt = (root: string): Repo => ({ root, read: file => { try { return readFileSync(path.join(root, file), "utf8"); } catch { return undefined; } }, has: file => existsSync(path.join(root, file)) });
const packageJson = (repo: Repo): { scripts: Record<string, string>; deps: Record<string, string> } | undefined => {
  const text = repo.read("package.json"); if (!text) return undefined;
  try { const json = JSON.parse(text) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }; return { scripts: json.scripts ?? {}, deps: { ...json.dependencies, ...json.devDependencies } }; } catch { return undefined; }
};

/** The package manager the repository's lock file names; npm when none. */
const packageManager = (repo: Repo): "npm" | "pnpm" | "yarn" => repo.has("pnpm-lock.yaml") ? "pnpm" : repo.has("yarn.lock") ? "yarn" : "npm";

/** A test script must end on its own: a watch mode would hang the gate until its timeout. */
function nonInteractiveTest(script: string): string[] {
  if (/\bng test\b/.test(script)) return ["--", "--watch=false", "--browsers=ChromeHeadless"];
  if (/react-scripts test/.test(script)) return ["--", "--watchAll=false"];
  if (/^\s*vitest\s*$/.test(script)) return ["--", "--run"];
  if (/^\s*jest\s*$/.test(script)) return ["--", "--watchAll=false"];
  return [];
}

function nodeGates(repo: Repo, depth: TestDepth): { gates: QualityCommand[]; notes: string[] } {
  const pkg = packageJson(repo); const notes: string[] = [];
  if (!pkg) return { gates: [], notes: ["package.json could not be read"] };
  const exe = packageManager(repo);
  const run = (name: string, extra: string[] = [], severity?: "warn"): QualityCommand => ({ executable: exe, args: name === "test" ? ["test", ...extra] : ["run", name, ...extra], ...(severity ? { severity } : {}) });
  const gates: QualityCommand[] = [];
  if (pkg.scripts.lint && depth !== "smoke") gates.push(run("lint", [], "warn"));
  if (pkg.scripts.typecheck && depth !== "smoke") gates.push(run("typecheck"));
  if (pkg.scripts.test && (depth !== "smoke" || !pkg.scripts.build)) gates.push(run("test", nonInteractiveTest(pkg.scripts.test)));
  if (pkg.scripts.build) gates.push(run("build"));
  if (!pkg.scripts.test) notes.push("package.json has no test script: the gates only build; add tests before relying on them");
  return { gates, notes };
}

const PACKS: Record<StackProfileId, Pack> = {
  "unity-mobile": {
    label: "Unity project", priority: 0, uiUx: false,
    matches: repo => repo.has("Assets") && repo.has("ProjectSettings/ProjectVersion.txt"),
    gates: (_repo, depth, tier) => ({ gates: unityGates(tier === "throwaway" ? "prototype" : tier, depth), notes: ["Unity tasks need the hygiene script (scripts/check-unity-hygiene.mjs) in the repository; copy it from templates/unity-mobile-2d/scripts/ if it is missing"] }),
  },
  "spring-boot": {
    label: "Spring Boot (Maven or Gradle)", priority: 1, uiUx: false,
    matches: repo => /spring-boot/.test(repo.read("pom.xml") ?? "") || /org\.springframework\.boot|spring-boot/.test(`${repo.read("build.gradle") ?? ""}${repo.read("build.gradle.kts") ?? ""}`),
    gates: (repo, depth) => {
      const maven = repo.has("pom.xml");
      const tool = maven ? "mvn" as const : "gradle" as const;
      const report = maven ? { format: "junit" as const, path: "target/surefire-reports/TEST-*.xml" } : { format: "junit" as const, path: "build/test-results/test/TEST-*.xml" };
      const test: QualityCommand = { executable: tool, args: maven ? ["-B", "-q", "test"] : ["test", "--console=plain"], report };
      const build: QualityCommand = { executable: tool, args: maven ? ["-B", "-q", "-DskipTests", "package"] : ["build", "-x", "test", "--console=plain"] };
      return { gates: depth === "smoke" ? [build] : [test, build], notes: ["The system Maven or Gradle is used (a ./mvnw or ./gradlew wrapper is a path and cannot be a quality command); install it on the worker, and give the project its JDK"] };
    },
  },
  angular: {
    label: "Angular", priority: 2, uiUx: true,
    matches: repo => repo.has("angular.json") || Boolean(packageJson(repo)?.deps["@angular/core"]),
    gates: (repo, depth) => nodeGates(repo, depth),
  },
  "react-ts": {
    label: "React", priority: 3, uiUx: true,
    matches: repo => Boolean(packageJson(repo)?.deps.react),
    gates: (repo, depth) => nodeGates(repo, depth),
  },
  "node-web": {
    label: "Node.js", priority: 4, uiUx: false,
    matches: repo => repo.has("package.json"),
    gates: (repo, depth) => nodeGates(repo, depth),
  },
};

/** The profile of a repository, or undefined when no pack recognises it. Several stacks in one repository: the first by priority wins and the others are reported by onboardManifest. */
export function detectStackProfile(root: string): StackProfileId | undefined {
  const repo = repoAt(root);
  return (Object.entries(PACKS) as Array<[StackProfileId, Pack]>).sort((a, b) => a[1].priority - b[1].priority).find(([, pack]) => pack.matches(repo))?.[0];
}

export type OnboardInput = { root: string; name: string; tier: Tier; id?: string; remote?: string; targetBranch?: string; profile?: StackProfileId; testDepth?: TestDepth };
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/**
 * The manifest for an existing repository: routing from the bootstrap defaults (Claude implements, Codex does the rest), the tier the operator chose, the pack's gates and the stack profile.
 * Throws when the repository is not recognised or no quality gate can be derived, because a code task without a deterministic check cannot be verified.
 */
export function onboardManifest(input: OnboardInput): { manifest: Record<string, unknown>; notes: string[] } {
  if (!TIERS.includes(input.tier)) throw new Error(`tier must be one of ${TIERS.join(", ")}`);
  const root = path.resolve(input.root);
  if (!existsSync(root)) throw new Error(`${root} does not exist`);
  const profile = input.profile ?? detectStackProfile(root);
  if (!profile) throw new Error(`no stack pack recognises ${root}; pass --profile ${Object.keys(PACKS).join("|")} if it is one of them`);
  const pack = PACKS[profile]; const repo = repoAt(root);
  const depth = input.testDepth ?? (input.tier === "throwaway" || input.tier === "prototype" ? "smoke" : input.tier === "mvp" ? "unit" : "integration");
  const { gates, notes } = pack.gates(repo, depth, input.tier);
  if (gates.length === 0) throw new Error(`no quality gate could be derived for ${pack.label} in ${root}: ${notes.join("; ") || "add a test or build script"}`);
  const others = detectStack(root).filter(item => item.root !== "").map(item => `${item.family} in ${item.root}/`);
  if (others.length) notes.push(`other stacks found in sub-folders (${others.join(", ")}); this manifest gates the root only`);
  const base = path.basename(root); const id = input.id ?? slug(input.name);
  const defaults = DEFAULT_BOOTSTRAP_CONFIG.manifest;
  const editorVersion = parseUnityEditorVersion(repo.read("ProjectSettings/ProjectVersion.txt") ?? "");
  const manifest: Record<string, unknown> = {
    id, aliases: [], name: input.name, root: base, containerRoot: `${defaults.containerProjectsRoot}/${base}`,
    repository: { remote: input.remote ?? "origin", targetBranch: input.targetBranch ?? defaults.targetBranch, requiredSourcePaths: repo.has("README.md") ? ["README.md"] : [] },
    defaultProfile: "implementation", tier: input.tier,
    openSpec: { enabled: false }, analysis: { enabled: false, docsDir: "docs/analysis" },
    providers: defaults.providers, providerRouting: defaults.providerRouting, providerTimeouts: defaults.providerTimeouts,
    stack: profile === "unity-mobile" ? { profile, unity: { ...(editorVersion ? { editorVersion } : {}), executeMethods: [] } } : { profile },
    qualityCommands: gates,
    uiUx: { enabled: pack.uiUx, autoSelect: true, include: [], exclude: [] },
    policy: { maxReviewRounds: input.tier === "production" ? 3 : input.tier === "mvp" ? 2 : 1, maxParallelism: 1, requireApprovalBeforeMerge: false },
  };
  ProjectManifestSchema.parse(manifest);
  notes.unshift(`${pack.label} recognised; ${gates.length} quality gate(s) at test depth ${depth}`);
  notes.push(`place the repository at ${defaults.containerProjectsRoot}/${base} for the bridge (or set ORCHESTRATOR_PROJECTS_ROOT on the worker) and restart the bridge to load the manifest`);
  return { manifest, notes };
}
