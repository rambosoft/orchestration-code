import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Tests must never append to the live worker logs (data/logs/worker-activity-events.jsonl): fake runs named "r" or "t" once made `npm run timing` and `npm run usage` report phantom tasks.
// A test that needs a specific data directory sets ORCHESTRATOR_DATA_DIR itself.
process.env.ORCHESTRATOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "orch-test-data-"));
