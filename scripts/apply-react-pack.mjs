#!/usr/bin/env node
// Applies the react-ts-vite standards pack (templates/react-ts-vite, ADR 0034, 0035) to a React + TypeScript + Vite project.
// Usage: node scripts/apply-react-pack.mjs <project folder> --name "App name" [--force] [--install]
// Existing files are never overwritten without --force; package.json scripts are added only when missing. Prints the dev dependencies to install, or installs them with --install.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packDir = path.join(repoRoot, "templates", "react-ts-vite");
const pack = JSON.parse(readFileSync(path.join(packDir, "pack.json"), "utf8"));

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const target = args.find(arg => !arg.startsWith("--") && arg !== option("name"));
if (!target) { console.error('usage: node scripts/apply-react-pack.mjs <project folder> --name "App name" [--force] [--install]'); process.exit(2); }
const root = path.resolve(target);
if (!existsSync(path.join(root, "package.json"))) { console.error(`${root} has no package.json; create the Vite project first`); process.exit(2); }
const name = option("name") ?? JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name ?? "App";

const written = []; const skipped = [];
const put = (relative, content) => {
  const file = path.join(root, relative);
  if (existsSync(file) && !flag("force")) { skipped.push(relative); return; }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  written.push(relative);
};

for (const relative of pack.copy) {
  let text = readFileSync(path.join(packDir, relative), "utf8");
  if (pack.render.includes(relative)) text = text.replaceAll("{{name}}", name);
  put(relative, text);
}
put(pack.standards.to, readFileSync(path.join(repoRoot, pack.standards.from), "utf8"));
const catalog = JSON.parse(readFileSync(path.join(repoRoot, "skills", "catalog.json"), "utf8"));
// Keep this pack's AGENTS.md and CLAUDE.md pointer in sync with STANDARDS_POINTER in src/skills.ts.
for (const skill of catalog.skills.filter(skill => skill.status === "approved" && (skill.areas.includes("any") || skill.areas.includes("react-ts"))).sort((a, b) => a.id.localeCompare(b.id))) {
  const digest = readFileSync(path.resolve(repoRoot, skill.digest), "utf8").trim();
  put(`docs/ai/standards/${skill.id}.md`, `# ${skill.title}\n\n${digest}\n\nSource: ${skill.source.origin} (catalog v${catalog.version})\n`);
}
for (const [relative, text] of Object.entries(pack.seed)) put(relative, text);
for (const directory of pack.directories) {
  const folder = path.join(root, directory);
  if (!existsSync(folder)) put(path.join(directory, ".gitkeep"), "");
}

const packageFile = path.join(root, "package.json");
const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
manifest.scripts ??= {};
const addedScripts = [];
for (const [script, command] of Object.entries(pack.scripts)) if (!(script in manifest.scripts)) { manifest.scripts[script] = command; addedScripts.push(script); }
// A scaffold default the pack supersedes (Vite ships `lint: oxlint`) is replaced; any other existing script is kept.
for (const [script, defaults] of Object.entries(pack.replaceScripts ?? {})) if (defaults.includes(manifest.scripts[script])) { manifest.scripts[script] = pack.scripts[script]; addedScripts.push(`${script} (replaced)`); }
writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);

const main = ["src/main.tsx", "src/main.ts"].map(file => path.join(root, file)).find(existsSync);
if (main) {
  const text = readFileSync(main, "utf8");
  const missing = pack.mainImports.filter(entry => !text.includes(entry));
  if (missing.length) { writeFileSync(main, `${missing.map(entry => `import "${entry}";`).join("\n")}\n${text}`); written.push(`${path.relative(root, main).split(path.sep).join("/")} (imports tokens.css)`); }
}

// A pristine `npm create vite` react-ts starter (its counter demo is still in App.tsx) has raw colours and px in App.css and index.css, which R-015 forbids. Replace the demo
// with a token-only shell, but only when the starter is untouched, so a real app is never rewritten.
const appFile = path.join(root, "src/App.tsx");
if (existsSync(appFile) && /count is|Get started/.test(readFileSync(appFile, "utf8")) && existsSync(path.join(root, "src/App.css")) && existsSync(path.join(root, "src/index.css"))) {
  writeFileSync(appFile, `/** Application shell: replace with the router and the pages in src/pages. */\nexport default function App() {\n  return <main>New project</main>;\n}\n`);
  writeFileSync(path.join(root, "src/index.css"), `/* Global rules use the tokens of ./styles/tokens.css (R-015). */\n#root {\n  min-height: 100vh;\n}\n`);
  for (const file of ["src/App.css", "src/assets/hero.png", "src/assets/react.svg", "src/assets/vite.svg"]) rmSync(path.join(root, file), { force: true });
  written.push("src/App.tsx, src/index.css (Vite starter replaced by a token-only shell)");
  console.log("starter: the untouched Vite counter demo was replaced by a token-only shell (App.css and the starter assets removed)");
}

// The legacy tier (B-114): add the Vite legacy plugin with the targets of docs/ai/device-tiers.json to vite.config.* when it is not there. Only the common one-line
// `plugins: [...]` form is patched; anything else is reported for a manual edit (check:device-tiers fails until it is done).
const tiers = JSON.parse(readFileSync(path.join(packDir, "docs/ai/device-tiers.json"), "utf8"));
const legacyTier = tiers.tiers.find(tier => tier.id === "legacy");
const viteConfig = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].map(file => path.join(root, file)).find(existsSync);
const legacyNotes = [];
if (viteConfig && legacyTier?.vite) {
  const original = readFileSync(viteConfig, "utf8");
  if (original.includes(legacyTier.vite.plugin)) legacyNotes.push("legacy plugin already configured");
  else {
    const call = `legacy({ targets: ${JSON.stringify(legacyTier.vite.targets).replace(/"/g, "'")} })`;
    const plugins = /plugins\s*:\s*\[([^\]\n]*)\]/;
    const imports = [...original.matchAll(/^import .*$/gm)];
    if (!plugins.test(original) || imports.length === 0) legacyNotes.push(`could not patch ${path.basename(viteConfig)}: add \`import legacy from '${legacyTier.vite.plugin}'\` and ${call} to plugins by hand`);
    else {
      const last = imports[imports.length - 1];
      const end = last.index + last[0].length;
      const withImport = `${original.slice(0, end)}\nimport legacy from '${legacyTier.vite.plugin}'${original.slice(end)}`;
      writeFileSync(viteConfig, withImport.replace(plugins, (_all, inner) => `plugins: [${inner.trim() ? `${inner.trim()}, ` : ""}${call}]`));
      written.push(`${path.basename(viteConfig)} (legacy plugin, ${legacyTier.vite.targets.join(", ")})`);
    }
  }
} else if (!viteConfig) legacyNotes.push("no vite.config.* found: add the legacy plugin by hand (docs/ai/device-tiers.json)");

console.log(`pack ${pack.id}: wrote ${written.length}, kept ${skipped.length} existing file(s), added scripts: ${addedScripts.join(", ") || "none"}`);
if (skipped.length) console.log(`kept (use --force to replace): ${skipped.join(", ")}`);
for (const note of legacyNotes) console.log(`legacy tier: ${note}`);
// The AI map's generated block (B-123) must exist and match the project, or check:index fails on a fresh project.
const indexScript = path.join(root, "scripts/generate-ai-index.mjs");
if (existsSync(indexScript)) spawnSync("node", [indexScript, root], { stdio: "inherit" });
const install = ["install", "-D", ...pack.devDependencies];
const removable = (pack.removeDevDependencies ?? []).filter(name => name in (manifest.devDependencies ?? {}));
if (flag("install")) {
  let status = spawnSync("npm", install, { cwd: root, stdio: "inherit", shell: true }).status ?? 1;
  // Scaffold tooling the pack supersedes (Vite ships oxlint) would be reported unused by knip.
  if (status === 0 && removable.length) status = spawnSync("npm", ["uninstall", ...removable], { cwd: root, stdio: "inherit", shell: true }).status ?? 1;
  process.exit(status);
} else console.log(`next: cd ${root} && npm ${install.join(" ")}${removable.length ? ` && npm uninstall ${removable.join(" ")}` : ""}`);
