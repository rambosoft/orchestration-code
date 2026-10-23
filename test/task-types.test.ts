import { describe, expect, it } from "vitest";
// @ts-expect-error The Paperclip adapter is published as JavaScript without a declaration file.
import { issueLabelNames } from "../paperclip-adapter/index.js";
import { parseTaskDirectives } from "../src/openspec-policy.js";
import { profiles } from "../src/profiles.js";
import { normalizeTaskType, resolveTaskType, taskTypeFromProfile, taskTypes } from "../src/task-types.js";

describe("task type resolution", () => {
  it("accepts type labels in the usual spellings and bare unambiguous names", () => {
    expect(resolveTaskType({ labels: ["type:bug"] })).toEqual({ type: "bug", source: "label" });
    expect(resolveTaskType({ labels: ["Type / Research"] })).toEqual({ type: "research", source: "label" });
    expect(resolveTaskType({ labels: ["kind: architecture"] }).type).toBe("architecture");
    expect(resolveTaskType({ labels: ["frontend", "bug"] }).type).toBe("bug");
    expect(resolveTaskType({ labels: ["spike"] }).type).toBe("research");
    expect(resolveTaskType({ labels: ["type:feature"] }).type).toBe("task");
  });
  it("ignores ordinary labels that merely look like a type name", () => {
    expect(resolveTaskType({ labels: ["design", "issue", "task", "backend"] })).toEqual({ source: "default" });
    expect(resolveTaskType({ labels: ["type:design"] }).type).toBe("architecture");
  });
  it("applies one precedence: API field, labels, Type line, agent profile, default", () => {
    expect(resolveTaskType({ apiType: "research", labels: ["bug"], directive: "architecture", profile: "bugfix" }).source).toBe("api");
    expect(resolveTaskType({ labels: ["bug"], directive: "architecture", profile: "research" })).toEqual({ type: "bug", source: "label" });
    expect(resolveTaskType({ directive: "architecture", profile: "research" })).toEqual({ type: "architecture", source: "directive" });
    expect(resolveTaskType({ profile: "bugfix" })).toEqual({ type: "bug", source: "profile" });
    expect(resolveTaskType({ profile: "implementation" })).toEqual({ source: "default" });
  });
  it("reports unknown and conflicting types instead of guessing", () => {
    expect(resolveTaskType({ apiType: "epic" }).error).toContain("unknown task type 'epic'");
    expect(resolveTaskType({ directive: "epic" }).error).toContain("unknown task type");
    expect(resolveTaskType({ labels: ["type:bug", "type:research"] }).error).toContain("conflicting type labels");
    expect(resolveTaskType({ labels: ["bug", "type:defect"] }).type).toBe("bug");
  });
  it("keeps the untyped legacy profiles untyped", () => {
    expect(taskTypeFromProfile("implementation")).toBeUndefined();
    expect(taskTypeFromProfile("refactor")).toBeUndefined();
    expect(normalizeTaskType(" BUG ")).toBe("bug");
  });
  it("maps every type onto an existing profile, and investigations deliver documents without implementation stages", () => {
    for (const type of Object.values(taskTypes)) expect(profiles[type.profile], type.id).toBeDefined();
    expect(profiles.investigation!.stages).toEqual([]);
    expect(profiles.bug!.stages).toEqual(profiles.implementation!.stages);
    expect(taskTypes.research.delivers).toBe("document");
    expect(taskTypes.bug.delivers).toBe("code");
  });
});

describe("Type directive in the task text", () => {
  it("is parsed on its own line, removed from the prompt, and rejects conflicts", () => {
    expect(parseTaskDirectives("Login fails\nType: bug\nSteps follow")).toEqual({ prompt: "Login fails\nSteps follow", taskType: "bug" });
    expect(parseTaskDirectives("Explore caching\nTask Type: Research\nOpenSpec: off")).toEqual({ prompt: "Explore caching", taskType: "research", openSpec: false });
    expect(parseTaskDirectives("x\nType: bug\nType: research").error).toContain("conflicting Type");
    expect(parseTaskDirectives("The Type: of cache we use is unclear")).toEqual({ prompt: "The Type: of cache we use is unclear" });
    expect(parseTaskDirectives("Type: epic")).toEqual({ prompt: "Type: epic" });
  });
});

describe("Paperclip adapter labels", () => {
  it("sends label names only, from objects or strings", () => {
    expect(issueLabelNames({ labels: [{ id: "1", name: "type:bug", color: "#f00" }, "frontend", { name: " " }, null] })).toEqual(["type:bug", "frontend"]);
    expect(issueLabelNames({})).toEqual([]);
    expect(issueLabelNames(null)).toEqual([]);
  });
});
