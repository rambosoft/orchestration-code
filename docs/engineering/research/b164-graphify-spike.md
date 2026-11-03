# B-164: Graphify spike (2026-11-03)

Decision: **adopt, limited, later, behind the intelligence registry.** Not installed into any repository, not part of any run yet.

## What was tested
- Package `graphifyy` 0.9.101 (PyPI, Apache-2.0, homepage graphify.com), installed alone in a throw-away virtual environment; several unrelated GitHub projects share the name, so the PyPI package and its metadata were checked first. 34 packages in the environment (networkx, numpy, tree-sitter grammars).
- Run: `graphify update <folder> --no-cluster` on **copies** (a `git archive` of HEAD) of the legacy `luxus-app` and of `luxus-app-react`. The command is deterministic (tree-sitter, no model call). `graphify install` was never run, so nothing was written into a repository or an assistant configuration.

## Numbers
| | legacy luxus-app (782 tracked source files, 47 MB with docs and assets) | luxus-app-react (87 files) |
|---|---|---|
| build time | 48 s | 10 s |
| graph.json | 15.5 MB, 19,925 nodes, 37,495 edges | 250 KB, 555 nodes, 693 edges |
| edge kinds | contains 17,154; calls 12,689; imports 2,891; imports_from 1,738; method 1,446; references 911; indirect_call 349; dynamic_import 146 | contains 408; imports_from 109; imports 58; calls 40 |
| `.vue` support | yes: 174 components, 5,132 nodes | n/a |

## Does it add facts we lack?
Yes for the legacy side. Our inventory and `vue-extract` count what a component declares; Graphify adds the **call graph across files** (12,689 calls, 349 indirect, 146 dynamic imports), including inside `.vue` scripts, which our `ts-imports` tool does not scan.
Check on the module the storage design is about, `plugins/content-cache-manager/`: Graphify reports **16 code files** outside the module with import or call edges into it. A broader text search for the module's names finds 23 files. All 16 are in the text hits (no false positive in the sample); the 7 it misses refer to the module by string, in `nuxt.config.js`, quality-gate definitions and test runner scripts. So it is **precise but not complete**: use it for "who calls this", never to prove "nobody uses this".

## Costs and limits
- `graph.json` of the legacy app is 15.5 MB: it must be queried (`graphify path`, `explain`, or our own reader), never put in a prompt. Documentation headings are 40 % of the nodes and can be left out.
- Clustering and community naming are separate steps; naming calls a model and was not run.
- The sources that matter most for impact (config strings, test runners) are invisible to it, as above.

## Decision and follow-up
1. Adopt as an **optional intelligence tool for the reference (legacy) repository**: a future adapter `graphify-callers` (default off, advisory) that builds the graph once per reference commit in a cache folder outside the repository, and answers "which files call into the module a task ports". Pin `graphifyy==0.9.101`; run only in a copy or a cache folder; never `graphify install`.
2. Keep our own tools for the new repository: `ts-imports` is cheaper and exact for React and TypeScript.
3. Reject for now: running it on every task, putting its output in prompts, and its assistant-skill installation.
4. Build the adapter when the first M1 task needs the legacy call graph (the storage and Xtream ports are the likely first users); tracked as B-174.
