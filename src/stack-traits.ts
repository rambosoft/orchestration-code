// What the orchestrator knows about the technology a repository uses, found from the repository itself (marker files), not from a project setting. A project can hold several stacks at once
// (a Unity client with a Spring Boot server next to it), so detection returns every family with the folder it lives in, and each rule below is a table entry per family: supporting a new stack
// means adding one row, not touching the gates. Used by the publish guard (generated output), the review digest, the review prefilter and the log compactor's callers.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export type Family = "unity" | "node" | "jvm" | "dotnet" | "python" | "go" | "rust";
/** One stack found in the repository: its family and the folder it lives in, relative to the repository root ("" for the root). */
export type StackInfo = Array<{ family: Family; root: string }>;

const MARKERS: Record<Family, RegExp> = {
  unity: /^ProjectSettings$/,
  node: /^package\.json$/,
  jvm: /^(pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts)$/,
  dotnet: /\.(csproj|fsproj|sln|slnx)$/,
  python: /^(pyproject\.toml|requirements\.txt|setup\.py|setup\.cfg|Pipfile)$/,
  go: /^go\.mod$/,
  rust: /^Cargo\.toml$/,
};
const SKIP_DIRS = /^(node_modules|\.git|\.hg|\.svn|Library|Temp|Obj|Logs|Builds|target|build|dist|out|bin|obj|vendor|__pycache__|\.venv|venv|\.gradle|\.idea|\.vs)$/;

function familiesIn(dir: string): Family[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const found = (Object.keys(MARKERS) as Family[]).filter(family => names.some(name => MARKERS[family].test(name)));
  // Unity generates .csproj/.sln files for its own scripts: a Unity project is not also a .NET project.
  const unity = found.includes("unity") && existsSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"));
  return found.filter(family => family !== "unity" || unity).filter(family => !(unity && family === "dotnet"));
}

/** Every stack in the repository: the root plus its direct sub-folders (server/, client/, backend/, apps/…), so a monorepo reports each part. */
export function detectStack(root: string): StackInfo {
  const stack: StackInfo = familiesIn(root).map(family => ({ family, root: "" }));
  let children: string[] = [];
  try { children = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.test(entry.name)).map(entry => entry.name); } catch { /* an unreadable folder has no stacks */ }
  for (const child of children) for (const family of familiesIn(path.join(root, child))) if (!stack.some(item => item.family === family && item.root === "")) stack.push({ family, root: child });
  return stack;
}

/**
 * Paths a build or tool generates, per family, relative to the family's folder. Certain, not "usually": the publish step drops what a run adds under these, so a folder that real projects
 * commit on purpose (vendor/, a hand-written dist/) is not listed. Digest-only noise is in NOISY below.
 */
const GENERATED: Record<Family, RegExp[]> = {
  unity: [/^(?:Library|Temp|Obj|Logs|UserSettings|Builds|MemoryCaptures|Recordings|\.utmp|\.gradle)\//, /\.(?:apk|aab|keystore|csproj|sln)$/i],
  node: [/(?:^|\/)(?:node_modules|coverage|\.next|\.nuxt|\.turbo|\.parcel-cache|storybook-static)\//, /\.tsbuildinfo$/],
  jvm: [/(?:^|\/)(?:target|\.gradle|out)\//, /(?:^|\/)build\/(?:classes|libs|tmp|reports|generated|resources|kotlin|test-results|distributions)\//, /\.(?:class|war|ear)$/],
  dotnet: [/(?:^|\/)(?:bin|obj)\//, /\.user$/],
  python: [/(?:^|\/)(?:__pycache__|\.venv|venv|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox)\//, /(?:^|\/)[^/]+\.egg-info\//, /\.pyc$/],
  go: [],
  rust: [/(?:^|\/)target\//],
};
export function isGeneratedPath(stack: StackInfo, repoPath: string): boolean {
  const file = repoPath.split("\\").join("/");
  return stack.some(({ family, root }) => {
    if (root && !file.startsWith(`${root}/`)) return false;
    const relative = root ? file.slice(root.length + 1) : file;
    return GENERATED[family].some(pattern => pattern.test(relative));
  });
}

/** Files that are clutter in a review whatever the stack: lock files, minified bundles, source maps, build folders that projects sometimes commit. Shown as counts, never as diffs. */
const NOISY = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|packages-lock\.json|Gemfile\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|gradle\.lockfile|composer\.lock)$|\.min\.(?:js|css)$|\.map$|(?:^|\/)(?:dist|build)\/|\.snap$/i;
export const isNoisyPath = (repoPath: string): boolean => NOISY.test(repoPath.split("\\").join("/"));

/** Test files by the conventions of every supported family (a folder, a suffix or a prefix). */
const TEST_FILE = [
  /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e)\//i, /\/src\/(?:test|it|integrationTest|androidTest)\//i, /(?:^|\/)Tests\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/, /(?:Test|Tests|IT|Spec)\.(?:java|kt|scala|cs|groovy)$/, /(?:^|\/)test_[^/]+\.py$/, /_test\.(?:py|go|rs)$/,
];
export const isTestFile = (repoPath: string): boolean => TEST_FILE.some(pattern => pattern.test(repoPath.split("\\").join("/")));
export const isDocFile = (repoPath: string): boolean => /(?:^|\/)(?:docs?|openspec)\/|\.(?:md|mdx|txt|rst|csv|svg)$/i.test(repoPath.split("\\").join("/"));

/**
 * Commands the implementing agent may run, per family, on top of the base set every project gets (node, npm, npx, read-only git, ls). A build tool runs project code just as an npm script does, and
 * the same gates run these tools anyway; what a family needs is listed here so a Spring Boot or .NET project is not blocked by a list written for Unity and Node.
 */
const AGENT_COMMANDS: Record<Family, string[]> = {
  unity: ["unity"],
  node: ["pnpm", "yarn"],
  jvm: ["mvn", "./mvnw", "mvnw", "gradle", "./gradlew", "gradlew", "java"],
  dotnet: ["dotnet"],
  python: ["python", "python3", "pytest"],
  go: ["go"],
  rust: ["cargo"],
};
export const agentCommands = (stack: StackInfo): string[] => [...new Set(stack.flatMap(({ family }) => AGENT_COMMANDS[family]))];
