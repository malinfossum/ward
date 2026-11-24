import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { git, LOCAL_ENV } from "./git.mjs";

test("the variables git drops are the ones git itself calls local to a repo", () => {
  const listed = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual([...LOCAL_ENV].sort(), listed.stdout.split(/\r?\n/).filter(Boolean).sort());
});

test("git reads the folder it is given, whatever GIT_DIR and GIT_WORK_TREE a hook exported", () => {
  const dir = mkdtempSync(join(tmpdir(), "ward-git-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const outer = join(dir, "outer");
  const plain = join(dir, "plain");
  mkdirSync(outer);
  mkdirSync(plain);
  assert.equal(spawnSync("git", ["-C", outer, "init", "-q"]).status, 0);
  const exported = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  try {
    process.env.GIT_DIR = join(outer, ".git");
    process.env.GIT_WORK_TREE = plain;
    assert.notEqual(git(plain, ["rev-parse", "--git-dir"]).status, 0, "not a repository");
    assert.equal(git(outer, ["rev-parse", "--is-inside-work-tree"]).stdout.trim(), "true");
    // PATH and the rest still reach git.
    assert.equal(git(plain, ["--version"]).status, 0);
  } finally {
    for (const [name, value] of Object.entries(exported)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
