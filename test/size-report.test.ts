import { describe, expect, it } from "vitest";
import { formatSizeReport, isNeedsSplit, needsSplitSection, runRecords, sizeReport, surveySizing } from "../src/size-report.js";
import { DEFAULT_SIZE_LIMITS, type SizeEstimate } from "../src/task-size.js";
import { planFromBacklog } from "../src/plan-from-survey.js";
import { BacklogItemSchema } from "../src/survey.js";
import type { RunResult } from "../src/contracts.js";

const est = (hint: SizeEstimate["hint"], files = 5): SizeEstimate => ({ hint, files, areas: 1, basis: "text", reasons: [] });
const rec = (hint: SizeEstimate["hint"] | undefined, status: string, failureKind?: string) => ({ ...(hint ? { estimate: est(hint) } : {}), status, ...(failureKind ? { failureKind } : {}) });

describe("sizeReport", () => {
  it("counts runs per band, defaulting runs without an estimate to normal", () => {
    const report = sizeReport([rec("small", "completed"), rec(undefined, "failed"), rec("normal", "completed"), rec("large", "failed", "size")]);
    expect(report.bands).toEqual({ small: { runs: 1, failed: 0, sizeSuspected: 0 }, normal: { runs: 2, failed: 1, sizeSuspected: 0 }, large: { runs: 1, failed: 1, sizeSuspected: 1 } });
  });
  it("names a threshold to lower when 3 of 4 large runs were size suspected, and says nothing when none were", () => {
    const report = sizeReport([rec("large", "failed", "size"), rec("large", "failed", "size"), rec("large", "failed", "size"), rec("large", "completed")]);
    expect(report.advice).toHaveLength(1);
    expect(report.advice[0]).toMatch(/large band.*3 of 4.*sizing\.largeMinFiles/);
    expect(sizeReport([rec("large", "completed"), rec("large", "failed")]).advice).toEqual([]);
  });
  it("needs at least 2 size-suspected runs and 25% of the band", () => {
    expect(sizeReport([rec("normal", "failed", "size")]).advice).toEqual([]);
    expect(sizeReport([rec("normal", "failed", "size"), rec("normal", "failed", "size"), ...Array.from({ length: 7 }, () => rec("normal", "completed"))]).advice).toEqual([]);
    expect(sizeReport([rec("small", "failed", "size"), rec("small", "failed", "size")]).advice[0]).toMatch(/small band.*sizing\.smallMaxFiles/);
  });
  it("prints bands and advice", () => {
    const text = formatSizeReport(sizeReport([rec("large", "failed", "size"), rec("large", "failed", "size")]));
    expect(text).toContain("large"); expect(text).toContain("lower");
  });
});

describe("runRecords", () => {
  it("maps e2e outcomes tolerantly and skips shapes it does not know", () => {
    const rows = runRecords({ outcomes: [{ taskId: "T", status: "failed", attempt: 2, estimate: est("large"), failureKind: "size", changedFiles: 4 }, { taskId: "U", status: "completed" }, "junk", { nothing: 1 }] });
    expect(rows).toEqual([{ status: "failed", attempts: 2, estimate: est("large"), failureKind: "size", changedFiles: 4 }, { status: "completed" }]);
    for (const odd of [null, 3, "x", [], { outcomes: "no" }, { schema_version: 1, scenario: "dino" }]) expect(runRecords(odd)).toEqual([]);
  });
  it("reads sizeEstimate (recorded for every outcome) before the older estimate field, so completed runs land in their band", () => {
    const rows = runRecords({ outcomes: [{ status: "completed", sizeEstimate: est("large") }, { status: "failed", sizeEstimate: est("small"), estimate: est("large"), failureKind: "size" }] });
    expect(rows).toEqual([{ status: "completed", estimate: est("large") }, { status: "failed", estimate: est("small"), failureKind: "size" }]);
    expect(sizeReport(rows).bands.large).toEqual({ runs: 1, failed: 0, sizeSuspected: 0 });
  });
});

describe("needs-split section", () => {
  const failed = (over: Partial<RunResult> = {}): RunResult => ({ runId: "r", status: "failed", stages: [], artifactRefs: [], message: "needs split: implement timed out after 30 min (12 file changes, 40 commands)", metadata: { size: { kind: "size_suspected", reason: "implement timeout", estimate: est("large", 14) } } as never, ...over } as RunResult);
  it("recognises a needs-split result by message or metadata only", () => {
    expect(isNeedsSplit(failed())).toBe(true);
    expect(isNeedsSplit(failed({ message: "boom" }))).toBe(true);
    expect(isNeedsSplit(failed({ message: "needs split: x", metadata: undefined }))).toBe(true);
    expect(isNeedsSplit(failed({ message: "boom", metadata: undefined }))).toBe(false);
  });
  it("shows reason, estimate and the failure message, and never invents files", () => {
    const text = needsSplitSection(failed());
    expect(text).toContain("implement timeout"); expect(text).toContain("14 files"); expect(text).toContain("12 file changes, 40 commands");
    expect(text).toContain("no file list recorded; split by area");
  });
  it("proposes parts when a file list is known", () => {
    const text = needsSplitSection(failed(), Array.from({ length: 14 }, (_, i) => `src/${i % 3 === 0 ? "a" : "b"}/f${i}.ts`), DEFAULT_SIZE_LIMITS.production);
    expect(text).toContain("src/a part 1"); expect(text).not.toContain("no file list recorded");
  });
});

describe("survey sizing options", () => {
  const manifest = { tier: "production" } as never;
  it("is empty without a manifest and carries limits and the merge flag with one", () => {
    expect(surveySizing(undefined, false)).toEqual({});
    expect(surveySizing(manifest, true)).toEqual({ limits: DEFAULT_SIZE_LIMITS.production, mergeSmall: true });
    expect(surveySizing(manifest, false)).toEqual({ limits: DEFAULT_SIZE_LIMITS.production });
    expect(() => surveySizing(undefined, true)).toThrow(/--manifest/);
  });
  it("makes the generation gate reachable: a large item is listed as needing a split", () => {
    const item = BacklogItemSchema.parse({ id: "R1", title: "Big", kind: "logic", size: "L", old_paths: Array.from({ length: 6 }, (_, i) => `src/m${i}/f.ts`), target: "t", depends_on: [], tests: [], changes_behaviour: false, area: "general", critical: false });
    expect(planFromBacklog([item], { projectId: "p", prefix: "P", ...surveySizing(manifest, false) }).needsSplit.map(entry => entry.id)).toEqual(["R1"]);
  });
});
