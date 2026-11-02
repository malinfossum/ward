// Runs a repo's Pester tests under pwsh 7 with Pester 5 (tools/pester.ps1) and
// fails on a failed test, block or test file, and on a run that finds no tests.
// pwsh runs as an argument array, never through a shell, and the path reaches
// the script through the environment, never inside its text.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Installed only on a runner that has no Pester 5 of its own.
export const PESTER_VERSION = "5.9.1";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pester.ps1");

export const pwshArgs = (script = SCRIPT) => ["-NoProfile", "-NonInteractive", "-File", script];

// Pester discovers *.Tests.ps1 below a directory, or runs the one file named.
// Without any it throws before it writes a result, so the check looks first.
export const isTestFile = (name) => name.toLowerCase().endsWith(".tests.ps1");

export function testFiles(path) {
  if (!statSync(path).isDirectory()) return isTestFile(path) ? [path] : [];
  return readdirSync(path, { recursive: true }).filter((file) => isTestFile(String(file)));
}

const NO_TESTS = (path) =>
  `::error::No Pester tests found under ${path}. A repo with PowerShell tests needs at least one *.Tests.ps1.`;

// The error lines for one run; none means it passed. counts is what pester.ps1
// wrote, null when pwsh stopped before it got that far.
export function verdict(counts, path) {
  if (!counts) return ["::error::Pester did not finish; the log above says why."];
  const { total, failed, failedBlocks, failedContainers } = counts;
  if (counts.result === "Failed" || failed > 0 || failedBlocks > 0 || failedContainers > 0) {
    return [
      `::error::Pester failed: ${failed} of ${total} tests, ${failedBlocks} blocks and ${failedContainers} test files.`,
    ];
  }
  return total === 0 ? [NO_TESTS(path)] : [];
}

function readCounts(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const path = process.argv[2] ?? ".";
  if (!existsSync(path)) {
    console.log(`::error::${path} does not exist.`);
    process.exitCode = 1;
    return;
  }
  if (testFiles(path).length === 0) {
    console.log(NO_TESTS(path));
    process.exitCode = 1;
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "ward-pester-"));
  try {
    const result = join(dir, "result.json");
    console.log("::group::pester");
    spawnSync("pwsh", pwshArgs(), {
      stdio: "inherit",
      env: {
        ...process.env,
        POWERSHELL_TELEMETRY_OPTOUT: "1",
        POWERSHELL_UPDATECHECK: "Off",
        WARD_PESTER_PATH: path,
        WARD_PESTER_RESULT: result,
        WARD_PESTER_VERSION: PESTER_VERSION,
      },
    });
    console.log("::endgroup::");
    const errors = verdict(readCounts(result), path);
    for (const line of errors) console.log(line);
    if (errors.length) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
