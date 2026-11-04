// A review prompt carries the diff and can be far larger than a command line allows (Windows: spawn ENAMETOOLONG): the Claude CLI must receive the prompt on stdin, never as an argument.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliProvider } from "../src/providers.js";
import type { StageInput } from "../src/contracts.js";

const savedPath = process.env.PATH;
afterEach(() => { process.env.PATH = savedPath; });

// A stub `claude` is a shell script found through PATH; Windows resolves only claude.exe, so the stub run is POSIX-only (CI is Linux).
describe("Claude prompt transport", () => {
  it.skipIf(process.platform === "win32")("passes a prompt larger than the argument limit on stdin", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-stub-"));
    writeFileSync(path.join(dir, "claude"), `#!/bin/sh\ncat > "${dir}/stdin.txt"\nprintf '{"result":"%s args=%s"}' ok "$#"\n`);
    chmodSync(path.join(dir, "claude"), 0o755);
    process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
    const prompt = "diff line\n".repeat(30_000);
    const out = await new CliProvider("claude", 20_000).run({ stage: "review", prompt, projectRoot: dir, plugins: [] } as unknown as StageInput);
    expect(out.summary).toContain("ok args=");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(dir, "stdin.txt"), "utf8")).toContain(prompt);
  });
});
