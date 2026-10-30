// Logs and stack traces are the largest text an agent is handed by accident: a Unity test failure, a Spring Boot startup error or a pasted CI log can be thousands of lines, nearly all of it framework
// frames, repeats and progress output. This keeps what a person fixing the problem reads (the error, the project's own frames, the cause chain) and replaces the rest with counts. It is deterministic,
// never invents text, and works on the frame formats of Java/Kotlin, C#/Unity, JavaScript, Python, Go and Rust without being told which one it has.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TIMESTAMP = /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/;

// A line that is one frame of a stack trace, in any supported language.
const FRAME: RegExp[] = [
  /^\s+at\s+\S.*\(.*\)\s*$/, // Java, Kotlin, C# ("at Game.Rules.Merge () [0x00012] in <hash>:0"), JS ("at fn (file.js:1:2)")
  /^\s+at\s+\S.*:\d+(?::\d+)?\s*$/, // JS without a function name
  /^\s+File ".*", line \d+(?:, in .+)?\s*$/, // Python
  /^\s+\/\S+\.go:\d+(?: \+0x[0-9a-f]+)?\s*$/, // Go file lines
  /^\s+\d+:\s+(?:0x[0-9a-f]+ - )?\S.*$/, // Rust backtrace ("  12: core::ops::function::FnOnce::call_once")
  /^\s+at\s+.*\.rs:\d+(?::\d+)?\s*$/, // Rust source lines
  /^[\w.]+(?:\.[\w<>]+)*:[\w<>.]+\s*\(.*\)\s*$/, // Unity log frames ("UnityEngine.Debug:LogError (object)")
  /^\(Filename:\s.*Line:\s*\d+\)\s*$/, // Unity log frame location
  /^\s+\.\.\. \d+ (?:more|common frames omitted)\s*$/, // Java trailer
];
// Frames that belong to a framework, a runtime or a test runner, not to the project being fixed.
const FRAMEWORK = /(?:\bat\s+(?:java\.|javax\.|jakarta\.|jdk\.|sun\.|com\.sun\.|kotlin\.|kotlinx\.|scala\.|org\.(?:springframework|junit|apache|hibernate|gradle|testng|mockito|assertj|jboss|eclipse|slf4j|xnio)\.|io\.(?:netty|undertow)\.|reactor\.|System\.|Microsoft\.|Mono\.|UnityEngine\.|UnityEditor\.|Unity\.|NUnit\.|Xunit\.))|\(wrapper |<wrapper |node_modules[\\/]|node:internal|\(<anonymous>\)|site-packages|[\\/]usr[\\/]lib[\\/]python|<frozen |[\\/]usr[\\/]local[\\/]go[\\/]src[\\/]|[\\/]pkg[\\/]mod[\\/]|\bruntime\.(?:goexit|main|gopanic)|testing\.tRunner|\b(?:std|core|alloc|tokio|futures)::|[\\/]rustc[\\/]|[\\/]rustlib[\\/]|^\s+\.\.\. \d+ (?:more|common)|^(?:UnityEngine|UnityEditor|System|NUnit)\.[\w.]*:/;
const SALIENT = /error|fail|exception|assert|expected|panic|fatal|caused by|cannot|could not|not found|denied|refused|timed out|\bCS\d{4}\b|\bTS\d{4}\b|\bE\d{4}\b|warning:/i;

export type CompactOptions = { /** Output cap in characters (default 4000). */ maxChars?: number; /** Project frames kept per stack trace (default 6). */ keepFrames?: number };
const isFrame = (line: string): boolean => FRAME.some(pattern => pattern.test(line));
const isFramework = (line: string): boolean => FRAMEWORK.test(line);

function normalize(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(ANSI, "").split(/\r?\n/)) {
    const line = (raw.includes("\r") ? raw.split("\r").pop()! : raw).replace(TIMESTAMP, "").replace(/\s+$/, "");
    lines.push(line);
  }
  return lines;
}

/** Collapses a run of consecutive frames: the first `keep` project frames, one marker per stretch of framework frames, one marker for project frames beyond the limit. */
function collapseFrames(run: string[], keep: number): string[] {
  const out: string[] = []; let kept = 0; let hiddenProject = 0; let hiddenFramework = 0;
  const flushFramework = () => { if (hiddenFramework) { out.push(`    ... ${hiddenFramework} framework frame${hiddenFramework === 1 ? "" : "s"} ...`); hiddenFramework = 0; } };
  for (const line of run) {
    if (isFramework(line)) { hiddenFramework++; continue; }
    if (kept >= keep) { hiddenProject++; continue; }
    flushFramework(); out.push(line); kept++;
  }
  flushFramework();
  if (hiddenProject) out.push(`    ... ${hiddenProject} more frame${hiddenProject === 1 ? "" : "s"} ...`);
  return out;
}

/** Keeps the lines that say what went wrong (and the line after each), then the head and the tail, inside the limit. */
function shrink(lines: string[], maxChars: number): string[] {
  if (lines.join("\n").length <= maxChars) return lines;
  const keep = new Set<number>();
  lines.forEach((line, index) => { if (SALIENT.test(line)) { keep.add(index); if (index + 1 < lines.length) keep.add(index + 1); } });
  for (let index = 0; index < Math.min(3, lines.length); index++) keep.add(index);
  for (let index = Math.max(0, lines.length - 3); index < lines.length; index++) keep.add(index);
  const picked: string[] = []; let gap = 0;
  lines.forEach((line, index) => { if (keep.has(index)) { if (gap) { picked.push(`[... ${gap} line${gap === 1 ? "" : "s"} left out ...]`); gap = 0; } picked.push(line); } else gap++; });
  if (gap) picked.push(`[... ${gap} line${gap === 1 ? "" : "s"} left out ...]`);
  if (picked.join("\n").length <= maxChars) return picked;
  // Still too long: head and tail, split 60/40, at line boundaries.
  const headBudget = Math.floor(maxChars * 0.6); const tailBudget = maxChars - headBudget;
  const head: string[] = []; let used = 0;
  for (const line of picked) { if (used + line.length + 1 > headBudget) break; head.push(line); used += line.length + 1; }
  const tail: string[] = []; used = 0;
  for (let index = picked.length - 1; index >= head.length; index--) { const line = picked[index]!; if (used + line.length + 1 > tailBudget) break; tail.unshift(line); used += line.length + 1; }
  return [...head, `[... ${picked.length - head.length - tail.length} more lines left out ...]`, ...tail];
}

const ITEM_ID = /\b[A-Z]{1,5}-\d+(?:-AC\d+)?\b/g;
/**
 * Consecutive lines that differ only by an item id ("warning rule-trace: R-001 ... not referenced by any test", then R-002 ... R-016) become the first line and a count with the last id:
 * a gate that reports one line per rule used to hand the agent sixteen near-identical lines on every attempt.
 */
function foldSimilar(lines: string[]): string[] {
  const idsOf = (line: string): string[] => line.match(ITEM_ID) ?? [];
  const out: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const key = idsOf(line).length ? line.replace(ITEM_ID, "#") : undefined;
    let end = index + 1;
    while (key && end < lines.length && idsOf(lines[end]!).length && lines[end]!.replace(ITEM_ID, "#") === key) end++;
    if (key && end - index >= 3) out.push(`${line} [+${end - index - 1} similar, up to ${idsOf(lines[end - 1]!).at(-1)}]`);
    else out.push(...lines.slice(index, end));
    index = end;
  }
  return out;
}

/** The log or trace in a form worth reading: no colour codes, timestamps or progress redraws; repeated lines and traces counted; similar lines folded; framework frames folded; capped. */
export function compactLog(text: string, options: CompactOptions = {}): string {
  const maxChars = options.maxChars ?? 4000; const keepFrames = options.keepFrames ?? 6;
  const lines = foldSimilar(normalize(text));
  const out: string[] = []; const seenTraces = new Map<string, number>();
  let repeatCount = 0; let previous: string | undefined;
  const flushRepeat = () => { if (repeatCount > 0) { out[out.length - 1] = `${out[out.length - 1]} (x${repeatCount + 1})`; repeatCount = 0; } };
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (isFrame(line)) {
      flushRepeat(); previous = undefined;
      const run: string[] = [];
      while (index < lines.length && (isFrame(lines[index]!) || (run.length && /^\s{4,}\S/.test(lines[index]!) && !/^\s+at\s/.test(lines[index]!)))) { run.push(lines[index]!); index++; }
      const collapsed = collapseFrames(run, keepFrames); const key = collapsed.join("\n");
      const count = seenTraces.get(key) ?? 0; seenTraces.set(key, count + 1);
      out.push(...(count ? [`    (same stack trace as an earlier one, again)`] : collapsed));
      continue;
    }
    index++;
    if (line === "" && out[out.length - 1] === "") continue;
    if (line !== "" && line === previous) { repeatCount++; continue; }
    flushRepeat(); previous = line; out.push(line);
  }
  flushRepeat();
  while (out[0] === "") out.shift(); while (out[out.length - 1] === "") out.pop();
  return shrink(out, maxChars).join("\n");
}

const traceish = (line: string): boolean => isFrame(line) || /^\s*(?:Caused by:|Exception in thread|Traceback \(most recent call last\)|goroutine \d+|thread '.*' panicked)/.test(line) || TIMESTAMP.test(line);

/**
 * For text a person pasted into a task: a block of eight or more log-like lines is compacted in place (with a note saying how much it was), prose around it is untouched. The full text stays in the task.
 */
export function compactEmbeddedLogs(text: string, options: CompactOptions = {}): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let index = 0; index < lines.length;) {
    let end = index; let hits = 0;
    while (end < lines.length && (traceish(lines[end]!) || (lines[end]!.trim() === "" && end + 1 < lines.length && traceish(lines[end + 1]!)) || (hits > 0 && /^\s{2,}\S/.test(lines[end]!)))) { if (traceish(lines[end]!)) hits++; end++; }
    if (hits >= 8 && end - index >= 8) {
      const block = lines.slice(index, end).join("\n"); const compacted = compactLog(block, { maxChars: options.maxChars ?? 2500, ...(options.keepFrames ? { keepFrames: options.keepFrames } : {}) });
      out.push(`[log block compacted from ${end - index} to ${compacted.split("\n").length} lines; the full text is in the task]`, compacted);
      index = end;
    } else { out.push(lines[index]!); index++; }
  }
  return out.join("\n");
}
