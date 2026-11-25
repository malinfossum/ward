import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { git } from "./git.mjs";
import { lintCheck, planSteps, rewritten, trackedChanges } from "./node-contract.mjs";

// The ceiling keeps git from finding a repo above the temp folder. Each test
// file runs in a process of its own, so this reaches no other file.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

// A temp repo with the given files committed.
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "ward-contract-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  run(dir, "init", "--quiet");
  run(dir, "add", ".");
  commit(dir);
  return dir;
}

const run = (dir, ...args) => assert.equal(git(dir, args).status, 0, args.join(" "));
const commit = (dir) =>
  run(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", "T");

test("trackedChanges lists changed and deleted tracked files from the top, never untracked ones", (t) => {
  const dir = repo({ "a.js": "a\n", "web/b.js": "b\n", "web/c.js": "c\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual([...trackedChanges(join(dir, "web")).files.keys()], []);
  writeFileSync(join(dir, "web/b.js"), "B\n");
  unlinkSync(join(dir, "web/c.js"));
  writeFileSync(join(dir, "web/.eslintcache"), "{}");
  const { files } = trackedChanges(join(dir, "web"));
  assert.deepEqual([...files.keys()].sort(), ["web/b.js", "web/c.js"]);
  assert.match(files.get("web/b.js"), /^[0-9a-f]{64}$/);
  assert.equal(files.get("web/c.js"), null);
});

test("trackedChanges keeps paths from the top when the repo sets diff.relative", (t) => {
  const dir = repo({ "a.js": "a\n", "web/b.js": "b\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  run(dir, "config", "diff.relative", "true");
  writeFileSync(join(dir, "a.js"), "A\n");
  writeFileSync(join(dir, "web/b.js"), "B\n");
  const { files } = trackedChanges(join(dir, "web"));
  assert.deepEqual([...files.keys()].sort(), ["a.js", "web/b.js"]);
  assert.ok([...files.values()].every((hash) => hash !== null));
});

test("trackedChanges outside a work tree gives git's reason instead", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ward-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { files, reason } = trackedChanges(dir);
  assert.equal(files, undefined);
  assert.match(reason, /not a git repository/);
});

test("lintCheck fails a fix that lint leaves, stages or commits, and passes a clean lint", (t) => {
  const dir = repo({ "a.js": "a\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const around = (lint) => {
    const before = trackedChanges(dir);
    lint();
    return lintCheck(before, trackedChanges(dir));
  };
  assert.deepEqual(
    around(() => writeFileSync(join(dir, ".eslintcache"), "{}")),
    {},
  );
  const left = around(() => writeFileSync(join(dir, "a.js"), "A\n"));
  assert.match(left.error, /^npm run lint changed tracked files: a\.js\. A lint that fixes/);
  const staged = around(() => {
    writeFileSync(join(dir, "a.js"), "AA\n");
    run(dir, "add", "a.js");
  });
  assert.match(staged.error, /changed tracked files: a\.js\./);
  const committed = around(() => commit(dir));
  assert.match(committed.error, /^npm run lint made a commit \([0-9a-f]{12}\)\./);
});

test("lintCheck turns git's reason into a notice, never an error", () => {
  const result = lintCheck({ reason: "fatal: not a git repository" }, { reason: "x" });
  assert.deepEqual(Object.keys(result), ["notice"]);
  assert.match(result.notice, /^git cannot read a work tree here \(fatal: not a git repository\)/);
});

test("rewritten counts a file changed before lint only when lint changes it again", () => {
  const before = new Map([
    ["kept.js", "1"],
    ["again.js", "1"],
    ["restored.js", "1"],
  ]);
  const after = new Map([
    ["kept.js", "1"],
    ["again.js", "2"],
    ["new.js", "1"],
    ["gone.js", null],
  ]);
  assert.deepEqual(rewritten(before, after), ["again.js", "gone.js", "new.js", "restored.js"]);
});

const base = {
  scripts: { lint: "x", test: "x" },
  files: ["package.json"],
  a11y: "off",
  hasPlaywright: false,
};
const names = (plan) => plan.steps.map((s) => s.name);

test("plain JS runs lint and test", () => {
  const plan = planSteps(base);
  assert.deepEqual(names(plan), ["lint", "test"]);
  assert.deepEqual(plan.missing, []);
});

test("a missing test script is reported", () => {
  const plan = planSteps({ ...base, scripts: { lint: "x" } });
  assert.deepEqual(plan.missing, ["test"]);
});

test("tsconfig.json requires typecheck", () => {
  const plan = planSteps({ ...base, files: ["package.json", "tsconfig.json"] });
  assert.deepEqual(plan.missing, ["typecheck"]);
});

test("an Astro config requires typecheck", () => {
  const plan = planSteps({ ...base, files: ["astro.config.mjs"] });
  assert.deepEqual(plan.missing, ["typecheck"]);
});

test("a wrangler config requires deploy:check", () => {
  const plan = planSteps({ ...base, files: ["wrangler.jsonc"] });
  assert.deepEqual(plan.missing, ["deploy:check"]);
});

test("steps run in contract order, with one browser install", () => {
  const scripts = {
    "test:a11y": "x",
    "test:e2e": "x",
    "deploy:check": "x",
    build: "x",
    test: "x",
    typecheck: "x",
    lint: "x",
  };
  const plan = planSteps({ ...base, scripts, a11y: "strict", hasPlaywright: true });
  assert.deepEqual(names(plan), [
    "lint",
    "typecheck",
    "test",
    "build",
    "deploy:check",
    "playwright browsers",
    "test:e2e",
    "test:a11y",
  ]);
});

test("test:e2e runs whenever it exists and never goes soft", () => {
  for (const a11y of ["off", "warn"]) {
    const plan = planSteps({ ...base, scripts: { ...base.scripts, "test:e2e": "x" }, a11y });
    const e2e = plan.steps.find((s) => s.name === "test:e2e");
    assert.equal(e2e?.soft, false, a11y);
  }
});

test("a11y off skips test:a11y even when it exists", () => {
  const plan = planSteps({ ...base, scripts: { ...base.scripts, "test:a11y": "x" } });
  assert.deepEqual(names(plan), ["lint", "test"]);
});

test("a11y warn makes test:a11y soft", () => {
  const plan = planSteps({ ...base, scripts: { ...base.scripts, "test:a11y": "x" }, a11y: "warn" });
  const a11y = plan.steps.find((s) => s.name === "test:a11y");
  assert.equal(a11y.soft, true);
});

test("a11y strict without test:a11y is reported", () => {
  assert.deepEqual(planSteps({ ...base, a11y: "strict" }).missing, ["test:a11y"]);
});

test("an unknown a11y mode throws", () => {
  assert.throws(() => planSteps({ ...base, a11y: "loud" }), /off, warn or strict/);
});
