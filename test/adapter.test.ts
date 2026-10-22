import { describe, expect, it } from "vitest";
// @ts-expect-error The Paperclip adapter is published as JavaScript without a declaration file.
import { parseOpenSpecTaskMarker } from "../paperclip-adapter/index.js";

describe("Paperclip OpenSpec task control", () => {
  it("converts a standalone task marker to an override and removes it from the task prompt", () => {
    expect(parseOpenSpecTaskMarker("Add a percentage button.\n\nOpenSpec: off")).toEqual({ text: "Add a percentage button.", openSpec: false });
    expect(parseOpenSpecTaskMarker("OpenSpec: ON\nAdd a small feature")).toEqual({ text: "Add a small feature", openSpec: true });
    expect(parseOpenSpecTaskMarker("Add a small feature")).toEqual({ text: "Add a small feature" });
  });

  it("rejects contradictory task directives", () => {
    expect(parseOpenSpecTaskMarker("OpenSpec: on\nOpenSpec: off").error).toContain("conflicting");
  });
});
