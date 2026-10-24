import { describe, expect, it } from "vitest";
import { nextResumeId } from "../src/client.js";

describe("nextResumeId", () => {
  const id = "pc-2d798aed-fa0d-4acc-b2ca-dd71232d446e-2026-10-24T20-32-24.486Z-a1";
  it("starts at resume1 when the run was never resumed", () => {
    expect(nextResumeId(id, [id])).toBe(`${id}-resume1`);
    expect(nextResumeId(id, [])).toBe(`${id}-resume1`);
  });
  it("takes the next free number, also when the id passed in is itself a resume", () => {
    expect(nextResumeId(id, [id, `${id}-resume1`, `${id}-resume2`])).toBe(`${id}-resume3`);
    expect(nextResumeId(`${id}-resume1`, [id, `${id}-resume1`])).toBe(`${id}-resume2`);
  });
  it("ignores other tasks and ids that merely share a prefix", () => {
    expect(nextResumeId(id, [`${id}-resume1x`, "pc-other-1-a1-resume9", `${id}-resumeabc`])).toBe(`${id}-resume1`);
  });
});
