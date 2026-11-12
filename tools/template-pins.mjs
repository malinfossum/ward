// Checks that the caller template pins Ward's workflows to release tag commits.
// Dependabot moves a pin from tag to tag only when the pin sits on a vX.Y.Z
// tag's commit. On any other commit it tracks main and keeps a stale comment,
// and a commit off a side branch can run older code than the comment says.
// It reads the tags of the checkout it runs in, so it makes no network call of
// its own: Ward's fixtures job checks out with every tag from GitHub, and a
// local run needs `git fetch --tags` first. A missing tag fails, never passes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const WARD_PINS =
  /malinfossum\/ward\/\.github\/workflows\/([\w.-]+\.yml)@([0-9a-f]{40})(?: # (\S+))?/g;

// Maps each vX.Y.Z tag to its commit. %(*objectname) is the commit an annotated
// tag points at; a lightweight tag leaves it empty and names the commit itself.
export function releaseTags(dir) {
  const listed = spawnSync(
    "git",
    [
      "-C",
      dir,
      "for-each-ref",
      "--format=%(refname:short) %(objectname) %(*objectname)",
      "refs/tags/v*",
    ],
    { encoding: "utf8" },
  );
  if (listed.status !== 0) return null;
  const tags = new Map();
  for (const line of listed.stdout.split(/\r?\n/)) {
    const [tag, object, peeled] = line.trim().split(" ");
    if (/^v\d+\.\d+\.\d+$/.test(tag ?? "")) tags.set(tag, peeled || object);
  }
  return tags;
}

export function pinProblems(text, tags) {
  const problems = [];
  for (const [, file, sha, comment] of text.matchAll(WARD_PINS)) {
    const named = [...tags].filter(([, commit]) => commit === sha).map(([tag]) => tag);
    if (named.length === 0) problems.push(`${file}@${sha} is not the commit of a vX.Y.Z tag`);
    else if (!named.includes(comment)) {
      problems.push(`${file}@${sha} says ${comment ?? "nothing"}, but it is ${named.join(", ")}`);
    }
  }
  return problems;
}

function main() {
  const tags = releaseTags(".");
  if (!tags || tags.size === 0) {
    console.log("::error::No vX.Y.Z tags in this checkout. Fetch them first: git fetch --tags");
    process.exitCode = 1;
    return;
  }
  const template = readFileSync("templates/ward.yml", "utf8");
  const pins = [...template.matchAll(WARD_PINS)].length;
  const problems = pinProblems(template, tags);
  if (pins !== 2)
    problems.push(`templates/ward.yml has ${pins} Ward pins, expected codeql and automerge`);
  for (const problem of problems) console.log(`::error file=templates/ward.yml::${problem}`);
  if (problems.length > 0) process.exitCode = 1;
  else
    console.log(`templates/ward.yml: both Ward pins sit on release tags (${tags.size} tags read).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
