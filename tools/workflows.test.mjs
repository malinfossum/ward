import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const files = [
  ...readdirSync(".github/workflows").map((f) => join(".github/workflows", f)),
  "templates/ward.yml",
];

test("every action is pinned to a full SHA with a version comment", () => {
  let matched = 0;
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*-?\s*uses:\s*(\S+)(.*)$/);
      if (!match || match[1].startsWith("./")) continue;
      const [target, rest] = [match[1], match[2]];
      if (/^malinfossum\/ward\/\.github\/workflows\/ci\.yml@v\d+$/.test(target)) continue;
      matched++;
      assert.match(target, /@[0-9a-f]{40}$/, `${file}: ${target} is not SHA-pinned`);
      assert.match(rest, /#\s*v\d/, `${file}: ${target} has no version comment`);
    }
  }
  // If no `uses:` line ever matched, the loop above ran zero assertions and
  // this test would pass whether or not any action is actually pinned.
  assert.ok(matched > 0, "no uses: line was scanned across the workflow files");
});

test("no workflow uses pull_request_target", () => {
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /pull_request_target/, file);
  }
});

test("no run step interpolates inputs, event data or the head branch directly", () => {
  let scanned = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const runBlocks = text.match(/run: [|>]?[^\n]*(\n\s{10,}[^\n]*)*/g) ?? [];
    for (const block of runBlocks) {
      scanned++;
      assert.doesNotMatch(
        block,
        /\$\{\{\s*(inputs\.|github\.event\.|github\.head_ref)/,
        `${file}: ${block}`,
      );
    }
  }
  // Same vacuous-pass guard: no run: block found means nothing was checked.
  assert.ok(scanned > 0, "no run: block was scanned across the workflow files");
});

test("nothing calls the auto-merge workflow by local path", () => {
  // A ./ call runs the PR head's version of a workflow that holds write access.
  for (const file of files) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /uses:\s*\.\/\.github\/workflows\/dependabot-automerge\.yml/,
      file,
    );
  }
});

test("dependabot-automerge.yml sets a per-PR concurrency group that does not cancel in progress", () => {
  const text = readFileSync(".github/workflows/dependabot-automerge.yml", "utf8");
  const match = text.match(/^concurrency:\n((?:^ {2}.*\n?)+)/m);
  assert.ok(match, "no concurrency block found");
  assert.match(match[1], /group:.*github\.event\.pull_request\.number/);
  assert.match(match[1], /cancel-in-progress:\s*false/);
});
