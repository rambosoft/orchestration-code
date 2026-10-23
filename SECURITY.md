# Security policy

Report vulnerabilities privately via GitHub Security Advisories on this repository (Security tab > Report a vulnerability). Do not open public issues for security problems.

Scope notes: the bridge (`src/server.ts`) must only be exposed on a trusted network and always behind `ORCHESTRATOR_API_TOKEN`. Model-written code runs on the host worker; see `docs/engineering/knowledge/failure-modes.yaml` for known residual risks.
