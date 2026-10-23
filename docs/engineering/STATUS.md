# STATUS (rewritten each update)

- Phase: hardening through the e2e passes and the Paperclip runs (LOC-38, LOC-39). Real project e2e (dino-runner) green; CI green on the branch.
- Done: B-001..B-014, B-017..B-019, B-028, B-033 (drain-aware deploy), B-038 (visual verification), B-039 (OpenSpec delta correction). B-015 is partly done (SECURITY.md, PR template, Dependabot); LICENSE waits on the owner.
- In progress: B-027 (restart supervision done; the build stamp, where the worker logs its git SHA and doctor compares it to HEAD, is open).
- Open (todo), by next-up order: B-024 Paperclip-hop e2e (needs user decision), B-030 allow-list (FM-026), B-035 then B-026 then B-016 (cost accounting and budgets), B-031 review completeness, B-029 eval harness, B-034, B-032, B-036. Deferred with triggers: B-020 (superseded by B-029), B-021, B-022, B-023.
- Remote: origin https://github.com/rambosoft/orchestration-code. main = baseline only. mission/hardening pushed regularly. No PR opened.
- Test project: rambosoft/dino-runner (private), draft PRs stacked.
- Deploy: use `npm run deploy:worker [-WaitMinutes N]` (refuses while a run is in flight); `npm run drain` checks only. The bridge container redeploy is not drain-aware yet.
- Known gaps: Paperclip adapter hop only partly tested live; no token/cost budgets; no worker build stamp; review is weak at completeness; Claude implement can run npm/node (FM-026).
- Resume: read BACKLOG.md, run doctor, take the first todo by tier and score. Lessons are in research/lessons.md, failure modes FM-017..FM-037.

## 2026-10-23 update
- LOC-38 (difficulty curve, run 4) completed through Paperclip: all stages, analysis doc, draft PR rambosoft/dino-runner#5, one size warning shown (spec 10298 chars). It survived the worker being down ~38 min (Temporal held the workflow).
- FM-037 mitigated (adapter detaches on lease loss; deployed via Paperclip restart). Open: reconcile command not built.
- B-033 added `dev drain` and `scripts/deploy-worker.ps1`.
