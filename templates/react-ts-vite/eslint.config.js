// Enforces AGENTS.md rules R-001 to R-007 (see docs/ai/enforcement.json). Written for ESLint flat config.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import jsdoc from "eslint-plugin-jsdoc";
import globals from "globals";

const KEY_LISTENER = [
  { selector: "CallExpression[callee.property.name='addEventListener'][arguments.0.value=/^key(down|up|press)$/]", message: "R-005: key listeners belong in src/input only." },
  { selector: "JSXAttribute[name.name=/^onKey(Down|Up|Press)$/]", message: "R-005: key handlers belong in src/input only; register a focus region instead." },
];
const STORAGE_GLOBALS = [
  { name: "localStorage", message: "R-006: use the storage interface in src/storage." },
  { name: "sessionStorage", message: "R-006: use the storage interface in src/storage." },
];

export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules", "scripts", ".dependency-cruiser.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-restricted-syntax": ["error", ...KEY_LISTENER],
      "no-restricted-globals": ["error", ...STORAGE_GLOBALS],
    },
  },
  { files: ["src/input/**", "**/*.test.{ts,tsx}", "src/setupTests.ts"], rules: { "no-restricted-syntax": "off" } },
  { files: ["src/storage/**", "**/*.test.{ts,tsx}", "src/setupTests.ts"], rules: { "no-restricted-globals": "off" } },
  {
    files: ["src/services/**/*.ts"],
    ignores: ["**/*.test.ts"],
    plugins: { jsdoc },
    rules: { "jsdoc/require-jsdoc": ["error", { publicOnly: true, require: { FunctionDeclaration: true, ArrowFunctionExpression: true } }] },
  },
);
