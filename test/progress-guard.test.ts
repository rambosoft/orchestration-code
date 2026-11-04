// The no-progress guard: a pure verdict over the clock, and its wiring into the Codex implement run (fake child, fake timers, injected git sampler).
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MIN = 60_000;
const kills: unknown[] = [];
const fakeChildren: FakeChild[] = [];
class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); pid = 4242; exitCode: number | null = null;
  stdin = { end: (_text: string) => undefined };
  emitEvent(event: object) { this.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`)); }
}
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), spawn: vi.fn(() => { const child = new FakeChild(); fakeChildren.push(child); return child; }) }));
vi.mock("../src/process-control.js", async (original) => ({ ...(await original<typeof import("../src/process-control.js")>()), killProcessTree: (child: FakeChild) => { kills.push(child); child.exitCode = 1; child.emit("close", 1); } }));
vi.mock("../src/rtk.js", () => ({ isRtkInstalled: async () => false, resolveRtkStatus: async () => ({ active: false, reason: "test" }) }));

const { progressVerdict } = await import("../src/progress-guard.js");
const { CliProvider, worktreeSignature } = await import("../src/providers.js");
const { execFileSync } = await import("node:child_process");
const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
const os = await import("node:os"); const path = await import("node:path");
type StageInput = import("../src/contracts.js").StageInput;

describe("progressVerdict", () => {
  const limits = { firstEditMs: 15 * MIN, idleMs: 10 * MIN };
  it("is ok before either limit", () => {
    expect(progressVerdict({ startedAt: 0, now: 14 * MIN, lastProgressAt: 0 }, limits)).toBe("ok");
    expect(progressVerdict({ startedAt: 0, now: 12 * MIN, firstChangeAt: 3 * MIN, lastProgressAt: 3 * MIN }, limits)).toBe("ok");
  });
  it("is no_first_edit when nothing changed by the first-edit limit, however busy the commands were", () => {
    expect(progressVerdict({ startedAt: 0, now: 15 * MIN, lastProgressAt: 14 * MIN }, limits)).toBe("no_first_edit");
  });
  it("is idle once the quiet time after the first edit reaches the idle limit", () => {
    expect(progressVerdict({ startedAt: 0, now: 13 * MIN, firstChangeAt: 3 * MIN, lastProgressAt: 3 * MIN }, limits)).toBe("idle");
    expect(progressVerdict({ startedAt: 0, now: 14 * MIN, firstChangeAt: 3 * MIN, lastProgressAt: 3 * MIN }, limits)).toBe("idle");
  });
  it("counts command activity as progress", () => {
    expect(progressVerdict({ startedAt: 0, now: 14 * MIN, firstChangeAt: 3 * MIN, lastProgressAt: 8 * MIN }, limits)).toBe("ok");
  });
  it("never reports no_first_edit after a change", () => {
    expect(progressVerdict({ startedAt: 0, now: 60 * MIN, firstChangeAt: MIN, lastProgressAt: 59 * MIN }, limits)).toBe("ok");
  });
});

describe("CliProvider no-progress guard", () => {
  beforeEach(() => { vi.useFakeTimers(); kills.length = 0; fakeChildren.length = 0; });
  afterEach(() => { vi.useRealTimers(); });
  const input = (progress?: { firstEditMinutes: number; idleMinutes: number }, stage = "implement"): StageInput => ({ stage, prompt: "do it", projectRoot: "/repo", plugins: [], ...(progress ? { progress } : {}) } as unknown as StageInput);
  const start = async (provider: InstanceType<typeof CliProvider>, i: StageInput) => {
    const result = provider.run(i).then(value => ({ value }), (error: Error) => ({ error }));
    await vi.advanceTimersByTimeAsync(0);
    return { result, child: fakeChildren[fakeChildren.length - 1]! };
  };
  const guard = (sample: () => Promise<string>) => ({ intervalMs: 30_000, sample });
  const itemDone = { type: "item.completed", item: { type: "command_execution" } };

  it("kills the child and rejects with the reason and the activity when nothing changes", async () => {
    const { result, child } = await start(new CliProvider("codex", 10 * 60 * MIN, guard(async () => "")), input({ firstEditMinutes: 15, idleMinutes: 10 }));
    child.emitEvent(itemDone);
    await vi.advanceTimersByTimeAsync(15 * MIN + 30_000);
    const settled = await result;
    expect(kills).toEqual([child]);
    expect((settled as { error: Error }).error.message).toMatch(/^codex no progress: no file change in 15 minutes \(activity before the kill: 1 command_execution; 0 turn\(s\)\)/);
  });

  it("kills a run that edited once and then went quiet, with the idle reason", async () => {
    let signature = "";
    const { result } = await start(new CliProvider("codex", 10 * 60 * MIN, guard(async () => signature)), input({ firstEditMinutes: 15, idleMinutes: 10 }));
    await vi.advanceTimersByTimeAsync(3 * MIN);
    signature = " M a.ts";
    await vi.advanceTimersByTimeAsync(11 * MIN);
    expect(((await result) as { error: Error }).error.message).toMatch(/^codex no progress: no file change or command in 10 minutes/);
  });

  it("does not kill a run that keeps working: a change, then steady commands and no further file change", async () => {
    let signature = "";
    const provider = new CliProvider("codex", 10 * 60 * MIN, guard(async () => signature));
    const { result, child } = await start(provider, input({ firstEditMinutes: 15, idleMinutes: 10 }));
    await vi.advanceTimersByTimeAsync(MIN);
    signature = " M a.ts";
    for (let i = 0; i < 40; i++) { child.emitEvent(itemDone); await vi.advanceTimersByTimeAsync(MIN); }
    expect(kills).toEqual([]);
    child.exitCode = 0; child.emitEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } }); child.emit("close", 0);
    expect(((await result) as { value: { ok: boolean } }).value.ok).toBe(true);
  });

  it("is not active without input.progress, for other stages or for other providers", async () => {
    const samples = vi.fn(async () => "");
    for (const [id, i] of [["codex", input()], ["codex", input({ firstEditMinutes: 1, idleMinutes: 1 }, "plan")], ["claude", input({ firstEditMinutes: 1, idleMinutes: 1 })]] as const) {
      const { result, child } = await start(new CliProvider(id, 10 * 60 * MIN, guard(samples)), i);
      await vi.advanceTimersByTimeAsync(14 * MIN);
      expect(kills).toEqual([]);
      child.exitCode = 0; child.emit("close", 0); await result;
    }
    expect(samples).not.toHaveBeenCalled();
  });

  it("keeps counting events after the 1 MB output cap, so a healthy run is not idle", async () => {
    let signature = "";
    const { result, child } = await start(new CliProvider("codex", 10 * 60 * MIN, guard(async () => signature)), input({ firstEditMinutes: 15, idleMinutes: 10 }));
    await vi.advanceTimersByTimeAsync(MIN);
    signature = " M a.ts";
    for (let i = 0; i < 4; i++) child.emitEvent({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(400_000) } });
    for (let i = 0; i < 60; i++) { child.emitEvent(itemDone); await vi.advanceTimersByTimeAsync(MIN); }
    expect(kills).toEqual([]);
    child.exitCode = 0; child.emit("close", 0); await result;
  });

  it("never kills for lack of a first edit while every git sample fails", async () => {
    const { result, child } = await start(new CliProvider("codex", 10 * 60 * MIN, guard(async () => { throw new Error("git is gone"); })), input({ firstEditMinutes: 15, idleMinutes: 10 }));
    for (let i = 0; i < 20; i++) { child.emitEvent(itemDone); await vi.advanceTimersByTimeAsync(MIN); }
    expect(kills).toEqual([]);
    child.exitCode = 0; child.emit("close", 0); await result;
  });

  it("does not call a run idle while a command is still in flight; the stall watchdog stays the backstop", async () => {
    let signature = "";
    const { result, child } = await start(new CliProvider("codex", 10 * 60 * MIN, guard(async () => signature)), input({ firstEditMinutes: 15, idleMinutes: 10 }));
    await vi.advanceTimersByTimeAsync(MIN);
    signature = " M a.ts";
    child.emitEvent({ type: "item.started", item: { type: "command_execution" } });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(((await result) as { error: Error }).error.message).toMatch(/^codex stalled: no output for 45 minutes/);
  });

  it("counts a completed Codex file_change event as the first edit and as progress, with an unchanged worktree sample", async () => {
    const { result, child } = await start(new CliProvider("codex", 10 * 60 * MIN, guard(async () => " M a.ts")), input({ firstEditMinutes: 15, idleMinutes: 10 }));
    await vi.advanceTimersByTimeAsync(3 * MIN);
    child.emitEvent({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts", kind: "update" }] } });
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(((await result) as { error: Error }).error.message).toMatch(/^codex no progress: no file change or command in 10 minutes/);
  });

  it("treats a failing git sample as unknown and never kills because of it", async () => {
    let calls = 0;
    const { result, child } = await start(new CliProvider("codex", 10 * 60 * MIN, guard(async () => { calls++; throw new Error("git is gone"); })), input({ firstEditMinutes: 15, idleMinutes: 10 }));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(calls).toBeGreaterThan(5);
    expect(kills).toEqual([]);
    child.exitCode = 0; child.emit("close", 0); await result;
  });
});

describe("worktreeSignature", () => {
  it("changes when an already-modified file is edited again, although git status stays the same", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-sig-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "pipe" }).toString();
      git("init", "-q"); await writeFile(path.join(root, "a.ts"), "base\n"); git("add", "-A"); git("commit", "-qm", "base");
      await writeFile(path.join(root, "a.ts"), "first edit\n"); const first = await worktreeSignature(root); const status = git("status", "--porcelain");
      await writeFile(path.join(root, "a.ts"), "second edit\n"); const second = await worktreeSignature(root);
      expect(git("status", "--porcelain")).toBe(status);
      expect(second).not.toBe(first);
      expect(await worktreeSignature(root)).toBe(second);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("hashes git diff --stat when the diff is larger than the read cap", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => { calls.push(args); if (args[0] === "diff" && !args.includes("--stat")) throw Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }); return args[0] === "status" ? " M big.bin\n" : " big.bin | 2 +-\n"; };
    const signature = await worktreeSignature("/repo", exec);
    expect(calls.map(args => args.join(" "))).toEqual(["status --porcelain", "diff", "diff --stat"]);
    expect(signature.startsWith(" M big.bin\n")).toBe(true);
    await expect(worktreeSignature("/repo", async args => { if (args[0] === "status") throw new Error("not a repository"); return ""; })).rejects.toThrow("not a repository");
  });
});
