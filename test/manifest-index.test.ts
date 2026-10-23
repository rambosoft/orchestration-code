import { describe, expect, it } from "vitest";
import { ProjectManifestSchema } from "../src/contracts.js";
import { indexManifests } from "../src/manifest-index.js";

const manifest = (id: string, aliases: string[] = []) => ProjectManifestSchema.parse({ id, aliases, name: id, root: id, defaultProfile: "implementation" });

describe("indexManifests", () => {
  it("resolves a project by its id and by each alias", () => {
    const index = indexManifests([manifest("b0477a04-323c-4d1d-982d-595f8b8cb479", ["dino-runner"]), manifest("other-project")]);
    expect(index.get("dino-runner")?.id).toBe("b0477a04-323c-4d1d-982d-595f8b8cb479");
    expect(index.get("b0477a04-323c-4d1d-982d-595f8b8cb479")).toBe(index.get("dino-runner"));
    expect(index.get("other-project")?.id).toBe("other-project");
  });
  it("rejects a duplicate id or an alias that collides with another project", () => {
    expect(() => indexManifests([manifest("aa"), manifest("aa")])).toThrow("duplicate project manifest ID or alias 'aa'");
    expect(() => indexManifests([manifest("aa"), manifest("bb", ["aa"])])).toThrow("duplicate");
    expect(() => indexManifests([manifest("aa", ["same"]), manifest("bb", ["same"])])).toThrow("'same'");
  });
  it("keeps older manifests without aliases valid", () => {
    expect(manifest("plain").aliases).toEqual([]);
  });
});
