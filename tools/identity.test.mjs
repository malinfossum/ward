import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitProblems,
  DEPENDABOT,
  GITHUB_WEB,
  parseAllowed,
  parseLog,
  prTextProblems,
  redact,
  textProblems,
} from "./identity.mjs";

const ME = "malinfossum.dev@proton.me";
const policy = { allowed: [ME], allowHumanCoauthors: false };
const commit = (over = {}) => ({
  sha: "abc1234",
  author: ME,
  committer: ME,
  subject: "Fix",
  body: "Fix\n",
  ...over,
});

test("parseLog splits records and fields", () => {
  const raw = `a1\x1f${ME}\x1f${GITHUB_WEB}\x1fFirst\x1fFirst\n\nbody\n\x1e\nb2\x1f${DEPENDABOT}\x1f${GITHUB_WEB}\x1fBump x\x1fBump x\n\x1e\n`;
  const commits = parseLog(raw);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    sha: "a1",
    author: ME,
    committer: GITHUB_WEB,
    subject: "First",
    body: "First\n\nbody\n",
  });
  assert.equal(commits[1].author, DEPENDABOT);
});

test("parseAllowed splits on commas and newlines and lowercases", () => {
  assert.deepEqual(parseAllowed("A@x.no, b@y.no\nc@z.no"), ["a@x.no", "b@y.no", "c@z.no"]);
  assert.deepEqual(parseAllowed(""), []);
});

test("my own commit passes", () => {
  assert.deepEqual(commitProblems(commit(), policy), []);
});

test("address case does not matter", () => {
  assert.deepEqual(commitProblems(commit({ author: "MalinFossum.Dev@proton.me" }), policy), []);
});

test("a commit merged in the web UI passes", () => {
  assert.deepEqual(commitProblems(commit({ committer: GITHUB_WEB }), policy), []);
});

test("a Dependabot commit passes", () => {
  const c = commit({ author: DEPENDABOT, committer: GITHUB_WEB });
  assert.deepEqual(commitProblems(c, policy), []);
});

test("a commit by anyone else fails, with the address redacted", () => {
  const problems = commitProblems(commit({ author: "noreply@anthropic.com" }), policy);
  assert.deepEqual(problems, ["authored by <n…@anthropic.com>"]);
});

test("redact keeps the first character and the domain", () => {
  assert.equal(redact("m.fossum@proton.me"), "m…@proton.me");
  assert.deepEqual(textProblems("Co-authored-by: Kim <kim@example.com>\n", policy), [
    "co-author line: Co-authored-by: Kim <k…@example.com>",
  ]);
});

test("the Claude Code footer fails", () => {
  const body = "Fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n";
  assert.equal(commitProblems(commit({ body }), policy).length, 1);
});

test("a Claude-Session trailer fails", () => {
  assert.equal(textProblems("Fix\n\nClaude-Session: abc\n", policy).length, 1);
});

test("plain prose about generating passes", () => {
  assert.deepEqual(textProblems("Icons generated with a script\n", policy), []);
});

test("a footer quoted inside a line passes", () => {
  const text = "Blocks lines like Generated with Claude Code\n- Generated with Copilot upstream\n";
  assert.deepEqual(textProblems(text, policy), []);
});

test("a human co-author is blocked by default", () => {
  assert.equal(textProblems("Fix\n\nCo-authored-by: Kim <kim@example.com>\n", policy).length, 1);
});

test("a human co-author passes when the repo allows it", () => {
  const joint = { ...policy, allowHumanCoauthors: true };
  assert.deepEqual(textProblems("Fix\n\nCo-authored-by: Kim <kim@example.com>\n", joint), []);
});

test("an AI co-author fails even when human co-authors are allowed", () => {
  const joint = { ...policy, allowHumanCoauthors: true };
  const line = "Co-Authored-By: Claude <noreply@anthropic.com>";
  assert.equal(textProblems(`Fix\n\n${line}\n`, joint).length, 1);
});

test("a squash merge's co-author line for me or Dependabot passes", () => {
  const mine = `Co-authored-by: Malin <${ME}>`;
  const bot = `Co-authored-by: dependabot[bot] <${DEPENDABOT}>`;
  assert.deepEqual(textProblems(`Bump x\n\n${mine}\n${bot}\n`, policy), []);
});

test("a Dependabot PR's title and body are not checked", () => {
  const pr = { title: "Bump x", body: "Release notes\n\nGenerated with Copilot\n" };
  assert.deepEqual(prTextProblems({ ...pr, author: "dependabot[bot]" }, policy), []);
  assert.equal(prTextProblems({ ...pr, author: "malinfossum" }, policy).length, 1);
});
