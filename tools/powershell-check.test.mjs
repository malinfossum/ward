import assert from "node:assert/strict";
import { test } from "node:test";
import { isTestFile, PESTER_VERSION, pwshArgs, testFiles, verdict } from "./powershell-check.mjs";

test("Pester's test files end in .Tests.ps1, in any case", () => {
  assert.ok(isTestFile("tests/Map.Tests.ps1"));
  assert.ok(isTestFile("test/nanoserver.tests.ps1"));
  assert.ok(!isTestFile("lib/Map.ps1"));
  assert.ok(!isTestFile("Tests.ps1.bak"));
});

test("test files are found below a directory, or the one file named", () => {
  assert.deepEqual(testFiles("fixtures/powershell-ok").length, 1);
  assert.deepEqual(testFiles("fixtures/powershell-notests"), []);
  const file = "fixtures/powershell-ok/tests/Greeting.Tests.ps1";
  assert.deepEqual(testFiles(file), [file]);
  assert.deepEqual(testFiles("fixtures/powershell-ok/Greeting.ps1"), []);
});

const PASSED = {
  result: "Passed",
  total: 3,
  passed: 3,
  failed: 0,
  skipped: 0,
  failedBlocks: 0,
  failedContainers: 0,
};

test("a run with passing tests passes", () => {
  assert.deepEqual(verdict(PASSED, "tests"), []);
});

test("a failed test, block or test file fails the run", () => {
  for (const counts of [
    { ...PASSED, result: "Failed", passed: 2, failed: 1 },
    { ...PASSED, result: "Failed", failedBlocks: 1 },
    { ...PASSED, result: "Failed", total: 0, passed: 0, failedContainers: 1 },
  ]) {
    const [line] = verdict(counts, "tests");
    assert.match(line, /^::error::Pester failed: /, JSON.stringify(counts));
  }
  assert.deepEqual(verdict({ ...PASSED, result: "Failed", passed: 2, failed: 1 }, "tests"), [
    "::error::Pester failed: 1 of 3 tests, 0 blocks and 0 test files.",
  ]);
});

test("a run that finds no tests fails, so a wrong path is never green", () => {
  const none = { ...PASSED, total: 0, passed: 0 };
  assert.deepEqual(verdict(none, "test"), [
    "::error::No Pester tests found under test. A repo with PowerShell tests needs at least one *.Tests.ps1.",
  ]);
});

test("a run that stopped before writing its counts fails", () => {
  assert.deepEqual(verdict(null, "tests"), [
    "::error::Pester did not finish; the log above says why.",
  ]);
});

test("pwsh runs the script file without a profile or prompts, and the fallback Pester is a pinned 5.x", () => {
  assert.deepEqual(pwshArgs("x.ps1"), ["-NoProfile", "-NonInteractive", "-File", "x.ps1"]);
  assert.match(PESTER_VERSION, /^5\.\d+\.\d+$/);
});
