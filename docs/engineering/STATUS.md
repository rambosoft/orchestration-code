# STATUS (rewritten each update)

- Phase: hardening complete through the e2e pass. Real project e2e (dino-runner, 3 stacked tasks, Codex plus Claude implement) green; CI green on the branch.
- Done: B-001..B-013, B-019, plus B-010 (cleanup), B-014 (env validation), B-017 (doctor). B-012 CI is verified green (commit 163b60f onward).
- Open (todo): B-015 LICENSE (owner), B-016 budgets, B-018 CI secret scan, B-024 Paperclip-hop e2e (needs user decision), B-025..B-031 (see BACKLOG). Deferred with triggers: B-020 (superseded by B-029), B-021, B-022, B-023.
- Remote: origin https://github.com/rambosoft/orchestration-code. main = baseline only. mission/hardening pushed regularly. No PR opened.
- Test project: rambosoft/dino-runner (private), draft PRs #1-#3 stacked.
- Running stack at the end of this pass: docker bridge rebuilt earlier; the host worker was found not polling by doctor and must be restarted before the next run (see runbooks/operate-and-e2e.md).
- Known gaps: Paperclip adapter hop untested live; no token/cost budgets; no worker supervision; review is weak at completeness; Claude implement can run npm/node (FM-026).
- Resume: read BACKLOG.md, run doctor, take the first todo by tier and score. Lessons are in research/lessons.md, failure modes FM-017..FM-027.
