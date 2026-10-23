import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { assertNoTestFlags, readJsonBody, tokenMatches } from "../src/http-guard.js";

describe("tokenMatches", () => {
  it("accepts only the exact bearer token", () => {
    expect(tokenMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(tokenMatches("Bearer s3cret!", "s3cret")).toBe(false);
    expect(tokenMatches("s3cret", "s3cret")).toBe(false);
    expect(tokenMatches(undefined, "s3cret")).toBe(false);
  });
});

describe("readJsonBody", () => {
  it("parses a body within the cap", async () => {
    expect(await readJsonBody(Readable.from([Buffer.from('{"a":1}')]), 100)).toEqual({ a: 1 });
  });
  it("rejects a body over the cap before parsing it", async () => {
    await expect(readJsonBody(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), 100)).rejects.toThrow(/too large/);
  });
});

describe("assertNoTestFlags", () => {
  const flagged = { injectReviewFailure: true };
  it("rejects test-injection flags unless explicitly allowed", () => {
    expect(() => assertNoTestFlags(flagged, {})).toThrow(/test-injection/);
    expect(() => assertNoTestFlags({ injectActivityTimeout: true }, {})).toThrow(/test-injection/);
  });
  it("allows them with ORCHESTRATOR_ALLOW_TEST_FLAGS=1 and ignores false flags", () => {
    expect(() => assertNoTestFlags(flagged, { ORCHESTRATOR_ALLOW_TEST_FLAGS: "1" })).not.toThrow();
    expect(() => assertNoTestFlags({ injectReviewFailure: false }, {})).not.toThrow();
  });
});
