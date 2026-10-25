import path from "node:path";
import { describe, expect, it } from "vitest";
import { worktreesDir } from "../src/env.js";

describe("worktreesDir", () => {
  it("defaults to <data dir>/worktrees", () => {
    expect(worktreesDir("data", {})).toBe(path.resolve("data", "worktrees"));
    expect(worktreesDir("C:/orch-data", {})).toBe(path.resolve("C:/orch-data", "worktrees"));
  });
  it("uses ORCHESTRATOR_WORKTREES_DIR when set, so a Unity worker can keep project paths short", () => {
    expect(worktreesDir("data", { ORCHESTRATOR_WORKTREES_DIR: "C:/w" })).toBe(path.resolve("C:/w"));
  });
});
