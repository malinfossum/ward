// Checks that the caller template pins Ward's workflows to release tag commits.
// Dependabot moves a pin from tag to tag only when the pin sits on a vX.Y.Z
// tag's commit. On any other commit it tracks main and keeps a stale comment,
// and a commit off a side branch can run older code than the comment says.
// It reads the tags of the checkout it runs in, so it makes no network call of
// its own: Ward's fixtures job checks out with every tag from GitHub, and a
// local run needs `git fetch --tags` first. A missing tag fails, never passes.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { git } from "./git.mjs";

export const WARD_PINS =
  /(?<![\w.-])malinfossum\/ward\/\.github\/workflows\/([\w.-]+\.yml)@([0-9a-f]{40})(?:[ \t]+#[ \t]*(\S+))?/g;

// Maps each vX.Y.Z tag to its commit. %(*objectname) is the commit an annotated
// tag points at; a lightweight tag leaves it empty and names the commit itself.
export function releaseTags(dir) {
  const listed = git(dir, [
    "for-each-ref",
    "--format=%(refname:lstrip=2) %(objectname) %(*objectname)",
    "refs/tags/v*",
  ]);
  if (listed.status !== 0) return null;
  const tags = new Map();
  for (const line of listed.stdout.split(/\r?\n/)) {
    const [tag, object, peeled] = line.trim().split(" ");
    if (/^v\d+\.\d+\.\d+$/.test(tag ?? "")) tags.set(tag, peeled || object);
  }
  return tags;
}

// The newest of some vX.Y.Z names, by number (v1.10.0 is newer than v1.9.1),
// or undefined when there are none.
export function newestRelease(names) {
  const version = (tag) => tag.slice(1).split(".").map(Number);
  const newer = (a, b) => {
    const [x, y] = [version(a), version(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  };
  return names.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)).sort(newer)[0];
}

// A pin passes as `@<sha> # vX.Y.Z` and nothing after it on the line, where
// the tag is the newest release on that commit, the one apply.mjs writes when
// it pins a new caller there.
export function pinProblems(text, tags) {
  const problems = [];
  for (const match of text.matchAll(WARD_PINS)) {
    const [pin, file, sha, comment] = match;
    const rest = text
      .slice(match.index + pin.length)
      .split(/\r?\n/)[0]
      .trim();
    const newest = newestRelease(
      [...tags].filter(([, commit]) => commit === sha).map(([tag]) => tag),
    );
    if (!newest) problems.push(`${file}@${sha} is not the commit of a vX.Y.Z tag`);
    else if (rest) {
      problems.push(
        `${file}@${sha} has text after ${comment ? "its version comment" : "it"}: ${rest}`,
      );
    } else if (comment !== newest) {
      problems.push(`${file}@${sha} says ${comment ?? "nothing"}, but it is ${newest}`);
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
