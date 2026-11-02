import { describe, expect, it } from "vitest";
import { effectiveRouting, inferArea } from "../src/area-routing.js";
import { ProjectManifestSchema } from "../src/contracts.js";
import { parseTaskDirectives } from "../src/openspec-policy.js";

describe("area routing", () => {
  it("preserves routing when area routing is absent", () => {
    const base = { implement: { provider: "codex" as const, fallback: [{ provider: "claude" as const }] } };
    expect(effectiveRouting(base, undefined, { area: "cache-storage", critical: true })).toEqual(base);
  });

  it("replaces only critical stages and lets the area override critical", () => {
    const base = { implement: { provider: "codex" as const, fallback: [{ provider: "claude" as const }] }, review: { provider: "fake" as const } };
    const routes = { critical: { implement: { provider: "gemini" as const } }, "cache-storage": { review: { provider: "openrouter" as const, model: "review/model" } } };
    expect(effectiveRouting(base, routes, { critical: true })).toEqual({ implement: { provider: "gemini" }, review: base.review });
    expect(effectiveRouting(base, routes, { critical: true, area: "cache-storage" })).toEqual({ implement: { provider: "gemini" }, review: { provider: "openrouter", model: "review/model" } });
    expect(effectiveRouting(base, { critical: { implement: { provider: "fake" } } }, { critical: true }).implement).toEqual({ provider: "fake" });
    expect(base.implement.fallback).toEqual([{ provider: "claude" }]);
    expect(routes.critical.implement).toEqual({ provider: "gemini" });
  });

  it.each([
    ["content-cache storage localstorage indexeddb cache-manager", "cache-storage", true],
    ["player native webos tizen adapter", "player-native", true],
    ["carousel", "carousel", true], ["search sort", "search-sort", true], ["xtream api/iptv iptv", "xtream-fetch", true],
    ["keydown key-handler input focus remote", "input", true], ["layouts middleware auth session splash register", "shell-auth", false],
    ["settings profiles", "settings-profiles", false], ["live guide epg", "live-guide", false], ["movies series catalog", "catalog", false],
    ["components/ui components/common shared", "shared-ui", false], ["nuxt.config package.json build polyfill", "build-release", false],
  ])("infers %s", (path, area, critical) => expect(inferArea([path as string])).toEqual({ area, critical }));

  it("uses majority vote, stable rule order for ties, and general as default", () => {
    expect(inferArea(["src/carousel.ts", "src/search.ts", "src/search-sort.ts"])).toEqual({ area: "search-sort", critical: true });
    expect(inferArea(["src/carousel.ts", "src/search.ts"])).toEqual({ area: "carousel", critical: true });
    expect(inferArea([])).toEqual({ area: "general", critical: false });
  });
});

describe("area directives and manifest schema", () => {
  it("parses and removes Area and Critical lines", () => {
    expect(parseTaskDirectives("Area: cache-storage\nCritical: YES\nGoal: work")).toMatchObject({ prompt: "Goal: work", area: "cache-storage", critical: true });
  });

  it("rejects invalid slugs and conflicting duplicate values", () => {
    expect(parseTaskDirectives("Area: Upper").error).toMatch(/invalid Area/);
    expect(parseTaskDirectives("Area: one\nArea: two").error).toMatch(/conflicting Area/);
    expect(parseTaskDirectives("Critical: yes\nCritical: no").error).toMatch(/conflicting Critical/);
  });

  it("accepts critical routing and rejects unknown stages", () => {
    const manifest = { id: "project", name: "Project", root: ".", defaultProfile: "node-web", areaRouting: { critical: { implement: { provider: "codex" } } } };
    expect(ProjectManifestSchema.safeParse(manifest).success).toBe(true);
    expect(ProjectManifestSchema.safeParse({ ...manifest, areaRouting: { critical: { unknown: { provider: "codex" } } } }).success).toBe(false);
  });
});
