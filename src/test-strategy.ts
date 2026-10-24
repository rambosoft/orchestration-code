import type { QualityCommand } from "./contracts.js";

// Test strategy for every implementation stage of every project. Running the whole suite after each small edit is the main cost of a long task (a Unity task spent 43 of its 58
// minutes re-running one suite), so the agent iterates on the tests its change can affect and runs the full suite once at the end; the orchestration's own gate runs the full suite
// again, so nothing reaches review unverified. Pure text from the configured checks: it is imported by the workflow bundle and changes no workflow command.
const NODE_RUNNERS = new Set(["npm", "pnpm", "yarn", "node"]);

/** The stack-specific way to run only the affected tests, one line per kind of check the project is gated on. */
export function affectedTestHints(checks: ReadonlyArray<Pick<QualityCommand, "executable" | "args">>): string[] {
  const hints: string[] = [];
  if (checks.some(check => check.executable === "unity")) hints.push("Unity: `unity test --mode EditMode --filter <Fixture>` and `unity test --mode PlayMode --filter <Fixture>` run one fixture; `unity test --affected --since HEAD` runs the tests your uncommitted change can reach (it runs everything when it cannot tell); `--rerun-failed` re-runs only the previous failures.");
  if (checks.some(check => NODE_RUNNERS.has(check.executable) && check.args.some(arg => /^(test|t|run)$/.test(arg) || /test/.test(arg)))) hints.push("Node: pass a file or name pattern to the runner (`npm test -- <path or pattern>`); Vitest has `--changed` and `related <files>`, Jest has `--onlyChanged` and `--findRelatedTests <files>`, `node --test <file>` runs one file.");
  if (!hints.length) hints.push("Run only the test files that cover the files you changed, using the runner's file or name filter.");
  return hints;
}

/** The paragraph added to every implementation prompt. */
export function testStrategy(checks: ReadonlyArray<Pick<QualityCommand, "executable" | "args">>): string {
  return `TEST STRATEGY. While you work, run only the tests your change can affect: the test files or fixtures of the code you touched, the tests you add, and the ones that failed before. Do not run the whole suite after every edit. Run the full suite and the other configured checks once, at the end, before you finish; the orchestration runs them again as the publication gate. A test you added must be run on its own before you rely on it.\n${affectedTestHints(checks).map(hint => `- ${hint}`).join("\n")}`;
}
