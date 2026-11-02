import type { ProviderRoute, ProjectManifest } from "./contracts.js";

export type ProviderRouting = Partial<Record<import("./contracts.js").StageName, ProviderRoute>>;
export type AreaRouting = NonNullable<ProjectManifest["areaRouting"]>;

export function effectiveRouting(base: ProviderRouting, areaRouting: AreaRouting | undefined, task: { area?: string; critical?: boolean }): ProviderRouting {
  const critical = task.critical ? areaRouting?.critical : undefined;
  const area = task.area ? areaRouting?.[task.area] : undefined;
  return { ...base, ...critical, ...area };
}

const RULES: Array<{ pattern: RegExp; area: string; critical: boolean }> = [
  { pattern: /content-cache|cache-manager|storage|localstorage|indexeddb/i, area: "cache-storage", critical: true },
  { pattern: /player|native|webos|tizen|adapter/i, area: "player-native", critical: true },
  { pattern: /carousel/i, area: "carousel", critical: true },
  { pattern: /search|sort/i, area: "search-sort", critical: true },
  { pattern: /xtream|api\/iptv|iptv/i, area: "xtream-fetch", critical: true },
  { pattern: /keydown|key-handler|input|focus|remote/i, area: "input", critical: true },
  { pattern: /layouts|middleware|auth|session|splash|register/i, area: "shell-auth", critical: false },
  { pattern: /settings|profiles/i, area: "settings-profiles", critical: false },
  { pattern: /live|guide|epg/i, area: "live-guide", critical: false },
  { pattern: /movies|series|catalog/i, area: "catalog", critical: false },
  { pattern: /components\/ui|components\/common|shared/i, area: "shared-ui", critical: false },
  { pattern: /nuxt\.config|package\.json|build|polyfill/i, area: "build-release", critical: false },
];

export function inferArea(oldPaths: readonly string[]): { area: string; critical: boolean } {
  const counts = new Map<string, { area: string; critical: boolean; count: number; order: number }>();
  for (const path of oldPaths) {
    const index = RULES.findIndex(rule => rule.pattern.test(path));
    const rule = index < 0 ? { area: "general", critical: false } : RULES[index]!;
    const prior = counts.get(rule.area);
    counts.set(rule.area, { area: rule.area, critical: rule.critical, count: (prior?.count ?? 0) + 1, order: prior?.order ?? (index < 0 ? RULES.length : index) });
  }
  const winner = [...counts.values()].sort((a, b) => b.count - a.count || a.order - b.order)[0];
  return winner ? { area: winner.area, critical: winner.critical } : { area: "general", critical: false };
}
