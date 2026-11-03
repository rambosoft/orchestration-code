// The pack ships the design rules as scripts/check-design.mjs (R-024, B-159); the orchestrator applies them in src/design-gate.ts at admission. The two must agree on every document, problem for problem.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { designProblems } from "../src/design-gate.js";

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

const doc = (over: { status?: string; open?: string; review?: string; constraints?: string; skip?: string } = {}): string => {
  const sections: Record<string, string> = {
    "Purpose": "Store the catalogue so a TV with little memory can page it.",
    "Protected constraints": over.constraints ?? "- D-001 Catalogue data is stored in IndexedDB only through the storage interface.",
    "Interfaces": "Storage: get(key), put(batch), evict(policy).",
    "Failure modes": "Quota exceeded: evict, then surface a typed error.",
    "Test plan": "Table-driven tests for eviction.",
    "Open questions": over.open ?? "none",
    "Review record": over.review ?? "- claude 2026-11-03 approved: checked from a fresh context.",
  };
  return ["# Design: storage", `Status: ${over.status ?? "approved"}`, "Area: storage", "Author: codex", "", ...Object.entries(sections).filter(([name]) => name !== over.skip).flatMap(([name, body]) => [`## ${name}`, body, ""])].join("\n");
};

async function packCheck(text: string | undefined): Promise<{ code: number; problems: string[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-design-")); dirs.push(root);
  if (text !== undefined) {
    await mkdir(path.join(root, "docs/design"), { recursive: true });
    await writeFile(path.join(root, "docs/design/storage.md"), text);
    await writeFile(path.join(root, "docs/design/_TEMPLATE.md"), "not a design, never checked");
  }
  try { await promisify(execFile)("node", ["templates/react-ts-vite/scripts/check-design.mjs", root]); return { code: 0, problems: [] }; }
  catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, problems: [...(failure.stderr ?? "").matchAll(/^- docs\/design\/storage\.md: (.+)$/gm)].map(match => match[1]!) };
  }
}

describe("the pack's check:design agrees with the orchestrator", () => {
  const cases: Array<[string, string]> = [
    ["an approved design", doc()],
    ["a draft with open questions", doc({ status: "draft", review: "- claude 2026-11-03 changes: not ready", open: "Which quota?" })],
    ["a missing section", doc({ skip: "Failure modes" })],
    ["no constraints", doc({ constraints: "Be careful." })],
    ["repeated constraint ids", doc({ constraints: "- D-001 One.\n- D-001 Two." })],
    ["open questions on an approved design", doc({ open: "Which quota?" })],
    ["a review by the author", doc({ review: "- codex 2026-11-03 approved: fine" })],
    ["a later request for changes", doc({ review: "- claude 2026-11-03 approved: ok\n- claude 2026-11-04 changes: vague" })],
    ["no status and no area", doc().replace("Status: approved\n", "").replace("Area: storage\n", "")],
    ["CRLF line endings", doc().replace(/\n/g, "\r\n")],
  ];
  it.each(cases)("%s", async (_name, text) => {
    const expected = designProblems(text);
    const actual = await packCheck(text);
    expect(actual.problems).toEqual(expected);
    expect(actual.code).toBe(expected.length ? 1 : 0);
  }, 30_000);
  it("passes a project without designs and ignores the template", async () => { expect((await packCheck(undefined)).code).toBe(0); });
});
