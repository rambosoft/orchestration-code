// Acceptance traceability for game tasks. Every acceptance criterion of a task has an id (T3-AC1), the agent proves each one with a test that says `Covers: T3-AC1`, and the verify
// activity fails the task when one has no test. A criterion that cannot be met in this task has to be deferred in the open (`Deferred: T3-AC4 -> T8 reason`), which is reported to the
// reviewer. This closes the gap the first live game run showed: the tests passed, but nothing tied them to what the task had to deliver.
const ID = /\bT\d+-AC\d+\b/g;
const unique = (items: string[]): string[] => [...new Set(items)];

/** The criterion ids a task description declares. Empty for a task without numbered criteria (every non-game task), which turns the check off. */
export function acceptanceIds(prompt: string): string[] {
  return unique([...prompt.matchAll(/^\s*[-*]\s*(T\d+-AC\d+)\s*:/gm)].map(match => match[1]!));
}

export type AcceptanceTrace = { missing: string[]; deferred: Array<{ id: string; to: string }> };
export function traceAcceptance(ids: string[], testTexts: string[]): AcceptanceTrace {
  const text = testTexts.join("\n");
  const covered = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const covers = /\bCovers\s*:(.*)$/i.exec(line);
    if (covers) for (const id of covers[1]!.match(ID) ?? []) covered.add(id);
  }
  const deferred: AcceptanceTrace["deferred"] = [];
  for (const match of text.matchAll(/\bDeferred\s*:\s*(T\d+-AC\d+)\s*->\s*(T\d+)\b/gi)) deferred.push({ id: match[1]!, to: match[2]! });
  const deferredIds = new Set(deferred.map(item => item.id));
  return { missing: ids.filter(id => !covered.has(id) && !deferredIds.has(id)), deferred: deferred.filter(item => ids.includes(item.id) && !covered.has(item.id)) };
}

/** The failure text for the repair prompt, or undefined when every criterion is covered or openly deferred. */
export function acceptanceProblem(prompt: string, testTexts: string[]): string | undefined {
  const ids = acceptanceIds(prompt);
  if (!ids.length) return undefined;
  const { missing } = traceAcceptance(ids, testTexts);
  if (!missing.length) return undefined;
  return `acceptance criteria without a test: ${missing.join(", ")}. Add a test (EditMode for rules, PlayMode for screens and flows) for each, and put "Covers: ${missing[0]}" in a comment on the test that proves it. A criterion this task truly cannot meet because it depends on a later task is declared in a test file comment as "Deferred: ${missing[0]} -> T<later task> reason" and is shown to the reviewer; never delete or weaken a criterion.`;
}

// Reachability (the vertical slice). The first game's tests passed while the feature could not be reached from the running game (Continue was not wired, a screen was a placeholder), because the tests
// built the screen directly. A screen or flow task therefore carries a standing criterion that starts with SLICE_PREFIX; the test that covers it must live in Assets/Tests/PlayMode, boot the real game
// scene and assert something. The check is a trace of the test source, not a Unity run: the PlayMode suite itself still has to pass.
export const SLICE_PREFIX = "Reachable from the real game:";
export const SLICE_BOOT = /\bSliceHarness\.Boot\w*\s*\(|\bSceneManager\.LoadScene(?:Async)?\s*\(|\bEditorSceneManager\.LoadSceneAsyncInPlayMode\s*\(/;
const PLAY_MODE_PATH = /(?:^|[\\/])Tests[\\/]PlayMode[\\/]/;
export function sliceIds(prompt: string): string[] {
  return unique([...prompt.matchAll(/^\s*[-*]\s*(T\d+-AC\d+)\s*:\s*Reachable from the real game\b/gm)].map(match => match[1]!));
}
export type TestFile = { file: string; text: string };
/** The text of the test a `Covers:` comment names: from that comment to the next `Covers:` comment, at most 80 lines. */
function coveredBlock(file: TestFile, id: string): string | undefined {
  const lines = file.text.split(/\r?\n/);
  const start = lines.findIndex(line => /\bCovers\s*:/i.test(line) && (line.match(ID) as string[] | null ?? []).includes(id));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && end - start < 80 && !/\bCovers\s*:/i.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}
/** The failure text for the repair prompt, or undefined when every slice criterion is proven by a PlayMode test that boots the real scene and asserts. */
export function sliceProblem(prompt: string, files: TestFile[]): string | undefined {
  const problems: string[] = [];
  const deferred = new Set(files.flatMap(file => [...file.text.matchAll(/\bDeferred\s*:\s*(T\d+-AC\d+)\s*->/gi)].map(match => match[1]!)));
  for (const id of sliceIds(prompt)) {
    if (deferred.has(id)) continue;
    const blocks = files.filter(file => PLAY_MODE_PATH.test(file.file)).map(file => coveredBlock(file, id)).filter((block): block is string => block !== undefined);
    if (!blocks.length) { if (!files.some(file => coveredBlock(file, id) !== undefined)) problems.push(`${id} has no test (add a PlayMode test that says "Covers: ${id}")`); else problems.push(`${id} is covered by a test outside Assets/Tests/PlayMode; the reachability test must be a PlayMode test`); continue; }
    if (!blocks.some(block => SLICE_BOOT.test(block))) problems.push(`${id}: the covering test does not boot the real game scene (use "yield return SliceHarness.Boot();" or load the main scene); building the screen or its view model directly proves nothing about the running game`);
    else if (!blocks.some(block => SLICE_BOOT.test(block) && /\bAssert\.|\bConstraint\b|\bIs\.|\bHas\./.test(block))) problems.push(`${id}: the covering test boots the game but asserts nothing about what the player sees`);
  }
  return problems.length ? `reachability criteria not proven from the running game: ${problems.join("; ")}. Reach the feature by simulated player input from the scene the player starts, and assert the visible result.` : undefined;
}

/** `replacement`: the part of the criterion an automated run can still prove. The criterion keeps its id (so it still needs a test) and the device-only remainder is declared waived in its text. */
export type Waiver = { id: string; reason: string; replacement?: string };
/**
 * The operator's decision that a criterion cannot be verified by an automated run (it needs a physical device, a store account, a person): its line is rewritten so that it is no longer
 * a numbered criterion (the verify gate stops asking for a test) and the reviewer is told it was waived on purpose and why. The rest of the task prompt is unchanged. Returns the prompt and the ids that were found.
 */
export function waiveCriteria(prompt: string, waivers: Waiver[]): { prompt: string; waived: string[] } {
  const waived: string[] = [];
  let next = prompt;
  for (const waiver of waivers) {
    const line = new RegExp(`^(\\s*[-*]\\s*)${waiver.id}\\s*:\\s*(.*)$`, "m");
    if (!line.test(next)) continue;
    const reason = waiver.reason.replace(/\s+/g, " ").trim();
    next = next.replace(line, (_, bullet: string, text: string) => waiver.replacement
      ? `${bullet}${waiver.id}: ${waiver.replacement.replace(/\s+/g, " ").trim()} (Narrowed by the operator: what needs a physical device is not verified by this task - ${reason}. Original: ${text})`
      : `${bullet}Waived by the operator, not verified by this task (${reason}): ${text}`);
    waived.push(waiver.id);
  }
  return { prompt: next, waived };
}
