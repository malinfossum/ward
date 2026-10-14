// The CodeQL languages a repo needs, from the files git tracks. The codeql
// workflow's first job runs this and hands the list to the analyze matrix, so
// a new language in a repo is picked up on its next run with nothing to set.
// apply.mjs runs the same function over a checkout before it turns default
// setup off, so the workflow never scans less than default setup did. Any
// change here means a new pin for the codeql job in templates/ward.yml.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ignored, loadStacks } from "./stacks.mjs";

// In output order, after actions, which is always there: every warded repo
// has its caller. A header alone is not code CodeQL can extract, and a run with
// nothing to extract fails, so .h and .hpp never count.
const RULES = [
  ["csharp", /\.cs$/i],
  ["javascript-typescript", /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i],
  ["python", /\.py$/i],
  ["c-cpp", /\.(?:c|cc|cpp|cxx|c\+\+)$/i],
];

export const LANGUAGES = ["actions", ...RULES.map(([name]) => name)];

// CodeQL's extractor skips minified code, so a tree with only vendored .min.js
// files would get a JavaScript run with nothing to extract, which fails.
const MINIFIED = /\.min\.js$/i;

// paths are repo-relative with forward slashes; ignore is stacks.json's list.
// The result only ever holds names from LANGUAGES, whatever the paths are.
export function languagesFor(paths, ignore) {
  const kept = paths.filter((path) => !ignored(path, ignore) && !MINIFIED.test(path));
  const found = RULES.filter(([, pattern]) => kept.some((path) => pattern.test(path)));
  return ["actions", ...found.map(([name]) => name)];
}

// The files git tracks under dir, split on NUL so a name with a newline in it
// stays one path. null when git fails there (not a work tree). The buffer is
// raised from 1 MiB so a large repo's list is never cut short.
export function trackedFiles(dir) {
  const listed = spawnSync("git", ["-C", dir, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) return null;
  return listed.stdout.split("\0").filter(Boolean);
}

function main() {
  const paths = trackedFiles(".");
  if (!paths) {
    console.log("::error::git ls-files failed here; run this inside a checkout.");
    process.exitCode = 1;
    return;
  }
  const line = `languages=${JSON.stringify(languagesFor(paths, loadStacks().ignore))}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
