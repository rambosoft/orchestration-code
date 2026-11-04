// Task-size gate tracking and the needs-split report. Pure functions: run records in, bands and advice out; the CLI and the Paperclip report call them. Not used by workflow code.
import type { ProjectManifest, RunResult } from "./contracts.js";
import type { SizeHint } from "./lanes.js";
import { proposeSplit, sizeLimitsFor, type SizeEstimate, type SizeLimits } from "./task-size.js";

export type SizeRecord = { estimate?: SizeEstimate; status: string; failureKind?: string; changedFiles?: number; attempts?: number };
export type BandStats = { runs: number; failed: number; sizeSuspected: number };
export type SizeReport = { bands: Record<SizeHint, BandStats>; advice: string[] };
const BANDS: SizeHint[] = ["small", "normal", "large"];
const LOWER: Record<SizeHint, string> = {
  small: "lower sizing.smallMaxFiles so fewer tasks count as small",
  normal: "lower sizing.largeMinFiles or sizing.maxAreas so such tasks are flagged large before they run",
  large: "lower sizing.largeMinFiles or sizing.maxAreas so such tasks are split before they run",
};

/** Estimate against outcome per size band. Advice names a threshold to lower for a band when at least 2 of its runs, and at least 25% of them, were stopped as size suspected. Runs without an estimate count as normal. */
export function sizeReport(records: SizeRecord[]): SizeReport {
  const bands = Object.fromEntries(BANDS.map(band => [band, { runs: 0, failed: 0, sizeSuspected: 0 }])) as Record<SizeHint, BandStats>;
  for (const record of records) {
    const band = bands[record.estimate?.hint ?? "normal"];
    band.runs++;
    if (record.status === "failed") band.failed++;
    if (record.failureKind === "size") band.sizeSuspected++;
  }
  const advice = BANDS.flatMap(band => { const { runs, sizeSuspected } = bands[band]; return sizeSuspected >= 2 && sizeSuspected * 4 >= runs ? [`${band} band: ${sizeSuspected} of ${runs} runs were size suspected; ${LOWER[band]}`] : []; });
  return { bands, advice };
}

export function formatSizeReport(report: SizeReport): string {
  const rows = BANDS.map(band => `${band.padEnd(7)} runs ${String(report.bands[band].runs).padStart(3)}  failed ${String(report.bands[band].failed).padStart(3)}  size suspected ${String(report.bands[band].sizeSuspected).padStart(3)}`);
  return [...rows, ...(report.advice.length ? ["", "Advice:", ...report.advice.map(line => `- ${line}`)] : ["", "No threshold needs lowering."])].join("\n");
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** The size records in one run record file (the `e2e --record` shape: an `outcomes` list). Any other shape yields nothing; never throws. */
export function runRecords(json: unknown): SizeRecord[] {
  if (!isObject(json) || !Array.isArray(json.outcomes)) return [];
  return json.outcomes.flatMap((item): SizeRecord[] => {
    if (!isObject(item) || typeof item.status !== "string") return [];
    // sizeEstimate is recorded for every outcome; estimate is the older field (size failures only) of records written before it.
    const recorded = isObject(item.sizeEstimate) ? item.sizeEstimate : item.estimate;
    const estimate = isObject(recorded) && BANDS.includes(recorded.hint as SizeHint) ? recorded as unknown as SizeEstimate : undefined;
    return [{ status: item.status, ...(typeof item.attempt === "number" ? { attempts: item.attempt } : {}), ...(estimate ? { estimate } : {}), ...(typeof item.failureKind === "string" ? { failureKind: item.failureKind } : {}), ...(typeof item.changedFiles === "number" ? { changedFiles: item.changedFiles } : {}) }];
  });
}

/** A result the workflow stopped as too large for one pass (B-183): message `needs split: ...` or size metadata. */
export function isNeedsSplit(result: Pick<RunResult, "message" | "metadata"> | undefined): boolean {
  return Boolean(result && (String(result.message ?? "").startsWith("needs split:") || result.metadata?.size?.kind === "size_suspected"));
}

/** The comment section for a person after a size-suspected failure (manual mode: nothing is created). The failure message already carries the activity counts. A split proposal needs a real file list; without one it says so rather than inventing files. */
export function needsSplitSection(result: Pick<RunResult, "message" | "metadata">, files?: string[], limits?: SizeLimits): string {
  const size = result.metadata?.size, estimate = size?.estimate;
  const proposal = files?.length && limits ? proposeSplit(files, limits) : [];
  return ["### Needs a split",
    "The run stopped because this task looks too large for one pass. Nothing was created; split it by hand and create the parts as new issues.",
    ...(size?.reason ? [`Reason: ${size.reason}`] : []),
    ...(estimate ? [`Estimate: ${estimate.hint}, ${estimate.files} files, ${estimate.areas} areas (${estimate.basis})${estimate.reasons.length ? `; ${estimate.reasons.join("; ")}` : ""}`] : []),
    `Evidence: ${String(result.message ?? "").replace(/^needs split:\s*/, "").slice(0, 1500)}`,
    proposal.length ? `Proposed split:\n${proposal.map(part => `- ${part.title} (${part.files.length}): ${part.files.join(", ")}`).join("\n")}` : "Proposed split: no file list recorded; split by area."].join("\n");
}

/** Options for `plan-from-survey` from the project manifest: the size limits for the generation gate and the merge flag. No manifest: no sizing (output unchanged). */
export function surveySizing(manifest: Pick<ProjectManifest, "tier" | "sizing"> | undefined, mergeSmall: boolean): { limits?: SizeLimits; mergeSmall?: boolean } {
  if (!manifest) { if (mergeSmall) throw new Error("--merge-small needs --manifest <project manifest file> (the size limits come from it)"); return {}; }
  return { limits: sizeLimitsFor(manifest), ...(mergeSmall ? { mergeSmall: true } : {}) };
}
