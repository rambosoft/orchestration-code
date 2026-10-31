import { defineConfig } from "vitest/config";

export default defineConfig({ test: { setupFiles: ["test/setup-isolated-data.ts"], include: ["test/**/*.test.ts"], exclude: ["node_modules/**", ".runtime/**", "dist/**"], maxWorkers: 1 } });
