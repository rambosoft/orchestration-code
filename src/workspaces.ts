import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ParentPublication, RepositoryContext, PublishResult } from "./contracts.js";
import { isSafeContractPath } from "./contract-text.js";
import { excludeGeneratedPaths, findPublishViolations, worktreeProfile } from "./publish-guard.js";

import { runCommand, type CommandRunner } from "./command.js";
import { worktreesDir } from "./env.js";
export { runCommand, type CommandRunner };
const git = (args: string[], cwd: string, runner = runCommand) => runner("git", args, cwd);

/**
 * Porcelain entries that really make the tree dirty. A Windows checkout (core.autocrlf=true) viewed from the Linux bridge container
 * shows every text file as modified because only the line endings differ; those entries are ignored. Untracked files, deletions,
 * additions, renames and quoted paths always count as dirty.
 */
export async function dirtyEntries(root: string, runner = runCommand): Promise<string[]> {
  const status = await git(["status", "--porcelain", "--untracked-files=all"], root, runner);
  const dirty: string[] = [];
  for (const line of status.split(/\r?\n/).filter(item => item.trim())) {
    const match = /^\s*([MADRCU?!]{1,2})\s+(.+)$/.exec(line);
    const file = match?.[2];
    if (!match || match[1] !== "M" && match[1] !== "MM" || !file || file.startsWith("\"") || file.includes(" -> ")) { dirty.push(line.trim()); continue; }
    const sameIgnoringEol = await git(["diff", "--ignore-cr-at-eol", "--quiet", "HEAD", "--", file], root, runner).then(() => true, () => false);
    if (!sameIgnoringEol) dirty.push(line.trim());
  }
  return dirty;
}

/** Fail closed before dispatch: never snapshot a dirty tree or invent a base. */
export async function admitRepository(input: { projectRoot: string; remote: string; targetBranch: string }, runner = runCommand): Promise<{ baseSha: string; remoteUrl: string }> {
  const root = path.resolve(input.projectRoot);
  await git(["rev-parse", "--show-toplevel"], root, runner);
  const dirty = await dirtyEntries(root, runner);
  if (dirty.length) throw new Error(`project working tree is not clean (tracked or untracked changes): ${dirty.join("\n").slice(0, 1000)}`);
  const remoteUrl = await git(["remote", "get-url", input.remote], root, runner);
  if (!/(github\.com[:/])/i.test(remoteUrl)) throw new Error(`remote '${input.remote}' is not a GitHub remote`);
  await git(["fetch", "--no-tags", input.remote, input.targetBranch], root, runner);
  const baseSha = await git(["rev-parse", "FETCH_HEAD^{commit}"], root, runner);
  if (!/^[0-9a-f]{40,64}$/i.test(baseSha)) throw new Error("could not resolve configured target branch to a commit SHA");
  return { baseSha, remoteUrl };
}
export async function resolveRemoteBranch(projectRoot: string, remote: string, branch: string, runner = runCommand): Promise<string> {
  await git(["fetch", "--no-tags", remote, branch], path.resolve(projectRoot), runner);
  const sha = await git(["rev-parse", "FETCH_HEAD^{commit}"], path.resolve(projectRoot), runner);
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`could not resolve '${remote}/${branch}' to a commit SHA`);
  return sha;
}

export function taskBranch(taskId: string, revision = "1", attempt = 1): string {
  const slug = `${taskId}-${revision}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
  return `codex/${slug || "task"}-a${attempt}`;
}

export async function prepareWorktree(input: { runId: string; projectRoot: string; baseSha: string; branch: string; requiredSourcePaths?: string[] }): Promise<string> {
  const root = path.resolve(input.projectRoot); const safeId = input.runId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 70);
  const base = worktreesDir(); await mkdir(base, { recursive: true });
  const dest = path.join(base, safeId);
  let destinationExists = true;
  try { await access(dest); } catch { destinationExists = false; }
  if (destinationExists) {
    const top = path.resolve(await git(["rev-parse", "--show-toplevel"], dest));
    const branch = await git(["branch", "--show-current"], dest);
    const head = await git(["rev-parse", "HEAD"], dest);
    if (top !== dest || branch !== input.branch || head !== input.baseSha) throw new Error(`existing worktree '${dest}' does not match the admitted base and task branch`);
  } else {
    const branchSha = await git(["rev-parse", `refs/heads/${input.branch}`], root).catch(() => "");
    if (branchSha && branchSha !== input.baseSha) throw new Error(`task branch '${input.branch}' already exists at a different commit`);
    if (branchSha) await git(["worktree", "add", dest, input.branch], root);
    else await git(["worktree", "add", "-b", input.branch, dest, input.baseSha], root);
  }
  const entries = await git(["ls-files"], dest);
  if (!entries) throw new Error("source-presence gate failed: task worktree contains no committed files");
  const tracked = new Set(entries.split(/\r?\n/));
  const missing = (input.requiredSourcePaths ?? []).filter(item => path.isAbsolute(item) || item.split(/[\\/]/).includes("..") || !tracked.has(item));
  if (missing.length) throw new Error(`source-presence gate failed: required committed project files are missing: ${missing.join(", ")}`);
  if (!input.requiredSourcePaths?.length && !entries.split(/\r?\n/).some(item => /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|html|css|vue|svelte|rb|php|swift|kt|c|cc|cpp|sh)$/i.test(item))) {
    throw new Error("source-presence gate failed: no tracked source files are present in the task worktree");
  }
  return dest;
}

export async function collectWorktree(input: { runId: string; projectRoot: string; worktree: string; artifactsDir: string }): Promise<string> {
  const diff = await git(["diff", "--binary", "HEAD"], input.worktree); await mkdir(input.artifactsDir, { recursive: true });
  const patch = path.join(input.artifactsDir, `${input.runId}.patch`); await writeFile(patch, diff, "utf8");
  const status = await git(["status", "--short", "--untracked-files=all"], input.worktree); await writeFile(path.join(input.artifactsDir, `${input.runId}.git-status.txt`), status, "utf8");
  return patch;
}

/** Commit, push, and create/update a draft PR. All commands are safe to retry. */
export async function publishWorktree(input: { repository: RepositoryContext; worktree: string; taskId: string; prompt: string; /** "document": a read-only research or architecture run that only adds a report. Default: code. */ kind?: "implementation" | "document" }, runner = runCommand): Promise<PublishResult> {
  const { repository: repo, worktree } = input;
  const status = await git(["status", "--porcelain", "--untracked-files=all"], worktree, runner);
  if (status) await git(["add", "--all"], worktree, runner);
  // Build output the run added (for Unity: Library, Builds, .utmp...) is not part of the change; it is kept out of the commit, also when the agent committed it itself.
  const excluded = input.kind === "document" ? [] : await excludeGeneratedPaths(worktree, repo.baseSha, worktreeProfile(worktree), runner);
  // Inspect everything that would be published, including commits the agent made itself.
  const violations = await findPublishViolations(worktree, repo.baseSha, runner);
  if (violations.length) throw new Error(`publish guard blocked the commit; nothing was pushed: ${violations.join("; ")}`);
  // After an exclusion the index may hold nothing but deletions or nothing at all; commit only when something is staged, and let the gate below report an empty change.
  const commitNeeded = excluded.length ? Boolean(await git(["diff", "--cached", "--name-only"], worktree, runner)) : Boolean(status);
  if (commitNeeded) await git(["-c", "user.name=Paperclip Orchestrator", "-c", "user.email=paperclip-orchestrator@localhost", "commit", "-m", input.kind === "document" ? `docs(${input.taskId}): orchestrated report` : `chore(${input.taskId}): orchestrated implementation`], worktree, runner);
  const headSha = await git(["rev-parse", "HEAD"], worktree, runner);
  if (headSha === repo.baseSha || (excluded.length && !(await git(["diff", "--name-only", repo.baseSha, headSha], worktree, runner)))) throw new Error("publish gate failed: no changes were committed");
  await git(["push", "--set-upstream", repo.remote, repo.branch], worktree, runner);
  const title = `Draft: ${repo.taskTitle}`.slice(0, 240);
  const existing = await runner("gh", ["pr", "view", repo.branch, "--json", "url,baseRefName,state,isDraft"], worktree).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    if (/no pull requests found for branch/i.test(message)) return "";
    throw new Error(`could not verify existing draft PR before publishing: ${message}`);
  });
  let pr: { url: string; baseRefName: string; state?: string; isDraft?: boolean };
  if (existing) {
    const parsed = JSON.parse(existing) as { url: string; baseRefName: string; state?: string; isDraft?: boolean };
    if (parsed.state && parsed.state !== "OPEN") throw new Error(`existing PR is ${parsed.state}; human recovery required before reusing this task branch`);
    if (parsed.baseRefName !== repo.prBaseBranch) throw new Error(`existing PR targets '${parsed.baseRefName}', expected '${repo.prBaseBranch}'; human stack repair required`);
    if (parsed.isDraft === false) await runner("gh", ["pr", "ready", repo.branch, "--undo"], worktree);
    pr = { url: parsed.url, baseRefName: parsed.baseRefName };
  } else {
    const body = `Paperclip task: ${input.taskId}\n\n${input.kind === "document" ? "Read-only exploration: this pull request only adds the report document; no code was changed." : "Automated review and deterministic quality gates passed."}${excluded.length ? `\n\nKept out of this PR: ${excluded.length} generated build file(s), for example \`${excluded[0]}\`.` : ""}\n\n${input.prompt.slice(0, 6000)}`;
    const created = await runner("gh", ["pr", "create", "--draft", "--base", repo.prBaseBranch, "--head", repo.branch, "--title", title, "--body", body], worktree);
    const url = created.match(/https:\/\/\S+/)?.[0];
    if (!url) throw new Error(`gh pr create did not return a PR URL: ${created.slice(0, 500)}`);
    pr = { url, baseRefName: repo.prBaseBranch };
  }
  // A rerun of the same task (Paperclip's review path, a retry) has its own branch; the earlier attempt's PR must not stay open next to it. Best effort: publishing already succeeded.
  const superseded = await closeSupersededPullRequests({ taskId: input.taskId, currentBranch: repo.branch, currentUrl: pr.url, worktree }, runner).catch(() => [] as string[]);
  return { branch: repo.branch, baseSha: repo.baseSha, headSha, prUrl: pr.url, prBaseBranch: pr.baseRefName, ...(superseded.length ? { superseded } : {}), ...(excluded.length ? { excludedGenerated: excluded.length } : {}) };
}

export type OpenPullRequest = { number: number; url: string; headRefName: string; body?: string };
/**
 * Open PRs that belong to the same task as the one just published but come from an earlier run. A task's branches share the prefix `taskBranch` builds, and the PR body
 * the orchestrator writes starts with an exact "Paperclip task: <id>" line; both must match, so a task whose id merely starts the same way is never touched.
 */
export function supersededPullRequests(open: OpenPullRequest[], taskId: string, currentBranch: string): OpenPullRequest[] {
  const prefix = `codex/${taskId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "")}-`;
  return open.filter(pr => pr.headRefName !== currentBranch && pr.headRefName.startsWith(prefix) && (pr.body ?? "").split(/\r?\n/, 1)[0] === `Paperclip task: ${taskId}`);
}

/** Closes the earlier attempts of a task with a pointer to the new PR. The branches stay (they are never deleted), so nothing is lost and a PR can be reopened. Returns the closed PR URLs. */
export async function closeSupersededPullRequests(input: { taskId: string; currentBranch: string; currentUrl: string; worktree: string }, runner = runCommand): Promise<string[]> {
  const open = JSON.parse(await runner("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,headRefName,body"], input.worktree)) as OpenPullRequest[];
  const closed: string[] = [];
  for (const pr of supersededPullRequests(open, input.taskId, input.currentBranch)) {
    await runner("gh", ["pr", "close", String(pr.number), "--comment", `Superseded by ${input.currentUrl}: a later run of the same task published there. This branch is kept; reopen this PR if it was closed by mistake.`], input.worktree);
    closed.push(pr.url);
  }
  return closed;
}

/** The project contract file as committed at `sha` (ADR 0011), or undefined when the repository has none. Reading the commit, not the working tree, keeps it the same text the task is built on. */
export async function readProjectContract(projectRoot: string, sha: string, file: string, maxChars: number, runner = runCommand): Promise<string | undefined> {
  if (!isSafeContractPath(file) || !/^[0-9a-f]{40,64}$/i.test(sha)) return undefined;
  const text = await git(["show", `${sha}:${file.replace(/\\/g, "/")}`], path.resolve(projectRoot), runner).catch(() => undefined);
  return text?.trim() ? text.slice(0, maxChars * 2) : undefined;
}

/** Name of the branch the worker assembles for a task that waits for several others; one per task branch, so a rerun never reuses another task's base. */
export const integrationBranchName = (taskBranchName: string): string => `integration/${taskBranchName.replace(/^codex\//, "")}`;

export type StackBase = { baseSha: string; prBaseBranch: string; integrateParents?: true };
/**
 * The commit and PR base a task starts from, decided at admission: the target branch with no blockers, the blocker's own branch with one (a stacked PR), and with several either
 * the configured integratedBaseBranch (it must already contain every blocker) or, without one, an integration branch the worker builds from the blockers' branches.
 * Every blocker branch must still be at the commit its run published, because anything else means the stack changed under the task.
 */
export async function resolveStackBase(input: { gitRoot: string; remote: string; targetBranch: string; integratedBaseBranch?: string; branch: string; admittedBaseSha: string; hasBlockers: boolean; parents: ParentPublication[] }, runner = runCommand): Promise<StackBase> {
  const { parents } = input;
  // With a configured integration branch the check is "it contains every blocker"; otherwise each blocker branch must still be at the commit its run published.
  if (!(parents.length > 1 && input.integratedBaseBranch)) for (const parent of parents) {
    const current = await resolveRemoteBranch(input.gitRoot, input.remote, parent.branch, runner);
    if (current !== parent.headSha) throw new Error(`dependency ${parent.issueId} branch moved since its published run; human stack recovery is required`);
  }
  if (parents.length === 1) return { baseSha: parents[0]!.headSha, prBaseBranch: parents[0]!.branch };
  if (parents.length > 1) {
    if (!input.integratedBaseBranch) return { baseSha: parents[0]!.headSha, prBaseBranch: integrationBranchName(input.branch), integrateParents: true };
    const integratedSha = await resolveRemoteBranch(input.gitRoot, input.remote, input.integratedBaseBranch, runner);
    for (const parent of parents) await git(["merge-base", "--is-ancestor", parent.headSha, integratedSha], input.gitRoot, runner).catch(() => { throw new Error(`integrated base '${input.integratedBaseBranch}' does not contain blocker ${parent.issueId} commit ${parent.headSha}`); });
    return { baseSha: integratedSha, prBaseBranch: input.integratedBaseBranch };
  }
  if (input.hasBlockers) throw new Error("resolved dependency metadata is missing; refusing to start a dependent task on an unrelated base");
  return { baseSha: input.admittedBaseSha, prBaseBranch: input.targetBranch };
}

const MERGE_IDENTITY = ["-c", "user.name=Paperclip Orchestrator", "-c", "user.email=paperclip-orchestrator@localhost"];
/**
 * Builds and pushes the base of a task that waits for several others (ADR 0011): a branch holding a merge of every blocker's published head. It is idempotent, so an Activity retry
 * reuses what is already pushed, and it never pushes a half-merged tree: a merge conflict removes the scratch worktree and fails with the conflicting files, because two parallel
 * tasks that changed the same lines need a person (or a dependency between them in the plan).
 */
export async function buildIntegrationBase(input: { projectRoot: string; remote: string; branch: string; parents: ParentPublication[] }, runner = runCommand): Promise<{ branch: string; baseSha: string; reused: boolean }> {
  const root = path.resolve(input.projectRoot); const name = integrationBranchName(input.branch);
  if (input.parents.length < 2) throw new Error("an integration base needs at least two blocker branches");
  for (const parent of input.parents) {
    const current = await resolveRemoteBranch(root, input.remote, parent.branch, runner);
    if (current !== parent.headSha) throw new Error(`parent branch '${parent.branch}' changed after admission; human stack recovery is required`);
  }
  const remoteHead = (await git(["ls-remote", "--heads", input.remote, `refs/heads/${name}`], root, runner)).split(/\s+/)[0] ?? "";
  if (remoteHead) {
    const existing = await resolveRemoteBranch(root, input.remote, name, runner);
    for (const parent of input.parents) await git(["merge-base", "--is-ancestor", parent.headSha, existing], root, runner).catch(() => { throw new Error(`integration branch '${name}' already exists without blocker ${parent.issueId}; human stack recovery is required`); });
    return { branch: name, baseSha: existing, reused: true };
  }
  const data = worktreesDir(); await mkdir(data, { recursive: true });
  const scratch = path.join(data, `integration-${name.slice("integration/".length).replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 80)}`);
  await git(["worktree", "add", "--detach", scratch, input.parents[0]!.headSha], root, runner);
  try {
    for (const parent of input.parents.slice(1)) {
      try { await git([...MERGE_IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `chore: integrate ${parent.issueId} into ${name}`, parent.headSha], scratch, runner); }
      catch (error) {
        const conflicts = await git(["diff", "--name-only", "--diff-filter=U"], scratch, runner).catch(() => "");
        await git(["merge", "--abort"], scratch, runner).catch(() => "");
        throw new Error(`blockers ${input.parents.map(item => item.issueId).join(", ")} cannot be combined: merging ${parent.issueId} conflicts${conflicts ? ` in ${conflicts.split(/\r?\n/).slice(0, 8).join(", ")}` : ` (${error instanceof Error ? error.message.slice(0, 200) : "merge failed"})`}; make one task depend on the other or resolve it by hand`);
      }
    }
    const baseSha = await git(["rev-parse", "HEAD"], scratch, runner);
    await git(["push", input.remote, `HEAD:refs/heads/${name}`], scratch, runner);
    return { branch: name, baseSha, reused: false };
  } finally {
    await git(["worktree", "remove", "--force", scratch], root, runner).catch(() => "");
  }
}

/** Rebase a stacked child after its parent PR merges; conflicts are left for a human. */
export async function syncMergedStack(input: { worktree: string; childBranch: string; parentPrUrl: string; targetBranch: string; remote: string }, runner = runCommand): Promise<{ updated: boolean; headSha?: string }> {
  const parent = JSON.parse(await runner("gh", ["pr", "view", input.parentPrUrl, "--json", "state,mergedAt"], input.worktree)) as { state: string; mergedAt: string | null };
  if (parent.state !== "MERGED" || !parent.mergedAt) return { updated: false };
  const child = JSON.parse(await runner("gh", ["pr", "view", input.childBranch, "--json", "baseRefName,state"], input.worktree)) as { baseRefName: string; state: string };
  if (child.state !== "OPEN") throw new Error(`child PR is ${child.state}; refusing automatic stack update`);
  if (child.baseRefName === input.targetBranch) return { updated: false };
  await git(["fetch", "--no-tags", input.remote, input.targetBranch], input.worktree, runner);
  await git(["rebase", `refs/remotes/${input.remote}/${input.targetBranch}`], input.worktree, runner);
  const headSha = await git(["rev-parse", "HEAD"], input.worktree, runner);
  await git(["push", "--force-with-lease", input.remote, input.childBranch], input.worktree, runner);
  await runner("gh", ["pr", "edit", input.childBranch, "--base", input.targetBranch], input.worktree);
  return { updated: true, headSha };
}
