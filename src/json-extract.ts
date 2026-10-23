/** First top-level {...} object in the text, honouring strings and escapes; undefined when none is complete (for example a truncated answer). */
export function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

/**
 * Parse a model answer that should be one JSON object. Accepts the bare object, a fenced code block, or an object surrounded by prose.
 * A truncated or otherwise broken object still fails, so callers keep their validation guarantees.
 */
export function parseJsonLoose(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
  for (const candidate of [raw.trim(), fenced?.trim(), firstBalancedObject(raw)]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try the next form */ }
  }
  throw new SyntaxError("answer does not contain a complete JSON object");
}
