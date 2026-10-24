// Unity hygiene gate for agent-built projects. Plain Node, no dependencies: `node scripts/check-unity-hygiene.mjs [projectRoot]`.
// Exit 0 = clean, 1 = problems (one per line on stderr), 2 = not a Unity project. Rules come from the failure modes seen when agents edit Unity projects.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function checkUnityHygiene(root) {
  const problems = [];
  const p = (rule, message) => problems.push(`${rule}: ${message}`);
  const read = file => { try { return readFileSync(join(root, file), "utf8"); } catch { return undefined; } };
  const rel = file => relative(root, file).split(sep).join("/");
  if (!existsSync(join(root, "Assets")) || !existsSync(join(root, "ProjectSettings", "ProjectVersion.txt"))) return { notUnity: true, problems };

  const walk = (dir, visit) => { for (const name of readdirSync(dir)) { const full = join(dir, name); const isDir = statSync(full).isDirectory(); visit(full, name, isDir); if (isDir) walk(full, visit); } };
  const files = []; const dirs = [];
  walk(join(root, "Assets"), (full, name, isDir) => (isDir ? dirs : files).push({ full, name }));

  // meta: every asset and folder has a .meta, every .meta has an asset. Hidden entries and names ending in ~ are ignored by Unity.
  const ignored = name => name.startsWith(".") || name.endsWith("~");
  const has = new Set([...files, ...dirs].map(entry => entry.full));
  for (const entry of [...files, ...dirs]) {
    if (entry.name.endsWith(".meta") || rel(entry.full).split("/").some(ignored)) continue;
    if (!has.has(`${entry.full}.meta`)) p("meta-missing", `${rel(entry.full)} has no .meta file (commit the .meta Unity generated; never hand-write GUIDs)`);
  }
  for (const entry of files) if (entry.name.endsWith(".meta") && !has.has(entry.full.slice(0, -5))) p("meta-orphan", `${rel(entry.full)} has no matching asset`);

  // generated folders must be ignored by git
  const ignore = read(".gitignore") ?? "";
  for (const generated of ["Library", "Temp", "Obj", "Logs", "UserSettings", "Builds"]) {
    if (!new RegExp(`^/?${generated}/?\\s*$`, "m").test(ignore)) p("gitignore", `.gitignore does not ignore ${generated}/`);
  }

  // serialization and meta visibility
  const editorSettings = read("ProjectSettings/EditorSettings.asset");
  if (editorSettings === undefined) p("settings", "ProjectSettings/EditorSettings.asset is missing");
  else {
    if (!/m_SerializationMode:\s*2\b/.test(editorSettings)) p("settings", "asset serialization must be Force Text (m_SerializationMode: 2)");
    if (!/m_ExternalVersionControlSupport:\s*Visible Meta Files/.test(editorSettings)) p("settings", "version control mode must be Visible Meta Files");
  }

  // packages
  const manifest = read("Packages/manifest.json");
  if (manifest === undefined) p("packages", "Packages/manifest.json is missing");
  else if (!/"com\.unity\.test-framework"/.test(manifest)) p("packages", "Packages/manifest.json must declare com.unity.test-framework (the empty template lacks it, tests then fail with CS0246 NUnit)");

  // assembly definitions
  for (const entry of files.filter(file => file.name.endsWith(".asmdef"))) {
    const where = rel(entry.full);
    let json;
    try { json = JSON.parse(readFileSync(entry.full, "utf8")); } catch { p("asmdef", `${where} is not valid JSON`); continue; }
    const refs = [...(json.references ?? []), ...(json.precompiledReferences ?? [])];
    const testy = refs.some(ref => /TestRunner|nunit/i.test(ref));
    if (testy && !(json.defineConstraints ?? []).includes("UNITY_INCLUDE_TESTS")) p("asmdef-tests", `${where}: a test assembly needs defineConstraints ["UNITY_INCLUDE_TESTS"] or the player build compiles it and fails`);
    if (json.optionalUnityReferences?.length && refs.some(ref => /TestRunner/.test(ref))) p("asmdef-tests", `${where}: optionalUnityReferences TestAssemblies together with explicit TestRunner references causes a duplicate reference error`);
    if (/\.Logic$/.test(json.name ?? "")) {
      if (json.noEngineReferences !== true) p("asmdef-logic", `${where}: a *.Logic assembly must set noEngineReferences true so game rules stay unit-testable`);
      const dir = entry.full.slice(0, entry.full.length - entry.name.length);
      for (const cs of files.filter(file => file.full.startsWith(dir) && file.name.endsWith(".cs"))) if (/^\s*using\s+UnityEngine\b/m.test(readFileSync(cs.full, "utf8"))) p("asmdef-logic", `${rel(cs.full)} uses UnityEngine inside a *.Logic assembly`);
    }
  }

  // C# hazards an agent tends to introduce
  for (const entry of files.filter(file => file.name.endsWith(".cs"))) {
    const text = readFileSync(entry.full, "utf8"); const where = rel(entry.full);
    const isTest = /(^|\/)Tests?\//.test(where);
    if (!isTest && /\bResources\.Load\b/.test(text)) p("resources", `${where} uses Resources.Load; load assets through serialized references`);
    if (!isTest && /\bFind(?:ObjectOfType|ObjectsOfType|ObjectOfTypeAny)\b|GameObject\.Find(?:WithTag)?\(/.test(text) && /\bvoid\s+Update\s*\(/.test(text)) p("hot-path", `${where} calls a Find API in a class with Update(); cache the reference`);
    if (!isTest && /\bvoid\s+Update\s*\([^)]*\)\s*\{[^}]*\bnew\s+(?!WaitFor)[A-Z]\w*\s*[(\[<]/.test(text)) p("hot-path", `${where} allocates with new inside Update(); pool or reuse`);
  }

  // rule traceability: every rule id of the rules spec appears in a test file
  const spec = read("docs/RULES_SPEC.md");
  if (spec !== undefined) {
    const ids = [...new Set(spec.match(/\bR-\d{3}\b/g) ?? [])];
    const tests = files.filter(file => file.name.endsWith(".cs") && /(^|\/)Tests?\//.test(rel(file.full))).map(file => readFileSync(file.full, "utf8")).join("\n");
    for (const id of ids) if (!tests.includes(id)) p("rule-trace", `${id} from docs/RULES_SPEC.md is not referenced by any test (add "Covers: ${id}" to the test that proves it)`);
  }
  return { notUnity: false, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { notUnity, problems } = checkUnityHygiene(process.argv[2] ?? process.cwd());
  if (notUnity) { console.error("not a Unity project (Assets/ or ProjectSettings/ProjectVersion.txt missing)"); process.exit(2); }
  if (problems.length) { for (const line of problems) console.error(line); console.error(`${problems.length} hygiene problem(s)`); process.exit(1); }
  console.log("unity hygiene clean");
}
