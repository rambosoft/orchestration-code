// Enforce the React pack's module boundaries (rule R-021). CommonJS because the target project is ESM.
module.exports = {
  forbidden: [
    { name: "no-circular", comment: "Modules must not form dependency cycles.", severity: "error", from: {}, to: { circular: true } },
    { name: "components-not-import-pages", comment: "Shared components must not depend on route pages.", severity: "error", from: { path: "^src/components" }, to: { path: "^src/pages" } },
    { name: "hooks-not-import-pages", comment: "Hooks must not depend on route pages.", severity: "error", from: { path: "^src/hooks" }, to: { path: "^src/pages" } },
    { name: "services-not-import-ui", comment: "Services must not depend on UI or hooks.", severity: "error", from: { path: "^src/services" }, to: { path: "^src/(components|pages|hooks)" } },
    { name: "storage-through-index", comment: "Code outside storage must import it through its index.", severity: "error", from: { pathNot: "^src/storage" }, to: { path: "^src/storage/", pathNot: "^src/storage/index\\.[^/]+$" } },
    { name: "input-through-index", comment: "Code outside input must import it through its index.", severity: "error", from: { pathNot: "^src/input" }, to: { path: "^src/input/", pathNot: "^src/input/index\\.[^/]+$" } },
    { name: "no-prod-imports-test-files", comment: "Production source must not import tests or test setup.", severity: "error", from: { pathNot: "\\.(test|spec)\\.[^/]+$" }, to: { path: "(^|/)([^/]+\\.(test|spec)\\.[^/]+$|src/setupTests\\.ts$)" } },
    { name: "not-to-unresolvable", comment: "Imports must resolve to a source file or dependency.", severity: "error", from: {}, to: { couldNotResolve: true } },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.app.json" },
    // No includeOnly: it would drop unresolved imports before not-to-unresolvable can see them. The run is limited to src and node_modules is not followed.
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
