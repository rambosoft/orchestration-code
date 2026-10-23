// The project form as the orchestrator expects it inside the bootstrap task (the same shape as BootstrapFormSchema in the orchestrator's src/bootstrap-options.ts).
export type OptionValue = string | boolean;
export type BootstrapForm = {
  version: 1; name: string; description: string; options: Record<string, OptionValue>;
  repoName?: string; repoOwner?: string;
  paperclip: { companyId: string; projectId: string; agentId?: string };
};

/**
 * The form travels in the task description as a hidden HTML comment. Paperclip normalises task text (a literal "\n" in the stored text becomes a real newline,
 * which broke raw JSON in the first live run), so it is stored as base64url: one opaque token that no text normalisation touches. The orchestrator
 * (src/bootstrap-form.ts) reads the same format.
 */
export function embedBootstrapForm(form: BootstrapForm): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(form))) binary += String.fromCharCode(byte);
  return `<!-- bootstrap-form:v1 ${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")} -->`;
}

export function projectSlug(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug.length >= 2 ? slug : `project-${slug || "app"}`;
}

export function formProblems(input: { name: string; description: string; repoName: string; repoOwner: string }): string[] {
  const problems: string[] = [];
  if (input.name.trim().length < 2) problems.push("Give the project a name.");
  if (input.description.trim().length < 10) problems.push("Describe the project in at least a sentence.");
  if (input.repoName.trim() && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,98}$/.test(input.repoName.trim())) problems.push("The repository name may only use letters, digits, '.', '_' and '-'.");
  if (input.repoOwner.trim() && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(input.repoOwner.trim())) problems.push("The repository owner is not a valid GitHub account name.");
  return problems;
}

/** The readable part of the bootstrap task; people see this, the orchestrator reads the hidden form. */
export function taskDescription(form: BootstrapForm): string {
  const chosen = Object.entries(form.options).map(([key, value]) => `- ${key}: ${String(value)}`).join("\n");
  return `Plan and create the project "${form.name}".\n\n${form.description.trim()}\n\n${chosen ? `Choices made in the wizard:\n${chosen}\n\n` : ""}The orchestrator plans the stack, the project contract and the milestones, waits for approval in the project's Bootstrap tab, then creates the repository and the tasks.\n\n${embedBootstrapForm(form)}`;
}
