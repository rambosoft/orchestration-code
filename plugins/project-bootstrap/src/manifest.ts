import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "orchestrator.project-bootstrap";
export const PAGE_ROUTE = "new-project";
export const TAB_SLOT_ID = "bootstrap-tab";

// The plugin only needs the web UI slots, outbound HTTP to the orchestrator bridge and a secret reference for the bridge token. It creates nothing in Paperclip
// itself: the page uses the board's own session to create the project and its first task, and the orchestrator does the rest (ADR 0009).
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Project Bootstrap",
  description: "Describe a project once; get a planned, constrained, AI-ready project with a repository, milestones and tasks, created through the orchestrator.",
  author: "Orchestrator",
  categories: ["automation", "ui"],
  capabilities: ["http.outbound", "secrets.read-ref", "instance.settings.register", "ui.page.register", "ui.sidebar.register", "ui.detailTab.register", "ui.action.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      bridgeUrl: { type: "string", title: "Orchestrator bridge URL", default: "http://orchestrator:3101", description: "Where the Temporal orchestrator bridge listens, as seen from the Paperclip server." },
      // The host stores a secret binding object ({ type: "secret_ref", secretId }) for this field and validates it against this schema, so a plain "string" rejects every real value.
      bridgeToken: { type: ["string", "object"], format: "secret-ref", title: "Orchestrator bridge token", description: "A secret holding ORCHESTRATOR_API_TOKEN." },
    },
    required: ["bridgeToken"],
  },
  ui: {
    slots: [
      { type: "page", id: "wizard", displayName: "New AI project", exportName: "BootstrapPage", routePath: PAGE_ROUTE },
      { type: "sidebar", id: "nav", displayName: "New AI project", exportName: "BootstrapNavLink" },
      { type: "globalToolbarButton", id: "toolbar", displayName: "New AI project", exportName: "BootstrapToolbarButton" },
      { type: "detailTab", id: TAB_SLOT_ID, displayName: "Bootstrap", exportName: "BootstrapTab", entityTypes: ["project"] },
    ],
  },
};

export default manifest;
