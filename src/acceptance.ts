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
