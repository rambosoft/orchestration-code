// Fails when tracked source files contain stray control characters (e.g. a backspace left by a mangled "\b" escape).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const files = execFileSync("git", ["ls-files", "--", "src", "test", "scripts", "docs", "*.md", "*.json", "*.yml", "*.yaml"], { encoding: "utf8" }).split("\n").filter(Boolean);
let bad = 0;
for (const file of files) {
  let text; try { text = readFileSync(file, "utf8"); } catch { continue; }
  const match = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(text);
  if (match) { bad++; console.error(`${file}: control character U+${match[0].charCodeAt(0).toString(16).padStart(4, "0")} at offset ${match.index}`); }
}
if (bad) process.exit(1);
console.log(`control-character check passed (${files.length} files)`);
