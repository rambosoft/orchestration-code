import { describe, expect, it } from "vitest";
import { compactEmbeddedLogs, compactLog } from "../src/log-compact.js";

const frames = (count: number, make: (index: number) => string) => Array.from({ length: count }, (_, index) => make(index));

describe("compactLog: lines that differ only by an item id", () => {
  const rule = (id: string) => `warning rule-trace: ${id} from docs/RULES_SPEC.md is not referenced by any test (add "Covers: ${id}" to the test that proves it)`;
  it("folds a run of three or more into the first line with a count and the last id", () => {
    const out = compactLog(Array.from({ length: 16 }, (_, i) => rule(`R-${String(i + 1).padStart(3, "0")}`)).join("\n"));
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("R-001");
    expect(out).toContain("[+15 similar, up to R-016]");
  });
  it("leaves two lines, lines without ids, and different messages alone", () => {
    expect(compactLog([rule("R-001"), rule("R-002")].join("\n")).split("\n")).toHaveLength(2);
    expect(compactLog("build failed\nbuild failed because Foo is missing\nbuild ok").split("\n")).toHaveLength(3);
    expect(compactLog([rule("R-001"), "error: Game.cs(3): CS1002", rule("R-002"), rule("R-003")].join("\n")).split("\n")).toHaveLength(4);
  });
  it("does not hide a failing test id among passing ones", () => {
    const out = compactLog(["T1-AC1 passed", "T1-AC2 passed", "T1-AC3 passed", "T1-AC4 FAILED: expected 3 got 4"].join("\n"));
    expect(out).toContain("T1-AC4 FAILED: expected 3 got 4");
  });
});

describe("compactLog: stack traces of every supported stack", () => {
  it("keeps the project frames and the cause chain of a Spring Boot failure and folds the framework frames", () => {
    const text = [
      "2026-10-26T01:02:03.456Z ERROR 4242 --- [main] o.s.boot.SpringApplication : Application run failed",
      "org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'orderService': Invocation of init method failed",
      ...frames(40, index => `\tat org.springframework.beans.factory.support.Bean${index}.create(Bean${index}.java:${100 + index})`),
      "\tat com.acme.shop.OrderService.<init>(OrderService.java:42)",
      "\tat com.acme.shop.Application.main(Application.java:12)",
      "Caused by: java.lang.IllegalStateException: price missing for sku 7",
      "\tat com.acme.shop.PriceTable.lookup(PriceTable.java:77)",
      ...frames(20, index => `\tat org.hibernate.engine.Thing${index}.run(Thing${index}.java:9)`),
      "\t... 30 common frames omitted",
    ].join("\n");
    const out = compactLog(text);
    expect(out).toContain("BeanCreationException: Error creating bean with name 'orderService'");
    expect(out).toContain("com.acme.shop.OrderService.<init>(OrderService.java:42)");
    expect(out).toContain("Caused by: java.lang.IllegalStateException: price missing for sku 7");
    expect(out).toContain("com.acme.shop.PriceTable.lookup(PriceTable.java:77)");
    expect(out).toContain("... 40 framework frames ...");
    expect(out).not.toContain("Bean17.create");
    expect(out).not.toContain("2026-10-26T01:02:03");
    expect(out.length).toBeLessThan(text.length / 4);
  });
  it("compacts a Unity/NUnit failure to the assertion and the game's own frames", () => {
    const text = [
      "  Expected: 3", "  But was:  2",
      "  at Game.Tests.RulesTests.MergeOnce () [0x00012] in C:\\w\\x\\Assets\\Tests\\EditMode\\RulesTests.cs:42",
      "  at (wrapper managed-to-native) System.Reflection.RuntimeMethodInfo.InternalInvoke (System.Reflection.RuntimeMethodInfo,object,object[],System.Exception&)",
      ...frames(30, index => `  at System.Reflection.RuntimeMethodInfo.Invoke${index} (System.Object obj) [0x00000] in <hash>:0`),
      "  at NUnit.Framework.Internal.Commands.TestMethodCommand.Execute (NUnit.Framework.Internal.ITestExecutionContext context) [0x00020] in <hash>:0",
      "UnityEngine.Debug:LogError (object)", "Game.Runtime.Board:Merge () (at Assets/Scripts/Board.cs:88)", "(Filename: Assets/Scripts/Board.cs Line: 88)",
    ].join("\n");
    const out = compactLog(text);
    expect(out).toContain("Expected: 3");
    expect(out).toContain("But was:  2");
    expect(out).toContain("Game.Tests.RulesTests.MergeOnce () [0x00012]");
    expect(out).toMatch(/\.\.\. 3\d framework frames \.\.\./);
    expect(out).not.toContain("Invoke17");
    expect(out.split("\n").length).toBeLessThan(14);
  });
  it("handles Node, Python, Go and Rust traces", () => {
    const node = ["TypeError: x is not a function", "    at Object.<anonymous> (C:\\p\\test\\a.test.ts:10:5)", ...frames(12, index => `    at Module._load${index} (node:internal/modules/cjs/loader:${index}:14)`), "    at runner (C:\\p\\node_modules\\vitest\\dist\\index.js:5:1)"].join("\n");
    expect(compactLog(node)).toContain("a.test.ts:10:5");
    expect(compactLog(node)).toMatch(/\.\.\. 13 framework frames \.\.\./);
    const python = ["Traceback (most recent call last):", '  File "app/orders.py", line 12, in total', "    return price[sku]", ...frames(10, index => `  File "/usr/lib/python3.12/site-packages/lib${index}.py", line ${index}, in f`), "KeyError: 'sku-7'"].join("\n");
    const py = compactLog(python);
    expect(py).toContain('File "app/orders.py", line 12, in total');
    expect(py).toContain("KeyError: 'sku-7'");
    expect(py).not.toContain("lib7.py");
    const go = ["panic: runtime error: index out of range [3] with length 3", "", "goroutine 6 [running]:", "\t/work/shop/orders.go:44 +0x1d", "\t/usr/local/go/src/testing/testing.go:1689 +0x21c", "\t/usr/local/go/src/runtime/panic.go:770 +0x132"].join("\n");
    expect(compactLog(go)).toContain("/work/shop/orders.go:44");
    expect(compactLog(go)).toContain("panic: runtime error: index out of range");
    const rust = ["thread 'main' panicked at src/orders.rs:9:5:", "called `Option::unwrap()` on a `None` value", "stack backtrace:", "   0: std::panicking::begin_panic", "             at /rustc/abc/library/std/src/panicking.rs:1:1", "   1: shop::orders::total", "             at ./src/orders.rs:9:5", "   2: core::ops::function::FnOnce::call_once"].join("\n");
    const rs = compactLog(rust);
    expect(rs).toContain("shop::orders::total");
    expect(rs).toContain("called `Option::unwrap()` on a `None` value");
  });
  it("counts a repeated trace once and says it was repeated", () => {
    const one = ["java.lang.IllegalStateException: boom", "\tat com.acme.A.run(A.java:1)", "\tat com.acme.B.run(B.java:2)"];
    const out = compactLog([...one, "next request", ...one, "next request", ...one].join("\n"));
    expect(out.match(/com\.acme\.A\.run/g)).toHaveLength(1);
    expect(out).toContain("(same stack trace as an earlier one, again)");
  });
});

describe("compactLog: noise and size", () => {
  it("removes colour codes, timestamps and progress redraws, and counts repeated lines", () => {
    const text = ["\x1b[31mFAIL\x1b[0m test/a.test.ts", "2026-10-26 01:02:03,123 INFO starting", "Downloading 10%\rDownloading 55%\rDownloading 100%", ...frames(5, () => "warning: unused variable"), "", "", "", "done"].join("\n");
    const out = compactLog(text);
    expect(out).toContain("FAIL test/a.test.ts");
    expect(out).not.toContain("\x1b");
    expect(out).toContain("INFO starting");
    expect(out).not.toContain("2026-10-26");
    expect(out).toContain("Downloading 100%");
    expect(out).not.toContain("Downloading 10%");
    expect(out).toContain("warning: unused variable (x5)");
    expect(out).not.toMatch(/\n\n\n/);
  });
  it("keeps the error lines when a long log must be cut, and stays within the limit", () => {
    const text = [...frames(500, index => `compiling module ${index} ok`), "src/Board.cs(88,13): error CS0103: The name 'cell' does not exist in the current context", ...frames(500, index => `linking part ${index} ok`)].join("\n");
    const out = compactLog(text, { maxChars: 1500 });
    expect(out).toContain("error CS0103");
    expect(out.length).toBeLessThanOrEqual(1700);
    expect(out).toContain("left out");
  });
  it("returns a short, clean log as it is and is stable when applied twice", () => {
    expect(compactLog("expected 1 to be 2\nat test.ts:3")).toBe("expected 1 to be 2\nat test.ts:3".replace(/^at/m, "at"));
    const noisy = ["Boom", ...frames(30, index => `\tat org.springframework.X${index}.y(X.java:${index})`), "\tat com.acme.A.run(A.java:1)"].join("\n");
    expect(compactLog(compactLog(noisy))).toBe(compactLog(noisy));
  });
  it("never shortens text that has nothing to compact", () => {
    const text = "line one\nline two\nline three";
    expect(compactLog(text)).toBe(text);
    expect(compactLog("")).toBe("");
  });
});

describe("compactEmbeddedLogs", () => {
  it("compacts a pasted trace inside a task description and leaves the prose and short snippets alone", () => {
    const trace = ["Exception in thread \"main\" java.lang.NullPointerException", ...frames(60, index => `\tat org.springframework.web.Filter${index}.doFilter(Filter${index}.java:${index})`), "\tat com.acme.shop.CartController.add(CartController.java:31)"].join("\n");
    const text = `Adding an item to the cart crashes the server.\n\nHere is the log:\n${trace}\n\nExpected: the item is added.\nSee \`at com.acme.A.run(A.java:1)\` for one frame.`;
    const out = compactEmbeddedLogs(text);
    expect(out).toContain("Adding an item to the cart crashes the server.");
    expect(out).toContain("Expected: the item is added.");
    expect(out).toContain("CartController.add(CartController.java:31)");
    expect(out).toContain("[log block compacted from 62 to");
    expect(out).not.toContain("Filter41");
    expect(out.length).toBeLessThan(text.length / 3);
    const short = "Crash seen:\n\tat com.acme.A.run(A.java:1)\n\tat com.acme.B.run(B.java:2)\nplease fix";
    expect(compactEmbeddedLogs(short)).toBe(short);
  });
  it("compacts a timestamped CI log block", () => {
    const log = frames(40, index => `2026-10-26T01:00:${String(index % 60).padStart(2, "0")}Z step ${index} downloading dependency`).join("\n");
    const out = compactEmbeddedLogs(`CI said:\n${log}\nthen it failed`);
    expect(out).toContain("[log block compacted from 40 to");
    expect(out).toContain("CI said:");
    expect(out).toContain("then it failed");
  });
});

describe("failed gate output", () => {
  it("gives the workflow a compact finding and keeps the full output in the artifact for people", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os"); const path = await import("node:path");
    const { executeStage } = await import("../src/activities.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "orch-gate-compact-"));
    try {
      // No backslash escapes inside the child script: tab and newline come from char codes.
      const script = "const T=String.fromCharCode(9),N=String.fromCharCode(10),l=['Exception in thread main java.lang.IllegalStateException: boom'];for(let i=0;i<300;i++)l.push(T+'at org.springframework.web.F'+i+'.go(F'+i+'.java:'+i+')');l.push(T+'at com.acme.A.run(A.java:1)');console.error(l.join(N));process.exit(1)";
      const result = await executeStage({ runId: "r", taskId: "t", projectId: "p", profile: "implementation", stage: "verify", prompt: "task", attempt: 1, provider: "fake", plugins: [], verificationOnly: true, projectRoot: dir, artifactsDir: dir, qualityCommands: [{ executable: "node", args: ["-e", script] }] });
      expect(result.ok).toBe(false);
      const finding = result.findings.join("\n");
      expect(finding).toContain("IllegalStateException: boom");
      expect(finding).toContain("com.acme.A.run(A.java:1)");
      expect(finding).toContain("300 framework frames");
      expect(finding.length).toBeLessThan(800);
      const stored = JSON.parse(await readFile(result.artifactRefs[0]!, "utf8")) as { checks: Array<{ stderr: string }> };
      // The artifact keeps the compacted output (cause, project frames, counts), including the frame that came last in a 300-frame trace that a 5 000 character head cap used to cut.
      expect(stored.checks[0]!.stderr).toContain("com.acme.A.run(A.java:1)");
      expect(stored.checks[0]!.stderr.length).toBeLessThan(2000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
