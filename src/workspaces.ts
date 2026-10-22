import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { RepositoryContext, PublishResult } from "./contracts.js";
import { findPublishViolations } from "./publish-guard.js";

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<string>;
export const runCommand: CommandRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, shell: false, windowsHide: true }); const out: Buffer[] = []; const err: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => out.push(b)); child.stderr.on("data", (b: Buffer) => err.push(b));
  child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(out).toString("utf8").trim()) : reject(new Error(Buffer.concat(err).toString("utf8").trim() || `${command} exited ${code}`)));
});
const git = (args: string[], cwd: string, runner = runCommand) => runner("git", args, cwd);

/** Fail closed before dispatch: never snapshot a dirty tree or invent a base. */
export async function admitRepository(input: { projectRoot: string; remote: string; targetBranch: string }, runner = runCommand): Promise<{ baseSha: string; remoteUrl: string }> {
  const root = path.resolve(input.projectRoot);
  await git(["rev-parse", "--show-toplevel"], root, runner);
  const status = await git(["status", "--porcelain", "--untracked-files=all"], root, runner);
  if (status) throw new Error(`project working tree is not clean (tracked or untracked changes): ${status.slice(0, 1000)}`);
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
  const base = path.resolve(process.env.ORCHESTRATOR_DATA_DIR ?? "data", "worktrees"); await mkdir(base, { recursive: true });
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
export async function publishWorktree(input: { repository: RepositoryContext; worktree: string; taskId: string; prompt: string }, runner = runCommand): Promise<PublishResult> {
  const { repository: repo, worktree } = input;
  const status = await git(["status", "--porcelain", "--untracked-files=all"], worktree, runner);
  if (status) {
    await git(["add", "--all"], worktree, runner);
    const violations = await findPublishViolations(worktree, runner);
    if (violations.length) throw new Error(`publish guard blocked the commit; nothing was pushed: ${violations.join("; ")}`);
    await git(["-c", "user.name=Paperclip Orchestrator", "-c", "user.email=paperclip-orchestrator@localhost", "commit", "-m", `chore(${input.taskId}): orchestrated implementation`], worktree, runner);
  }
  const headSha = await git(["rev-parse", "HEAD"], worktree, runner);
  if (headSha === repo.baseSha) throw new Error("publish gate failed: no changes were committed");
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
    const body = `Paperclip task: ${input.taskId}\n\nAutomated review and deterministic quality gates passed.\n\n${input.prompt.slice(0, 6000)}`;
    const created = await runner("gh", ["pr", "create", "--draft", "--base", repo.prBaseBranch, "--head", repo.branch, "--title", title, "--body", body], worktree);
    const url = created.match(/https:\/\/\S+/)?.[0];
    if (!url) throw new Error(`gh pr create did not return a PR URL: ${created.slice(0, 500)}`);
    pr = { url, baseRefName: repo.prBaseBranch };
  }
  return { branch: repo.branch, baseSha: repo.baseSha, headSha, prUrl: pr.url, prBaseBranch: pr.baseRefName };
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
