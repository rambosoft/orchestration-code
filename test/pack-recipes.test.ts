// Recipes and the pattern record of the react-ts-vite pack (B-137): they only help if everything they point at exists.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const pack = "templates/react-ts-vite";
const RECIPES = ["page", "component", "service"].map(name => `docs/ai/recipes/${name}.md`);

describe("pack recipes", () => {
  it("are copied into a project together with the pattern record", async () => {
    const manifest = JSON.parse(await readFile(`${pack}/pack.json`, "utf8")) as { copy: string[] };
    for (const file of [...RECIPES, "docs/ai/PATTERNS.md"]) expect(manifest.copy, file).toContain(file);
  });
  it.each(RECIPES)("%s names only npm scripts, rules and files that exist", async file => {
    const text = await readFile(`${pack}/${file}`, "utf8");
    const manifest = JSON.parse(await readFile(`${pack}/pack.json`, "utf8")) as { scripts: Record<string, string>; copy: string[] };
    const agents = await readFile(`${pack}/AGENTS.md`, "utf8");
    for (const match of text.matchAll(/npm run ([a-z:]+)/g)) expect(manifest.scripts, `${file}: npm run ${match[1]}`).toHaveProperty(match[1]!);
    for (const match of text.matchAll(/\bR-\d{3}\b/g)) expect(agents, `${file}: ${match[0]}`).toContain(`- ${match[0]} `);
    for (const match of text.matchAll(/`((?:docs|src)\/[A-Za-z0-9_./<>-]+\.md|docs\/ai\/[A-Za-z0-9_./-]+)`/g)) {
      const reference = match[1]!;
      if (reference.includes("<")) continue;
      expect(manifest.copy.includes(reference) || reference.endsWith("/"), `${file} points at ${reference}, which the pack does not ship`).toBe(true);
    }
  });
  it("are pointed to from the agent rules and the map", async () => {
    expect(await readFile(`${pack}/AGENTS.md`, "utf8")).toContain("docs/ai/recipes/page.md");
    expect(await readFile(`${pack}/docs/ai/INDEX.md`, "utf8")).toContain("docs/ai/PATTERNS.md");
  });
  it("keep AGENTS.md under its 150 line limit (R-013)", async () => {
    expect((await readFile(`${pack}/AGENTS.md`, "utf8")).split("\n").length).toBeLessThan(150);
  });
  it("start the pattern record with its table header and no rows", async () => {
    const text = await readFile(`${pack}/docs/ai/PATTERNS.md`, "utf8");
    expect(text).toContain("| Pattern | Where | Use it when | Task | Status |");
    expect(text.split("\n").filter(line => line.startsWith("|"))).toHaveLength(2);
  });
});
