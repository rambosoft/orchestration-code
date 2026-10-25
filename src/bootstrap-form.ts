// The bootstrap form travels inside the Paperclip task description as a hidden HTML comment. Paperclip normalises task text (a literal "\n" in the stored text
// becomes a real newline, which broke raw JSON in the first live run), so the form is stored as base64url: one opaque token that no text normalisation touches.
// Kept out of src/bootstrap.ts, which the workflow bundle imports, because it needs Node's Buffer.
const MARKER = /<!--\s*bootstrap-form(?::v1)?\s+([\s\S]*?)\s*-->/;

export function embedBootstrapForm(form: unknown): string {
  return `<!-- bootstrap-form:v1 ${Buffer.from(JSON.stringify(form), "utf8").toString("base64url")} -->`;
}

/** Reads the current format and, for tasks written by an earlier version, a raw JSON body. `rest` is the task text without the block. */
export function extractBootstrapForm(text: string): { form?: unknown; error?: string; rest: string } {
  const match = MARKER.exec(text);
  if (!match) return { error: "the task has no bootstrap form (hidden bootstrap-form block)", rest: text };
  const rest = text.replace(MARKER, "").trim();
  const payload = match[1]!.trim();
  try {
    return { form: JSON.parse(/^[A-Za-z0-9_-]+$/.test(payload) ? Buffer.from(payload, "base64url").toString("utf8") : payload), rest };
  } catch {
    return { error: "the bootstrap form in the task could not be read (it is not valid JSON); create the project again from the wizard", rest };
  }
}
