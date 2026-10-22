import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { childEnv } from "../src/env.js";
import { cliProviderEnvironment } from "../src/providers.js";

const secrets = { ORCHESTRATOR_API_TOKEN: "a", PAPERCLIP_API_TOKEN: "b", OPENROUTER_API_KEY: "c", GH_TOKEN: "d", GITHUB_TOKEN: "e", DB_PASSWORD: "f", OPENAI_API_KEY: "g", PAPERCLIP_COMPANY_ID: "h" };

describe("childEnv", () => {
  it("removes service tokens and credential-like variables but keeps ordinary ones", () => {
    const env = childEnv({ ...secrets, PATH: "/bin", SystemRoot: "C:/Windows", TEMP: "/tmp" });
    expect(env).toEqual({ PATH: "/bin", SystemRoot: "C:/Windows", TEMP: "/tmp" });
  });
  it("lets a caller keep explicitly named variables", () => {
    const env = childEnv({ ...secrets, PATH: "/bin" }, ["OPENAI_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("g");
    expect(env.ORCHESTRATOR_API_TOKEN).toBeUndefined();
  });
  it("is what a spawned process actually receives", () => {
    const out = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.PAPERCLIP_API_TOKEN))"], { env: childEnv({ ...process.env, PAPERCLIP_API_TOKEN: "leak" }) });
    expect(out.stdout.toString()).toBe("undefined");
  });
  it("also removes cloud and private-key style variables, but keeps Claude CLI auth for the claude provider", () => {
    const env = cliProviderEnvironment({ AWS_ACCESS_KEY_ID: "x", DATABASE_URL: "x", SSH_PASSPHRASE: "x", CLAUDE_CODE_OAUTH_TOKEN: "ok", PATH: "/bin" });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "ok", PATH: "/bin" });
  });
  it("cli providers keep only their own credentials", () => {
    const env = cliProviderEnvironment({ ...secrets, PATH: "/bin" });
    expect(env.OPENAI_API_KEY).toBe("g");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.PAPERCLIP_API_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });
});
