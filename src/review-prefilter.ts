// Deterministic findings from the diff, before any model reviews it. A reviewer that has to notice a leftover TODO, a skipped test or a stub that throws "not implemented" spends tokens (and a review round)
// on what a regular expression finds for free, and can miss it. These run in the verify activity, so a hit goes through the gate-repair pass instead of costing a review round.
// Only lines the change ADDS are looked at, so existing code is never blamed.
export type PrefilterFinding = { file: string; rule: string; text: string };

const DOC_FILE = /(^|\/)(docs?|openspec)\/|\.(md|mdx|txt|json|ya?ml|lock|csv|svg|meta)$/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.cs$|(^|\/)Tests\//i;
/** A line carrying this token is a deliberate exception (a TODO that names its ticket, a stub behind a feature flag) and is skipped. */
export const PREFILTER_ALLOW = "orchestrator:allow";

type Rule = { rule: string; pattern: RegExp; appliesTo: "source" | "test" | "any" };
const RULES: Rule[] = [
  { rule: "unfinished-marker", pattern: /\b(?:TODO|FIXME|XXX|HACK)\b/, appliesTo: "source" },
  { rule: "not-implemented-stub", pattern: /NotImplementedException|not implemented|unimplemented!?\(|throw new Error\(\s*["'`]todo/i, appliesTo: "source" },
  { rule: "placeholder-copy", pattern: /lorem ipsum|coming soon\b|\bplaceholder text\b/i, appliesTo: "source" },
  { rule: "skipped-test", pattern: /\[Ignore\b|\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe)\s*\(|@Disabled\b|\bt\.Skip\(|\bAssume\.That\(\s*false/, appliesTo: "test" },
  { rule: "assertion-free-pass", pattern: /\bAssert\.Pass\(\s*\)/, appliesTo: "test" },
];

/** Findings for the lines a unified diff adds. */
export function prefilterFindings(diff: string): PrefilterFinding[] {
  const findings: PrefilterFinding[] = [];
  let file = "";
  for (const line of diff.split(/\r?\n/)) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header) { file = header[1]!.trim(); continue; }
    if (!line.startsWith("+") || line.startsWith("+++") || !file || file === "/dev/null") continue;
    if (DOC_FILE.test(file)) continue;
    const added = line.slice(1);
    if (added.includes(PREFILTER_ALLOW)) continue;
    const isTest = TEST_FILE.test(file);
    for (const rule of RULES) {
      if (rule.appliesTo === "source" && isTest) continue;
      if (rule.appliesTo === "test" && !isTest) continue;
      if (rule.pattern.test(added)) findings.push({ file, rule: rule.rule, text: added.trim().slice(0, 140) });
    }
  }
  return findings;
}

/** The failure text for the repair prompt, or undefined when the diff is clean. */
export function prefilterProblem(findings: PrefilterFinding[]): string | undefined {
  if (!findings.length) return undefined;
  const shown = findings.slice(0, 12).map(finding => `${finding.file}: ${finding.rule}: ${finding.text}`);
  const more = findings.length > shown.length ? `\n(${findings.length - shown.length} more)` : "";
  return `the change leaves unfinished work that a review would reject:\n${shown.join("\n")}${more}\nFinish or remove each one. A deliberate exception (for example a TODO that names its ticket) carries the token "${PREFILTER_ALLOW}" on the same line. Never skip, ignore or weaken a test to get green.`;
}

export const prefilterEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.ORCHESTRATOR_PREFILTER !== "0";
