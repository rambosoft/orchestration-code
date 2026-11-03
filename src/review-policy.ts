// Specialist review (B-129, ADR 0034): a project names its critical areas (storage, input, carousel, playback, the Xtream adapter) by path, and a task whose change touches one gets a review
// with that area's focus, even on a lane or tier that otherwise reviews once per milestone. Pure and workflow-safe (no I/O, no clock): the workflow matches the files `assessChanges` reports.

export type SpecialistArea = { id: string; paths: string[]; focus: string };
export type SpecialistMatch = { area: SpecialistArea; files: string[] };

const SPECIALS = /[.+^${}()|[\]\\]/g;
/** `**` crosses folders, `*` stays inside one, `?` is one character; everything else is literal. Anchored to the whole path. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") { index++; if (glob[index + 1] === "/") { index++; source += "(?:.*/)?"; } else source += ".*"; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(SPECIALS, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The areas a change touches, with the files that touched them, in the order the manifest lists the areas. */
export function matchSpecialists(areas: readonly SpecialistArea[], files: readonly string[]): SpecialistMatch[] {
  const normalized = files.map(file => file.replace(/\\/g, "/").replace(/^\.\//, ""));
  const matches: SpecialistMatch[] = [];
  for (const area of areas) {
    const patterns = area.paths.map(globToRegExp);
    const touched = normalized.filter(file => patterns.some(pattern => pattern.test(file)));
    if (touched.length) matches.push({ area, files: touched });
  }
  return matches;
}

const list = (files: string[]): string => `${files.slice(0, 3).join(", ")}${files.length > 3 ? `, and ${files.length - 3} more` : ""}`;
export const specialistReasons = (matches: readonly SpecialistMatch[]): string[] => matches.map(match => `touches the ${match.area.id} area (${list(match.files)})`);

/** The review prompt section: what each touched area needs the reviewer to look at. Empty when nothing matched. */
export function specialistReviewText(matches: readonly SpecialistMatch[]): string {
  if (!matches.length) return "";
  return [
    "SPECIALIST REVIEW (this change touches a critical area of the project):",
    ...matches.map(match => `- ${match.area.id} (${list(match.files)}): ${match.area.focus}`),
    "Review these areas more strictly than the rest of the change. Report a blocking finding when the diff breaks the focus above and you can show a concrete scenario; otherwise note it.",
  ].join("\n");
}
