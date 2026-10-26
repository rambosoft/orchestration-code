// Failures from a test report instead of from the console. Console output of a failing run is the largest and noisiest thing an agent is handed; the report holds the same failures as a short list
// (name, message, trace). Two formats cover the supported stacks: NUnit XML (Unity, .NET) and JUnit XML (Maven and Gradle for Spring Boot, pytest --junitxml, Jest/Vitest reporters, Go and Rust
// converters). A gate command declares its report in the manifest (`report: { format, path }`); Unity's is found from the command itself.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { compactLog } from "./log-compact.js";

export type TestFailure = { name: string; message: string; trace: string };
export type ReportFormat = "nunit" | "junit";
export type ReportSpec = { format: ReportFormat; path: string };
export type ReportSummary = { failures: TestFailure[]; failed: number; total?: number };

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
const decode = (text: string): string => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(?:lt|gt|amp|quot|apos);/g, entity => ENTITIES[entity] ?? entity).replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
const attribute = (tag: string, name: string): string | undefined => { const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return match ? decode(match[1]!) : undefined; };
const inner = (xml: string, element: string): string => { const match = new RegExp(`<${element}\\b[^>]*>([\\s\\S]*?)</${element}>`).exec(xml); return match ? decode(match[1]!).trim() : ""; };

/** NUnit 3 XML: every <test-case> whose result is Failed or Error, plus a suite that failed by itself (a broken setup) before running any case. */
export function parseNUnit(xml: string): ReportSummary {
  const run = /<test-run\b[^>]*>/.exec(xml)?.[0] ?? "";
  const failures: TestFailure[] = [];
  const add = (tag: string, failure: string): void => { failures.push({ name: attribute(tag, "fullname") ?? attribute(tag, "name") ?? "(unnamed)", message: inner(failure, "message"), trace: inner(failure, "stack-trace") }); };
  for (const match of xml.matchAll(/<test-case\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test-case>)/g)) {
    if (!/\bresult="(?:Failed|Error)"/.test(match[1]!)) continue;
    add(match[1]!, /<failure\b[^>]*>([\s\S]*?)<\/failure>/.exec(match[2] ?? "")?.[1] ?? "");
  }
  // A suite whose own <failure> comes before any child (properties aside) failed in setup; the cases below a healthy suite are reported above.
  for (const match of xml.matchAll(/<test-suite\b([^>]*)>\s*(?:<properties>[\s\S]*?<\/properties>\s*)?<failure\b[^>]*>([\s\S]*?)<\/failure>/g)) if (/\bresult="(?:Failed|Error)"/.test(match[1]!)) add(match[1]!, match[2]!);
  const total = Number(attribute(run, "total")); const failed = Number(attribute(run, "failed"));
  return { failures, failed: Number.isFinite(failed) ? failed : failures.length, ...(Number.isFinite(total) ? { total } : {}) };
}

/** JUnit XML (<testsuite>/<testsuites>): every <testcase> with a <failure> or <error> child. */
export function parseJUnit(xml: string): ReportSummary {
  const failures: TestFailure[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = match[1]!; const body = match[2] ?? "";
    const problem = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!problem) continue;
    const classname = attribute(tag, "classname"); const name = attribute(tag, "name") ?? "(unnamed)";
    failures.push({ name: classname ? `${classname}.${name}` : name, message: attribute(problem[2]!, "message") ?? "", trace: problem[3] ? decode(problem[3]).trim() : "" });
  }
  let total = 0; let failed = 0; let counted = false;
  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const tests = Number(attribute(match[1]!, "tests")); if (!Number.isFinite(tests)) continue;
    counted = true; total += tests; failed += (Number(attribute(match[1]!, "failures")) || 0) + (Number(attribute(match[1]!, "errors")) || 0);
  }
  return { failures, failed: counted ? Math.max(failed, failures.length) : failures.length, ...(counted ? { total } : {}) };
}

/** The report files a spec names: a file, or a file name with one `*` in a folder (target/surefire-reports/TEST-*.xml). The spec path is relative to the command's folder and never leaves it. */
export async function reportFiles(spec: ReportSpec, cwd: string): Promise<string[]> {
  const relative = spec.path.split("\\").join("/");
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split("/").includes("..")) return [];
  const folder = path.posix.dirname(relative); const pattern = path.posix.basename(relative);
  if (!pattern.includes("*")) return [path.resolve(cwd, relative)];
  const matcher = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  try { return (await readdir(path.resolve(cwd, folder))).filter(name => matcher.test(name)).sort().map(name => path.resolve(cwd, folder, name)); } catch { return []; }
}

/** Reads and merges the reports a spec names. Missing or unreadable files contribute nothing; the caller falls back to the console output. */
export async function readReport(spec: ReportSpec, cwd: string): Promise<ReportSummary> {
  const parse = spec.format === "nunit" ? parseNUnit : parseJUnit;
  const merged: ReportSummary = { failures: [], failed: 0 };
  for (const file of await reportFiles(spec, cwd)) {
    try {
      const one = parse(await readFile(file, "utf8"));
      merged.failures.push(...one.failures); merged.failed += one.failed;
      if (one.total !== undefined) merged.total = (merged.total ?? 0) + one.total;
    } catch { /* an unreadable report is not evidence */ }
  }
  return merged;
}

/** The failures as a short list for a repair prompt: name, the first lines of the message, the first project frames of the trace. */
export function summarizeFailures(summary: ReportSummary, options: { maxChars?: number; maxFailures?: number } = {}): string {
  const maxFailures = options.maxFailures ?? 10; const maxChars = options.maxChars ?? 3500;
  if (!summary.failures.length) return "";
  const lines = [`${summary.failed || summary.failures.length}${summary.total ? ` of ${summary.total}` : ""} test(s) failed:`];
  summary.failures.slice(0, maxFailures).forEach((failure, index) => {
    const message = compactLog(failure.message, { maxChars: 500 }).split("\n").slice(0, 4).join("\n      ");
    const trace = failure.trace ? compactLog(failure.trace, { maxChars: 600, keepFrames: 3 }).split("\n").slice(0, 6).join("\n      ") : "";
    lines.push(`${index + 1}. ${failure.name}`, ...(message ? [`      ${message}`] : []), ...(trace ? [`      ${trace}`] : []));
  });
  if (summary.failures.length > maxFailures) lines.push(`... and ${summary.failures.length - maxFailures} more failing test(s)`);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[... cut ...]` : text;
}
