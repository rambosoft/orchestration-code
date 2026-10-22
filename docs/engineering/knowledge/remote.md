# Remote

- URL: https://github.com/rambosoft/orchestration-code (`origin`), visibility PUBLIC, default branch `main`.
- Auth: `gh` CLI keyring login (account `rambosoft`), HTTPS. No tokens stored in repo or URLs.
- Repo layout decision (user, 2026-10-22): `C:\workspace\test-orch` had no `.git`; it sat inside the parent repo `C:\workspace` (origin `vela-immo`), untracked. A nested repo was created (`git init -b main`) and `test-orch/` was added to the parent's `.git/info/exclude` (local only; parent tracked files and uncommitted work untouched).
- Pre-publication scan (2026-10-22): regex scan (key/token/private-key/password patterns) over all files to be committed and over the staged diff: 0 hits. No gitleaks/trufflehog installed. `.env`, `data/`, `.runtime/`, `*.log`, `node_modules/`, `dist/`, `.playwright-mcp/` are git-ignored. Added `demo/project/` (embedded git repo) and `landing-page-review.png` to `.gitignore`. Local history had no prior commits in this repo, so there was no history to leak.
- No LICENSE exists. Choice is the owner's; not added by the agent. (BACKLOG B-0xx)

## Push log
| When | Ref | Commit | Notes |
|---|---|---|---|
| 2026-10-22 | main | 99c5f00 | one-time baseline of existing code to empty remote |

## Owner actions recommended on GitHub (not applied)
Branch protection on `main` (require PR + the CI check), enable secret scanning + push protection, enable Dependabot alerts, choose a LICENSE.
