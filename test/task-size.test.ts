import { describe, expect, it } from "vitest";
import { DEFAULT_SIZE_LIMITS, areaOf, estimateSize, filesNamedIn } from "../src/task-size.js";

const production = DEFAULT_SIZE_LIMITS.production;
const files = (n: number, dir = "src") => Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`);

describe("task size estimator", () => {
  it("has the per-tier default limits", () => {
    expect(DEFAULT_SIZE_LIMITS.throwaway).toEqual({ smallMaxFiles: 3, largeMinFiles: 40, maxAreas: 6 });
    expect(DEFAULT_SIZE_LIMITS.prototype).toEqual({ smallMaxFiles: 3, largeMinFiles: 40, maxAreas: 6 });
    expect(DEFAULT_SIZE_LIMITS.mvp).toEqual({ smallMaxFiles: 2, largeMinFiles: 12, maxAreas: 3 });
    expect(production).toEqual({ smallMaxFiles: 2, largeMinFiles: 10, maxAreas: 2 });
  });
  it("an empty list is unknown and normal", () => {
    expect(estimateSize({ files: [] }, production)).toMatchObject({ hint: "normal", basis: "unknown", files: 0, areas: 0 });
  });
  it("two files in one area is small", () => {
    expect(estimateSize({ files: ["src/a/x.ts", "src/a/y.ts"], basis: "measured" }, production)).toMatchObject({ hint: "small", files: 2, areas: 1, basis: "measured" });
  });
  it("defaults the basis to text", () => {
    expect(estimateSize({ files: ["src/a/x.ts"] }, production).basis).toBe("text");
  });
  it("11 files on production is large and the reason names the limit", () => {
    const estimate = estimateSize({ files: files(11) }, production);
    expect(estimate.hint).toBe("large");
    expect(estimate.reasons.join(" ")).toContain("10");
  });
  it("3 files in 3 areas on production is large (areas above 2)", () => {
    const estimate = estimateSize({ files: ["src/a/x.ts", "app/b/y.ts", "lib/c.ts"] }, production);
    expect(estimate).toMatchObject({ hint: "large", areas: 3 });
    expect(estimate.reasons.join(" ")).toContain("2");
  });
  it("3 files in one area is normal on production, small on prototype", () => {
    expect(estimateSize({ files: files(3) }, production).hint).toBe("normal");
    expect(estimateSize({ files: files(3) }, DEFAULT_SIZE_LIMITS.prototype).hint).toBe("small");
  });
  it("backslash and slash spellings are one file in one area", () => {
    expect(estimateSize({ files: ["src\\a\\B.ts", "src/a/B.ts"] }, production)).toMatchObject({ files: 1, areas: 1, hint: "small" });
  });
  it("areaOf takes the first segment under a source root, the package name for packages, else the first segment", () => {
    expect(areaOf("src\\player\\x.ts")).toBe("src/player");
    expect(areaOf("app/store/x.ts")).toBe("app/store");
    expect(areaOf("packages/core/src/x.ts")).toBe("packages/core");
    expect(areaOf("docs/a/b.md")).toBe("docs");
    expect(areaOf("README.md")).toBe("README.md");
  });
  it("filesNamedIn finds relative source paths once", () => {
    expect(filesNamedIn("edit src/app/App.tsx and src/app/App.tsx")).toEqual(["src/app/App.tsx"]);
    expect(filesNamedIn("change src\\a\\B.ts, then test/b.test.ts. See https://x.com/a/b.js")).toEqual(["src/a/B.ts", "test/b.test.ts"]);
    expect(filesNamedIn("no files here, version 1.2.3")).toEqual([]);
  });
});
