import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// The presets keep react and the SDK UI entry external (the host provides them) and bundle everything else, so dist/ runs without node_modules.
const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx", sourcemap: false });
await build(presets.esbuild.worker);
await build(presets.esbuild.manifest);
await build({ ...presets.esbuild.ui, jsx: "automatic" });
console.log("built dist/manifest.js, dist/worker.js and dist/ui/");
