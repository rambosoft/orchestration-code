import { describe, expect, it } from "vitest";
import { stripBenignEditorNoise } from "../src/unity.js";

const header = "The build succeeded, but the Editor log reported the following errors:";
const licence = "  [license] [Licensing::Module] LicensingClient has failed validation; ignoring";

describe("stripBenignEditorNoise", () => {
  it("removes the licensing client message and its header when nothing else is reported (the case seen in every verify)", () => {
    const text = `Build started\n${header}\n${licence}\nBuild finished`;
    expect(stripBenignEditorNoise(text)).toBe("Build started\nBuild finished");
  });
  it("keeps the header and the real errors when something else is reported with it", () => {
    const text = `${header}\n${licence}\n  CS0246 Assets\\Scripts\\A.cs(1,7): The type or namespace name 'Foo' could not be found\nDone`;
    const cleaned = stripBenignEditorNoise(text);
    expect(cleaned).toContain(header);
    expect(cleaned).toContain("CS0246");
    expect(cleaned).not.toContain("LicensingClient has failed validation");
    expect(cleaned.endsWith("Done")).toBe(true);
  });
  it("handles the test-run wording and the signature line in the raw Editor log", () => {
    expect(stripBenignEditorNoise("The test run completed, but the Editor log reported the following errors:\n  [license] [Licensing::Module] Error: Access token is unavailable; failed to update")).toBe("");
    expect(stripBenignEditorNoise("[Licensing::Client] Code 10 while verifying Licensing Client signature (process Id: 16772)\nok")).toBe("ok");
  });
  it("leaves a genuine licence problem and ordinary output alone", () => {
    const real = "No valid Unity Editor license found. Please activate your license.";
    expect(stripBenignEditorNoise(real)).toBe(real);
    expect(stripBenignEditorNoise("")).toBe("");
    expect(stripBenignEditorNoise("line one\nline two")).toBe("line one\nline two");
  });
});
