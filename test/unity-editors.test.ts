import { describe, expect, it, vi } from "vitest";
import { VisualConfigSchema } from "../src/contracts.js";
import { captureUnityScreenshots, editorPidsFor, stopProjectEditors, type ProcessInfo } from "../src/unity.js";

const editor = (pid: number, project: string, extra = ""): ProcessInfo => ({ pid, commandLine: `"C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.11f1\\Editor\\Unity.exe" -projectPath ${project} ${extra}`.trim() });

describe("Unity editors left open on a worktree", () => {
  it("selects only the Editors that have exactly this project open, whatever the path spelling", () => {
    const processes = [
      editor(1, "C:\\w\\run-a"),
      editor(2, "\"C:/w/run-a\" -useHub"),
      editor(3, "C:\\w\\run-b"),
      editor(4, "C:\\w\\run-a-copy"),
      { pid: 5, commandLine: "Unity.exe -batchmode" },
      { pid: 6, commandLine: "" },
    ];
    expect(editorPidsFor(processes, "C:\\w\\run-a")).toEqual([1, 2]);
    expect(editorPidsFor(processes, "c:/w/RUN-B/")).toEqual([3]);
    expect(editorPidsFor(processes, "C:\\w\\none")).toEqual([]);
  });

  it("kills what it found, reports the ids and never throws", async () => {
    const kill = vi.fn();
    vi.useFakeTimers();
    const pending = stopProjectEditors("C:\\w\\run-a", { list: async () => [editor(11, "C:\\w\\run-a"), editor(12, "C:\\w\\other")], kill });
    await vi.advanceTimersByTimeAsync(3500);
    expect(await pending).toEqual([11]);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(11);
    vi.useRealTimers();
    expect(await stopProjectEditors("C:\\w\\run-a", { list: async () => { throw new Error("no powershell"); }, kill })).toEqual([]);
  });

  it("stops the Editors before the screenshot capture and says so", async () => {
    const config = VisualConfigSchema.parse({ engine: "unity", unityFilter: "CaptureTests" });
    const order: string[] = [];
    const result = await captureUnityScreenshots(config, { cwd: "C:\\w\\run-a", outDir: "C:\\w\\run-a-out" }, {
      stopEditors: async () => { order.push("stop"); return [7]; },
      run: async () => { order.push("run"); return { code: 0, output: "", stderr: "" }; },
    });
    expect(order).toEqual(["stop", "run"]);
    expect(result.warnings.join(" ")).toContain("stopped 1 Unity process");
  });
});
