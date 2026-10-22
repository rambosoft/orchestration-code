import { existsSync, realpathSync } from "node:fs";
import { expect, it } from "vitest";
import { NODE_EXECUTABLE } from "../src/node-path.js";

it("uses the resolved real path of the running node binary", () => {
  expect(existsSync(NODE_EXECUTABLE)).toBe(true);
  expect(NODE_EXECUTABLE).toBe(realpathSync(process.execPath));
});
