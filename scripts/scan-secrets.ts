// Scans tracked files for secret-looking content and credential file names using the same patterns as the publish guard.
// Test fixtures and the knowledge base (which quote patterns) are skipped. Run: npm run scan:secrets
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SECRET_CONTENT, SENSITIVE_PATH } from "../src/publish-guard.js";

const SKIP = [/^test\//, /^docs\/engineering\//, /(^|\/)package-lock\.json$/, /\.(png|jpg|gif|ico|woff2?)$/i];
// A tracked .npmrc is fine unless it carries credentials.
const CONTENT_CHECKED_PATH = /(^|\/)\.npmrc$/;
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const findings: string[] = [];
for (const file of files) {
  if (SKIP.some(pattern => pattern.test(file))) continue;
  let text: string | undefined;
  try { text = readFileSync(file, "utf8"); } catch { text = undefined; }
  if (CONTENT_CHECKED_PATH.test(file)) { if (text !== undefined && /_auth|_password|_authToken/i.test(text)) findings.push(`${file}: contains registry credentials`); continue; }
  if (SENSITIVE_PATH.some(pattern => pattern.test(file))) { findings.push(`${file}: credential or vendored-dependency path`); continue; }
  if (text === undefined) continue;
  text.split(/\r?\n/).forEach((line, index) => { if (SECRET_CONTENT.some(pattern => pattern.test(line))) findings.push(`${file}:${index + 1}: content matches a secret pattern`); });
}
if (findings.length) { console.error(findings.join("\n")); process.exit(1); }
console.log(`secret scan passed (${files.length} tracked files)`);
