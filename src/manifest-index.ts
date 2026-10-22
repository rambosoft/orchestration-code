import type { ProjectManifest } from "./contracts.js";

/** Index manifests by id and alias. Paperclip project ids are UUIDs; an alias such as "dino-runner" keeps scripts and docs readable. Any collision is an error. */
export function indexManifests(manifests: ProjectManifest[]): Map<string, ProjectManifest> {
  const index = new Map<string, ProjectManifest>();
  for (const manifest of manifests) {
    for (const key of [manifest.id, ...manifest.aliases]) {
      if (index.has(key)) throw new Error(`duplicate project manifest ID or alias '${key}'`);
      index.set(key, manifest);
    }
  }
  return index;
}
