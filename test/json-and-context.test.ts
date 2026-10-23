import { describe, expect, it } from "vitest";
import { z } from "zod";
import { firstBalancedObject, parseJsonLoose } from "../src/json-extract.js";
import { changeOnlyContext, openSpecCoverage, parseStructured } from "../src/handoffs.js";
import { capSummary, MAX_SUMMARY_CHARS } from "../src/providers.js";

describe("tolerant JSON extraction", () => {
  const schema = z.object({ a: z.number(), s: z.string() });
  it("accepts a bare object, a fenced block and an object inside prose", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go:\n```json\n{"a":2}\n```\nDone.')).toEqual({ a: 2 });
    expect(parseJsonLoose('The digest is {"a":3,"s":"has } brace and \\" quote"} as requested')).toEqual({ a: 3, s: 'has } brace and " quote' });
  });
  it("still rejects truncated or object-less answers", () => {
    expect(() => parseJsonLoose('{"a":1,"s":"cut off here')).toThrow(/complete JSON object/);
    expect(() => parseJsonLoose("no json at all")).toThrow();
    expect(firstBalancedObject('{"a":{"b":1}')).toBeUndefined();
  });
  it("parseStructured keeps schema validation and budget behaviour", () => {
    expect(parseStructured('```json\n{"a":1,"s":"x"}\n```', schema, "T", 1000)).toEqual({ a: 1, s: "x" });
    expect(() => parseStructured('{"a":"nope","s":"x"}', schema, "T", 1000)).toThrow("required schema");
    expect(() => parseStructured('{"a":1,"s":"x"}', schema, "T", 1)).toThrow("exceeds its");
  });
});

describe("provider output cap", () => {
  it("never silently truncates answers below the generous cap and records any cut", () => {
    const meta: Record<string, unknown> = {};
    expect(capSummary("x".repeat(9000), meta)).toHaveLength(9000);
    expect(meta.outputTruncated).toBeUndefined();
    expect(capSummary("y".repeat(MAX_SUMMARY_CHARS + 5), meta)).toHaveLength(MAX_SUMMARY_CHARS);
    expect(meta.outputTruncated).toMatchObject({ originalChars: MAX_SUMMARY_CHARS + 5 });
  });
});

describe("change-only OpenSpec context", () => {
  const context = ["### openspec/changes/c1/proposal.md\n\n## Why\nbecause", "### openspec/changes/c1/specs/dino/spec.md\n\n## MODIFIED Requirements\n\n### Requirement: Start screen\nIt SHALL show.\n\n#### Scenario: Idle\n- **WHEN** loaded", "### openspec/specs/dino/spec.md\n\n## Requirements\n\n### Requirement: Old one\nx\n\n#### Scenario: Old scenario\ny\n\n### Requirement: Old two\nz"].join("\n\n");
  it("drops main-spec sections so coverage scales with the change, keeps the change files", () => {
    const filtered = changeOnlyContext(context);
    expect(filtered).toContain("openspec/changes/c1/proposal.md");
    expect(filtered).toContain("Requirement: Start screen");
    expect(filtered).not.toContain("Old one");
    expect(openSpecCoverage(context).requirements).toHaveLength(3);
    expect(openSpecCoverage(filtered).requirements).toEqual(["Requirement: Start screen"]);
    expect(openSpecCoverage(filtered).scenarios).toEqual(["Scenario: Idle"]);
  });
  it("is the identity when there is no main spec section", () => {
    const only = "### openspec/changes/c1/proposal.md\n\n## Why\nbecause";
    expect(changeOnlyContext(only)).toBe(only);
  });
});
