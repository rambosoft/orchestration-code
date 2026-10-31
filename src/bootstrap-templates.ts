import type { QualityCommand, VisualConfig } from "./contracts.js";

// Scaffold templates (ADR 0009). A template is plain data: package names without versions (the scaffold installs the current releases and commits the lockfile,
// so nothing here goes stale), a few config files, and the deterministic checks the project is gated on. A stack without a template still gets the contract,
// docs and plan; its first task initialises the project. Add a template by adding an entry; nothing else changes.
export type TemplateContext = { name: string; slug: string; description: string };
export type ScaffoldTemplate = {
  id: string; label: string; description: string;
  platforms: string[]; architectures: string[];
  ecosystem: "node" | "unity";
  scripts: Record<string, string>; dependencies: string[]; devDependencies: string[];
  files: (context: TemplateContext) => Record<string, string>;
  /** Checks every code task is gated on. `test` is dropped when the project chose no automated tests. */
  checks: { build: QualityCommand; test: QualityCommand };
  visual?: VisualConfig;
  /** unity: folder under templates/ whose files are copied (with {{NAME}}, {{SLUG}}, {{NAMESPACE}} replaced) after the project is created by the Editor. */
  templateDir?: string;
  /** unity: the manifest's stack block and the gates by maturity. The node checks above are not used for these. */
  unity?: { executeMethods: string[]; gates: (maturity: string, testDepth: string) => QualityCommand[]; captureFilter: string };
};

const viteReactTs: ScaffoldTemplate = {
  id: "vite-react-ts",
  label: "Vite + React + TypeScript",
  description: "Single-page web app: React with TypeScript, Vite dev server and build, Vitest with Testing Library.",
  platforms: ["web"], architectures: ["frontend_only"],
  ecosystem: "node",
  scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview", test: "vitest run", typecheck: "tsc --noEmit" },
  dependencies: ["react", "react-dom"],
  devDependencies: ["vite", "@vitejs/plugin-react", "typescript", "vitest", "jsdom", "@testing-library/react", "@testing-library/jest-dom", "@testing-library/user-event", "@types/react", "@types/react-dom"],
  files: ({ name, description }) => ({
    "index.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${name.replace(/[<>&"]/g, "")}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
    "vite.config.ts": `import { defineConfig } from "vitest/config";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n  test: { environment: "jsdom", setupFiles: "./src/setupTests.ts", globals: true },\n});\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, skipLibCheck: true, isolatedModules: true, noEmit: true, types: ["vite/client", "vitest/globals", "@testing-library/jest-dom"] }, include: ["src", "vite.config.ts"] }, null, 2)}\n`,
    "src/config.ts": `export const APP_NAME = ${JSON.stringify(name)};\nexport const APP_DESCRIPTION = ${JSON.stringify(description.slice(0, 280))};\n`,
    "src/main.tsx": `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\n\ncreateRoot(document.getElementById("root")!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
    "src/App.tsx": `import { APP_DESCRIPTION, APP_NAME } from "./config";\n\nexport default function App() {\n  return (\n    <main>\n      <h1>{APP_NAME}</h1>\n      <p>{APP_DESCRIPTION}</p>\n    </main>\n  );\n}\n`,
    "src/App.test.tsx": `import { render, screen } from "@testing-library/react";\nimport App from "./App";\nimport { APP_NAME } from "./config";\n\ndescribe("App", () => {\n  it("renders the application name", () => {\n    render(<App />);\n    expect(screen.getByRole("heading", { name: APP_NAME })).toBeInTheDocument();\n  });\n});\n`,
    "src/setupTests.ts": `import "@testing-library/jest-dom/vitest";\n`,
    "src/vite-env.d.ts": `/// <reference types="vite/client" />\n`,
    "src/index.css": `:root {\n  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;\n  color-scheme: light dark;\n}\n\nbody {\n  margin: 0;\n}\n`,
    ".gitignore": `node_modules/\ndist/\n*.log\n.env\n.env.*\n!.env.example\ncoverage/\n`,
  }),
  checks: { build: { executable: "npm", args: ["run", "build"] }, test: { executable: "npm", args: ["test"] } },
  visual: { enabled: true, engine: "web", command: { executable: "npm", args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5199", "--strictPort"] }, url: "http://127.0.0.1:5199/", readyTimeoutMs: 60_000, viewports: [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }], steps: [{ do: "shot", name: "initial" }], maxImages: 4, required: false },
};

export const unityGates = (maturity: string, testDepth: string): QualityCommand[] => {
  const unity = (args: string[], severity?: "warn"): QualityCommand => ({ executable: "unity", args, ...(severity ? { severity } : {}) });
  // Unity's test import pass creates missing .meta files for newly authored
  // assets. Run engine checks first so hygiene reports project defects rather
  // than files that Unity has not imported yet. If Unity itself is unavailable,
  // fail with that concrete cause instead of a misleading hygiene failure.
  const gates: QualityCommand[] = [unity(["test", "--mode", "EditMode", "--output", "Logs/editmode-results.xml"])];
  // A prototype runs the slow PlayMode suite once per milestone check, not after every task (ADR 0029); other tiers gate every task on it.
  if (testDepth !== "none" && testDepth !== "smoke") gates.push({ ...unity(["test", "--mode", "PlayMode", "--retries", "1", "--output", "Logs/playmode-results.xml"]), ...(maturity === "prototype" ? { scope: "milestone" as const } : {}) });
  if (maturity === "production") gates.push(unity(["build", "--target", "Android", "--execute-method", "Builder.Android", "-o", "Builds/game.aab"]));
  else if (maturity === "mvp") gates.push(unity(["build", "--target", "Android", "--execute-method", "Builder.Android", "-o", "Builds/game.aab"], "warn"));
  gates.push({ executable: "node", args: ["scripts/check-unity-hygiene.mjs"] });
  return gates;
};
const unityMobile2d: ScaffoldTemplate = {
  id: "unity-mobile-2d",
  label: "Unity 6 2D mobile game",
  description: "Unity 6 project for a 2D mobile game: an engine-free logic assembly with EditMode tests, a view layer, PlayMode tests with a screenshot capture harness, an Android build method and a hygiene check; built and tested headless with the Unity CLI.",
  platforms: ["mobile_android", "mobile_ios", "mobile_cross", "desktop"], architectures: ["frontend_only"],
  ecosystem: "unity", templateDir: "unity-mobile-2d",
  scripts: {}, dependencies: [], devDependencies: [],
  files: () => ({}),
  checks: { build: { executable: "unity", args: ["build", "--target", "Android", "--execute-method", "Builder.Android", "-o", "Builds/game.aab"] }, test: { executable: "unity", args: ["test", "--mode", "EditMode", "--output", "Logs/editmode-results.xml"] } },
  visual: { enabled: true, engine: "unity", unityFilter: "CaptureTests", readyTimeoutMs: 600_000, viewports: [{ name: "desktop", width: 1280, height: 720 }], steps: [{ do: "shot", name: "initial" }], maxImages: 8, required: false },
  unity: { executeMethods: ["Builder.Android"], gates: unityGates, captureFilter: "CaptureTests" },
};

export const TEMPLATES: Record<string, ScaffoldTemplate> = { [viteReactTs.id]: viteReactTs, [unityMobile2d.id]: unityMobile2d };

export function templateSummaries(): Array<{ id: string; label: string; description: string; platforms: string[]; architectures: string[] }> {
  // Game templates are chosen by the engine option, never offered to the stack stage of an application.
  return Object.values(TEMPLATES).filter(template => template.ecosystem === "node").map(({ id, label, description, platforms, architectures }) => ({ id, label, description, platforms, architectures }));
}

/** Only a template that fits the platform and shape is usable; a model may name one that does not. A game template needs `game`. */
export function usableTemplate(id: string | undefined, platform: string, architecture: string, game = false): ScaffoldTemplate | undefined {
  const template = id ? TEMPLATES[id] : undefined;
  return template && (template.ecosystem === "node" || game) && template.platforms.includes(platform) && (architecture === "auto" || template.architectures.includes(architecture)) ? template : undefined;
}
