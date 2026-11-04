import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManifestSchema } from "../src/contracts.js";
import { DEFAULT_SIZE_LIMITS, sizeLimitsFor } from "../src/task-size.js";

const base = { id: "proj", name: "proj", root: "proj", defaultProfile: "implementation" };
const parse = (extra: Record<string, unknown> = {}) => ProjectManifestSchema.parse({ ...base, ...extra });

describe("sizing, testScope and lanes manifest options", () => {
  it("leaves manifests without the new fields unchanged (no keys added), including every shipped manifest", () => {
    const m = parse();
    for (const key of ["sizing", "testScope", "lanes"]) expect(key in m).toBe(false);
    const files = [...readdirSync("projects").filter((f) => f.endsWith(".json")).map((f) => join("projects", f)), "project.example.json"];
    for (const file of files) {
      const parsed = ProjectManifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      for (const key of ["sizing", "testScope", "lanes"]) expect(key in parsed, `${file} ${key}`).toBe(false);
    }
  });
  it("sizeLimitsFor: absent tier means production, manifest numbers override the tier defaults", () => {
    expect(sizeLimitsFor(parse())).toEqual(DEFAULT_SIZE_LIMITS.production);
    expect(sizeLimitsFor(parse({ tier: "prototype" }))).toEqual(DEFAULT_SIZE_LIMITS.prototype);
    expect(sizeLimitsFor(parse({ sizing: { largeMinFiles: 8 } }))).toEqual({ ...DEFAULT_SIZE_LIMITS.production, largeMinFiles: 8 });
    expect(sizeLimitsFor(parse({ tier: "mvp", sizing: { smallMaxFiles: 1, largeMinFiles: 20, maxAreas: 5 } }))).toEqual({ smallMaxFiles: 1, largeMinFiles: 20, maxAreas: 5 });
  });
  it("sizing defaults: onSizeFailure manual, firstEditMinutes 15, idleMinutes 10; accepts propose and auto", () => {
    expect(parse({ sizing: {} }).sizing).toEqual({ onSizeFailure: "manual", firstEditMinutes: 15, idleMinutes: 10 });
    expect(parse({ sizing: { onSizeFailure: "auto" } }).sizing?.onSizeFailure).toBe("auto");
    expect(() => parse({ sizing: { onSizeFailure: "x" } })).toThrow();
    expect(() => parse({ sizing: { largeMinFiles: 0 } })).toThrow();
    expect(() => parse({ sizing: { maxAreas: 501 } })).toThrow();
    expect(() => parse({ sizing: { firstEditMinutes: 241 } })).toThrow();
  });
  it("testScope accepts affected and full only", () => {
    expect(parse({ testScope: "affected" }).testScope).toBe("affected");
    expect(parse({ testScope: "full" }).testScope).toBe("full");
    expect(() => parse({ testScope: "x" })).toThrow();
  });
  it("lanes maps a lane to a non-empty list of known stages", () => {
    expect(parse({ lanes: { light: ["implement", "verify"] } }).lanes).toEqual({ light: ["implement", "verify"] });
    expect(() => parse({ lanes: { light: [] } })).toThrow();
    expect(() => parse({ lanes: { light: ["deploy"] } })).toThrow();
    expect(() => parse({ lanes: { huge: ["plan"] } })).toThrow();
  });
  it("a lanes list must keep implement and verify", () => {
    for (const list of [["plan", "implement"], ["review", "verify"]]) expect(() => parse({ lanes: { heavy: list } }), list.join(",")).toThrow(/implement and verify/);
    expect(parse({ lanes: { heavy: ["plan", "implement", "verify"] } }).lanes).toEqual({ heavy: ["plan", "implement", "verify"] });
  });
  it("sizing.smallMaxFiles must be below sizing.largeMinFiles when both are set", () => {
    for (const sizing of [{ smallMaxFiles: 5, largeMinFiles: 5 }, { smallMaxFiles: 9, largeMinFiles: 4 }]) expect(() => parse({ sizing }), JSON.stringify(sizing)).toThrow(/smallMaxFiles/);
    expect(parse({ sizing: { smallMaxFiles: 4, largeMinFiles: 5 } }).sizing).toMatchObject({ smallMaxFiles: 4, largeMinFiles: 5 });
    expect(parse({ sizing: { smallMaxFiles: 50 } }).sizing).toMatchObject({ smallMaxFiles: 50 });
  });
});
