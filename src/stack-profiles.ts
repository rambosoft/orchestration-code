// Stack profiles (docs/engineering/research/unity-game-support.md): the toolchain a project uses is data. `node-web` is the default and keeps today's behaviour; `unity-mobile` adds the Unity CLI.
export const STACK_PROFILE_IDS = ["node-web", "unity-mobile"] as const;
export type StackProfileId = (typeof STACK_PROFILE_IDS)[number];

export const CORE_EXECUTABLES = ["node", "npm", "pnpm", "yarn"] as const;
const STACK_EXECUTABLES: Record<StackProfileId, readonly string[]> = { "node-web": CORE_EXECUTABLES, "unity-mobile": [...CORE_EXECUTABLES, "unity"] };

/**
 * Paths a build or the Editor generates, relative to the repository root, per profile. The publish step keeps such files a run ADDED out of the commit (the first game run committed 757 files of `.utmp/` Android build
 * temp output). Unity folders are anchored at the root so a game folder like Assets/Library/ is never mistaken for the Editor's Library.
 */
const GENERATED_PATHS: Record<StackProfileId, readonly RegExp[]> = {
  "node-web": [],
  "unity-mobile": [/^(?:Library|Temp|Obj|Logs|UserSettings|Builds|MemoryCaptures|Recordings|\.utmp|\.gradle)\//, /\.(?:apk|aab|keystore)$/i, /\.(?:csproj|sln)$/i],
};
export function isGeneratedPath(profile: StackProfileId, repoPath: string): boolean {
  return GENERATED_PATHS[profile].some(pattern => pattern.test(repoPath.split("\\").join("/")));
}

export function allowedExecutables(profile: StackProfileId = "node-web"): readonly string[] { return STACK_EXECUTABLES[profile]; }

type CommandLike = { executable: string; args: string[]; cwd?: string };
const UNITY_VERBS = ["test", "build", "recompile"];
/** Flags that would run another binary, install software, route traffic or hand raw arguments to the Editor. */
const UNITY_FORBIDDEN_FLAG = /^(?:--args|-e|--editor-path|--allow-install|--accelerator|--proxy)(?:=|$)/;
const EXECUTE_METHOD = /^[A-Za-z_][\w.]*\.[A-Za-z_]\w*$/;

/**
 * A Unity command is limited to `unity test|build|recompile` with the CLI's own flags: no `--`, no forwarded Editor arguments, no other editor binary,
 * no installs, paths that stay inside the project, and `--execute-method` only for a method the manifest declares.
 */
export function unityCommandProblem(command: CommandLike, executeMethods: readonly string[] = []): string | undefined {
  const { args, cwd } = command;
  if (args.some(arg => /[\0\r\n]/.test(arg))) return "arguments must not contain control characters";
  const escapes = (value: string) => /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..");
  if (cwd !== undefined && escapes(cwd)) return "cwd must be a relative path inside the repository";
  if (!UNITY_VERBS.includes(args[0] ?? "")) return `unity may only run ${UNITY_VERBS.join(", ")}`;
  if (args.includes("--")) return "raw Editor arguments after `--` are not allowed";
  if (args.some(arg => UNITY_FORBIDDEN_FLAG.test(arg))) return "--args, --editor-path, --allow-install, --accelerator and --proxy are not allowed";
  if (args.some(arg => !arg.startsWith("-") && /[\\/]/.test(arg) && escapes(arg))) return "paths must be relative and stay inside the repository";
  for (const [index, arg] of args.entries()) {
    const inline = /^--execute-method=(.*)$/.exec(arg);
    const method = inline ? inline[1] : arg === "--execute-method" ? args[index + 1] : undefined;
    if (inline || arg === "--execute-method") {
      if (method === undefined || !EXECUTE_METHOD.test(method)) return "--execute-method needs a Class.Method name";
      if (!executeMethods.includes(method)) return `--execute-method ${method} is not declared in stack.unity.executeMethods`;
    }
  }
  return undefined;
}

/** Problems with the commands of one manifest, in terms of its profile. Empty when every command is allowed. */
export function stackCommandProblems(stack: { profile: StackProfileId; unity?: { executeMethods: readonly string[] } } | undefined, commands: Array<{ where: string; command: CommandLike }>): Array<{ where: string; message: string }> {
  const profile = stack?.profile ?? "node-web";
  const allowed = allowedExecutables(profile);
  const problems: Array<{ where: string; message: string }> = [];
  for (const { where, command } of commands) {
    if (!allowed.includes(command.executable)) problems.push({ where, message: `${command.executable} is not allowed for stack profile ${profile} (allowed: ${allowed.join(", ")})` });
    else if (command.executable === "unity") { const problem = unityCommandProblem(command, stack?.unity?.executeMethods ?? []); if (problem) problems.push({ where, message: problem }); }
  }
  return problems;
}

/** Parses `m_EditorVersion: 6000.3.11f1` from ProjectSettings/ProjectVersion.txt. */
export function parseUnityEditorVersion(text: string): string | undefined {
  return /^m_EditorVersion:\s*(\S+)\s*$/m.exec(text)?.[1];
}
