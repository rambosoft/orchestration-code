import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeStage } from "../src/activities.js";
import { QualityCommandSchema } from "../src/contracts.js";
import { parseJUnit, parseNUnit, readReport, reportFiles, summarizeFailures } from "../src/test-report.js";

const T = String.fromCharCode(9);
const nunit = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="3" result="Failed" total="3" passed="1" failed="2" inconclusive="0" skipped="0">
  <test-suite type="Assembly" name="Game.Tests.dll" result="Failed">
    <test-case id="1" name="MergeOnce" fullname="Game.Tests.RulesTests.MergeOnce" result="Failed">
      <failure><message><![CDATA[  Expected: 3
  But was:  2
]]></message><stack-trace><![CDATA[at Game.Tests.RulesTests.MergeOnce () [0x00012] in C:/w/x/Assets/Tests/EditMode/RulesTests.cs:42
at System.Reflection.RuntimeMethodInfo.Invoke (System.Object obj) [0x00000] in <hash>:0
at NUnit.Framework.Internal.Commands.TestMethodCommand.Execute (NUnit.Framework.Internal.ITestExecutionContext context) [0x00020] in <hash>:0
]]></stack-trace></failure>
    </test-case>
    <test-case id="2" name="Spawn" fullname="Game.Tests.RulesTests.Spawn" result="Passed"/>
    <test-case id="3" name="Undo" fullname="Game.Tests.RulesTests.Undo" result="Failed"><failure><message>Object reference not set &amp; so on</message></failure></test-case>
  </test-suite>
</test-run>`;
const surefire = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.shop.OrderServiceTest" tests="3" errors="1" skipped="0" failures="1" time="0.5">
  <testcase name="addsItem" classname="com.acme.shop.OrderServiceTest" time="0.01"/>
  <testcase name="rejectsEmptyCart" classname="com.acme.shop.OrderServiceTest" time="0.02">
    <failure message="expected: &lt;400&gt; but was: &lt;200&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;400&gt; but was: &lt;200&gt;
${T}at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)
${T}at com.acme.shop.OrderServiceTest.rejectsEmptyCart(OrderServiceTest.java:31)
${T}at java.base/java.lang.reflect.Method.invoke(Method.java:580)
</failure>
  </testcase>
  <testcase name="loadsPrices" classname="com.acme.shop.OrderServiceTest"><error message="Connection refused" type="java.net.ConnectException">java.net.ConnectException: Connection refused
${T}at com.acme.shop.PriceClient.fetch(PriceClient.java:12)
</error></testcase>
</testsuite>`;

describe("parsers", () => {
  it("reads NUnit failures with decoded messages and traces, and the totals", () => {
    const report = parseNUnit(nunit);
    expect(report).toMatchObject({ total: 3, failed: 2 });
    expect(report.failures.map(failure => failure.name)).toEqual(["Game.Tests.RulesTests.MergeOnce", "Game.Tests.RulesTests.Undo"]);
    expect(report.failures[0]!.message).toBe("Expected: 3\n  But was:  2");
    expect(report.failures[0]!.trace).toContain("RulesTests.cs:42");
    expect(report.failures[1]!.message).toBe("Object reference not set & so on");
  });
  it("reads JUnit failures and errors (Maven, Gradle, pytest, Jest reporters)", () => {
    const report = parseJUnit(surefire);
    expect(report).toMatchObject({ total: 3, failed: 2 });
    expect(report.failures.map(failure => failure.name)).toEqual(["com.acme.shop.OrderServiceTest.rejectsEmptyCart", "com.acme.shop.OrderServiceTest.loadsPrices"]);
    expect(report.failures[0]!.message).toBe("expected: <400> but was: <200>");
    expect(report.failures[1]!.trace).toContain("PriceClient.fetch(PriceClient.java:12)");
    expect(parseJUnit('<testsuites><testsuite tests="1" failures="0"><testcase name="a" classname="B"/></testsuite></testsuites>')).toMatchObject({ total: 1, failed: 0, failures: [] });
    expect(parseJUnit("not xml")).toEqual({ failures: [], failed: 0 });
  });
  it("tells the failing tests in a few lines, with the project frames of the trace and not the framework's", () => {
    const text = summarizeFailures(parseJUnit(surefire));
    expect(text).toContain("2 of 3 test(s) failed:");
    expect(text).toContain("1. com.acme.shop.OrderServiceTest.rejectsEmptyCart");
    expect(text).toContain("expected: <400> but was: <200>");
    expect(text).toContain("OrderServiceTest.java:31");
    expect(text).not.toContain("java.lang.reflect.Method.invoke");
    expect(summarizeFailures({ failures: [], failed: 0 })).toBe("");
    const many = summarizeFailures({ failed: 30, total: 40, failures: Array.from({ length: 30 }, (_, index) => ({ name: `T${index}`, message: "boom", trace: "" })) });
    expect(many).toContain("... and 20 more failing test(s)");
  });
});

describe("report files", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  async function project() { const dir = await mkdtemp(path.join(os.tmpdir(), "orch-report-")); dirs.push(dir); await mkdir(path.join(dir, "target", "surefire-reports"), { recursive: true }); return dir; }

  it("finds one file or a pattern with a star, merges several reports, and never leaves the project folder", async () => {
    const dir = await project();
    await writeFile(path.join(dir, "target", "surefire-reports", "TEST-A.xml"), surefire);
    await writeFile(path.join(dir, "target", "surefire-reports", "TEST-B.xml"), surefire);
    await writeFile(path.join(dir, "target", "surefire-reports", "A.txt"), "x");
    expect((await reportFiles({ format: "junit", path: "target/surefire-reports/TEST-*.xml" }, dir)).map(file => path.basename(file))).toEqual(["TEST-A.xml", "TEST-B.xml"]);
    const merged = await readReport({ format: "junit", path: "target/surefire-reports/TEST-*.xml" }, dir);
    expect(merged).toMatchObject({ total: 6, failed: 4 });
    expect(merged.failures).toHaveLength(4);
    for (const bad of ["../outside.xml", "/etc/report.xml", "C:/x/report.xml", "a/../../b.xml"]) expect(await reportFiles({ format: "junit", path: bad }, dir), bad).toEqual([]);
    expect(await readReport({ format: "junit", path: "missing/*.xml" }, dir)).toEqual({ failures: [], failed: 0 });
  });
  it("is declared in the manifest with a safe relative path", () => {
    const base = { executable: "npm" as const, args: ["test"] };
    expect(QualityCommandSchema.parse({ ...base, report: { format: "junit", path: "target/surefire-reports/*.xml" } }).report).toBeDefined();
    expect(QualityCommandSchema.parse(base).report).toBeUndefined();
    for (const bad of ["../x.xml", "/abs.xml", "C:/x.xml", "a/../../x.xml"]) expect(() => QualityCommandSchema.parse({ ...base, report: { format: "junit", path: bad } }), bad).toThrow();
    expect(() => QualityCommandSchema.parse({ ...base, report: { format: "trx", path: "a.xml" } })).toThrow();
  });
  it("leads a failed gate's finding with the list of failing tests when the command declares its report", async () => {
    const dir = await project();
    await writeFile(path.join(dir, "target", "surefire-reports", "TEST-A.xml"), surefire);
    const result = await executeStage({ runId: "r", taskId: "t", projectId: "p", profile: "implementation", stage: "verify", prompt: "task", attempt: 1, provider: "fake", plugins: [], verificationOnly: true, projectRoot: dir, artifactsDir: dir, qualityCommands: [{ executable: "node", args: ["-e", "console.log('BUILD FAILURE'); process.exit(1)"], report: { format: "junit", path: "target/surefire-reports/TEST-*.xml" } }] });
    expect(result.ok).toBe(false);
    const finding = result.findings.join("\n");
    expect(finding.startsWith("2 of 3 test(s) failed:")).toBe(true);
    expect(finding).toContain("OrderServiceTest.java:31");
    expect(finding).toContain("BUILD FAILURE");
  });
});
