// One merge for a stack of task PRs. The orchestrator stacks every task's draft PR on the previous task's branch. Merging them bottom-up in GitHub left the later tasks in intermediate branches and the
// last ones "stuck" (the first game, 2026-10-25); the right move is one merge of the TIP of the stack into the real base. This retargets the tip PR onto the base (its diff then holds every stacked commit),
// lists the stacked tasks in its description and, on request, closes the intermediate PRs with a pointer. A milestone is a cut: `--through <task>` takes the stack up to that task only.
// Dry run unless applied. It never merges and never deletes a branch.
import { runCommand, type CommandRunner } from "./command.js";

export type StackPr = { number: number; url: string; title: string; head: string; base: string; taskId: string; draft: boolean; body: string };
type RawPr = { number: number; url: string; title: string; headRefName: string; baseRefName: string; body?: string; isDraft?: boolean };

/** The open PRs the orchestrator published: their description starts with "Paperclip task: <id>". */
export function orchestratorPrs(raw: RawPr[]): StackPr[] {
  const prs: StackPr[] = [];
  for (const pr of raw) {
    const task = /^Paperclip task: (.+)$/.exec((pr.body ?? "").split(/\r?\n/, 1)[0] ?? "");
    if (task) prs.push({ number: pr.number, url: pr.url, title: pr.title, head: pr.headRefName, base: pr.baseRefName, taskId: task[1]!.trim(), draft: pr.isDraft !== false, body: pr.body ?? "" });
  }
  return prs;
}

export type StackPlan = { rootBase: string; tip: StackPr; included: StackPr[]; above: StackPr[] };

const matches = (pr: StackPr, selector: string): boolean => {
  const wanted = selector.replace(/^#/, "").toLowerCase();
  return String(pr.number) === wanted || pr.taskId.toLowerCase() === wanted || pr.head.toLowerCase() === wanted || pr.url.toLowerCase() === wanted;
};

/**
 * The stack ending at `through` (a PR number, task id or branch), or at the only tip when it is not given. `included` runs bottom to tip. Throws when the choice is ambiguous or the PR is unknown.
 */
export function planStack(prs: StackPr[], options: { through?: string } = {}): StackPlan {
  const heads = new Set(prs.map(pr => pr.head));
  const tips = prs.filter(pr => !prs.some(other => other.base === pr.head));
  let tip: StackPr | undefined;
  if (options.through) {
    tip = prs.find(pr => matches(pr, options.through!));
    if (!tip) throw new Error(`no open orchestrator PR matches "${options.through}" (use a PR number, a task id or a branch)`);
  } else {
    if (tips.length !== 1) throw new Error(tips.length ? `${tips.length} stacks end at different tips (${tips.map(pr => `#${pr.number} ${pr.taskId}`).join(", ")}); choose one with --through` : "there are no open orchestrator PRs");
    tip = tips[0]!;
  }
  const included: StackPr[] = [tip];
  for (let current = tip; ;) {
    const parent = prs.find(pr => pr.head === current.base);
    if (!parent || included.includes(parent)) break;
    included.unshift(parent); current = parent;
  }
  const rootBase = included[0]!.base;
  if (heads.has(rootBase)) throw new Error(`the stack of #${tip.number} loops back on itself`);
  const above: StackPr[] = [];
  for (let frontier = [tip]; frontier.length;) {
    const next = prs.filter(pr => frontier.some(parent => parent.head === pr.base) && !above.includes(pr) && !included.includes(pr));
    above.push(...next); frontier = next;
  }
  return { rootBase, tip, included, above };
}

const marker = "### Stacked changes in this pull request";
/** The tip PR's description with the list of the tasks it carries (any earlier list is replaced). */
export function stackBody(plan: StackPlan): string {
  const original = plan.tip.body.split(marker)[0]!.trimEnd();
  const rows = plan.included.map(pr => `- #${pr.number} ${pr.title.replace(/^Draft:\s*/i, "")} (task ${pr.taskId})`);
  return `${original}\n\n${marker}\nMerging this pull request into \`${plan.rootBase}\` merges all of these tasks at once; the earlier pull requests of the stack are included here.\n${rows.join("\n")}\n`;
}

export function describePlan(plan: StackPlan, options: { closeStacked: boolean }): string[] {
  const lines = [`stack of ${plan.included.length} PR(s), tip #${plan.tip.number} (${plan.tip.taskId}), real base \`${plan.rootBase}\``, ...plan.included.map(pr => `  #${pr.number} ${pr.taskId}  ${pr.head} -> ${pr.base}`)];
  lines.push(`retarget #${plan.tip.number} onto \`${plan.rootBase}\` and list the stacked tasks in its description`);
  if (options.closeStacked && plan.included.length > 1) lines.push(`close #${plan.included.slice(0, -1).map(pr => pr.number).join(", #")} with a pointer to #${plan.tip.number}`);
  if (plan.above.length) lines.push(`not included (they stay stacked on \`${plan.tip.head}\`): ${plan.above.map(pr => `#${pr.number} ${pr.taskId}`).join(", ")}`);
  return lines;
}

/** Retargets the tip, rewrites its description and optionally closes the intermediate PRs. Returns what it did. */
export async function applyStack(plan: StackPlan, options: { cwd: string; closeStacked: boolean }, runner: CommandRunner = runCommand): Promise<string[]> {
  const done: string[] = [];
  await runner("gh", ["pr", "edit", String(plan.tip.number), "--base", plan.rootBase, "--body", stackBody(plan)], options.cwd);
  done.push(`retargeted #${plan.tip.number} onto ${plan.rootBase}`);
  if (options.closeStacked) {
    for (const pr of plan.included.slice(0, -1)) {
      await runner("gh", ["pr", "comment", String(pr.number), "--body", `Included in #${plan.tip.number}, which now targets \`${plan.rootBase}\`: merge that one pull request. This one is closed to avoid merging the stack piece by piece; its branch is kept.`], options.cwd);
      await runner("gh", ["pr", "close", String(pr.number)], options.cwd);
      done.push(`closed #${pr.number}`);
    }
  }
  return done;
}

export async function stackPr(options: { cwd: string; through?: string; apply: boolean; closeStacked: boolean }, runner: CommandRunner = runCommand): Promise<{ plan: StackPlan; lines: string[] }> {
  const raw = JSON.parse(await runner("gh", ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,url,title,headRefName,baseRefName,body,isDraft"], options.cwd)) as RawPr[];
  const plan = planStack(orchestratorPrs(raw), options.through ? { through: options.through } : {});
  const lines = describePlan(plan, options);
  if (!options.apply) return { plan, lines: [...lines, "(dry run: nothing was changed; add --apply to do this)"] };
  return { plan, lines: [...lines, ...(await applyStack(plan, options, runner))] };
}
