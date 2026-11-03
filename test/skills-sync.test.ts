// Pinned skill import (B-118, ADR 0033): text only, read only, a recorded hash, and a stale check that never updates anything.
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectSkillText, findInstalledSkills, hashSkill, importCandidate, staleSkills, writeCandidate, type CatalogFile } from "../src/skills-sync.js";

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
/** A fake Claude plugins folder with one plugin 'demo@market' holding skills/react-tips. */
async function plugins(files: Record<string, string>, version = "1.0.0"): Promise<{ dir: string; install: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-skills-"));
  dirs.push(dir);
  const install = path.join(dir, "cache", "demo", version);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(install, "skills/react-tips", name)), { recursive: true }); await writeFile(path.join(install, "skills/react-tips", name), content); }
  await writeFile(path.join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "demo@market": [{ installPath: install, version }] } }));
  return { dir, install };
}
const empty: CatalogFile = { version: 1, skills: [] };

describe("collectSkillText", () => {
  it("takes text documents in a stable order and skips scripts, binaries, symbolic links and oversize files", async () => {
    const { install } = await plugins({ "SKILL.md": "# Tips\r\nUse keys.\r\n", "notes/extra.txt": "more", "run.sh": "rm -rf /", "tool.js": "evil()", "logo.png": "x", "big.md": "x".repeat(200_001) });
    await symlink(path.join(install, "skills/react-tips/SKILL.md"), path.join(install, "skills/react-tips/link.md")).catch(() => undefined);
    const { files, skipped } = await collectSkillText(path.join(install, "skills/react-tips"));
    expect(files.map(file => file.rel)).toEqual(["SKILL.md", "notes/extra.txt"]);
    expect(files[0]!.text).toBe("# Tips\nUse keys.\n");
    expect(skipped.some(item => item.startsWith("run.sh"))).toBe(true);
    expect(skipped.some(item => item.startsWith("tool.js"))).toBe(true);
    expect(skipped.some(item => item.startsWith("big.md (over"))).toBe(true);
  });
  it("hashes content and path, and ignores line endings", () => {
    expect(hashSkill([{ rel: "a.md", text: "x" }])).toBe(hashSkill([{ rel: "a.md", text: "x" }]));
    expect(hashSkill([{ rel: "a.md", text: "x" }])).not.toBe(hashSkill([{ rel: "b.md", text: "x" }]));
    expect(hashSkill([{ rel: "a.md", text: "x" }])).not.toBe(hashSkill([{ rel: "a.md", text: "y" }]));
  });
});

describe("importCandidate", () => {
  it("records the plugin, version, path and hash as a candidate and keeps the text for review", async () => {
    const { dir } = await plugins({ "SKILL.md": "# Tips\nUse keys.\n" }, "2.3.1");
    const [skill] = await findInstalledSkills("react-tips", dir);
    expect(skill).toMatchObject({ plugin: "demo@market", version: "2.3.1", relativePath: "skills/react-tips" });
    const imported = await importCandidate(empty, skill!, { id: "react-tips", area: "react-ts" });
    expect(imported.entry).toMatchObject({ id: "react-tips", status: "candidate", areas: ["react-ts"], digest: "skills/react-tips.md", source: { plugin: "demo@market", version: "2.3.1", path: "skills/react-tips" } });
    expect(imported.entry.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-skills-")); dirs.push(root);
    const written = await writeCandidate(root, "react-tips", imported.files);
    expect(await readFile(path.join(written, "SKILL.md"), "utf8")).toBe("# Tips\nUse keys.\n");
  });
  it("refuses an existing id, a bad id and a folder without text", async () => {
    const { dir } = await plugins({ "SKILL.md": "x" });
    const [skill] = await findInstalledSkills("react-tips", dir);
    const imported = await importCandidate(empty, skill!, { id: "react-tips", area: "react-ts" });
    await expect(importCandidate(imported.catalog, skill!, { id: "react-tips", area: "react-ts" })).rejects.toThrow("already has");
    await expect(importCandidate(empty, skill!, { id: "Bad Id", area: "react-ts" })).rejects.toThrow("invalid skill id");
    const { dir: other } = await plugins({ "run.sh": "x" });
    const [scripts] = await findInstalledSkills("react-tips", other);
    await expect(importCandidate(empty, scripts!, { id: "scripts-only", area: "react-ts" })).rejects.toThrow("no text documents");
  });
  it("finds nothing for an unknown skill or a missing plugins folder", async () => {
    const { dir } = await plugins({ "SKILL.md": "x" });
    expect(await findInstalledSkills("nope", dir)).toEqual([]);
    expect(await findInstalledSkills("react-tips", path.join(dir, "missing"))).toEqual([]);
  });
});

describe("staleSkills", () => {
  it("is quiet while the source is unchanged, names the entry when it changed, and ignores entries it cannot compare", async () => {
    const { dir, install } = await plugins({ "SKILL.md": "v1" });
    const [skill] = await findInstalledSkills("react-tips", dir);
    const { catalog } = await importCandidate(empty, skill!, { id: "react-tips", area: "react-ts" });
    expect(await staleSkills(catalog, dir)).toEqual([]);
    await writeFile(path.join(install, "skills/react-tips/SKILL.md"), "v2");
    const stale = await staleSkills(catalog, dir);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("react-tips (candidate): the source in demo@market changed");
    const manual = { version: 1, skills: [{ ...catalog.skills[0]!, id: "hand-written", source: { origin: "docs/x.md" } }, { ...catalog.skills[0]!, id: "retired-one", status: "retired" as const }] };
    expect(await staleSkills(manual, dir)).toEqual([]);
    expect(await staleSkills(catalog, path.join(dir, "missing"))).toEqual([]);
  });
});
