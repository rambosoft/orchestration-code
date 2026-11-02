#!/usr/bin/env node
// Applies the react-ts-vite standards pack (templates/react-ts-vite, ADR 0034, 0035) to a React + TypeScript + Vite project.
// Usage: node scripts/apply-react-pack.mjs <project folder> --name "App name" [--force] [--install]
// Existing files are never overwritten without --force; package.json scripts are added only when missing. Prints the dev dependencies to install, or installs them with --install.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);

const main = ["src/main.tsx", "src/main.ts"].map(file => path.join(root, file)).find(existsSync);
if (main) {
  const text = readFileSync(main, "utf8");
  const missing = pack.mainImports.filter(entry => !text.includes(entry));
  if (missing.length) { writeFileSync(main, `${missing.map(entry => `import "${entry}";`).join("\n")}\n${text}`); written.push(`${path.relative(root, main).split(path.sep).join("/")} (imports tokens.css)`); }
}

console.log(`pack ${pack.id}: wrote ${written.length}, kept ${skipped.length} existing file(s), added scripts: ${addedScripts.join(", ") || "none"}`);
if (skipped.length) console.log(`kept (use --force to replace): ${skipped.join(", ")}`);
const install = ["install", "-D", ...pack.devDependencies];
if (flag("install")) {
  const result = spawnSync("npm", install, { cwd: root, stdio: "inherit", shell: true });
  process.exit(result.status ?? 1);
} else console.log(`next: cd ${root} && npm ${install.join(" ")}`);
