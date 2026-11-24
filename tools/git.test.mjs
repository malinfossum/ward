import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { git, LOCAL_ENV } from "./git.mjs";

// An older git lists fewer, so the check is that none git lists is missed.
test("git drops every variable git calls local to a repo, but the config ones", () => {
  const listed = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const names = listed.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(names.includes("GIT_DIR"), "git lists GIT_DIR");
  const config = (name) => name.startsWith("GIT_CONFIG");
  assert.deepEqual(
    names.filter((name) => !config(name) && !LOCAL_ENV.includes(name)),
    [],
  );
  assert.deepEqual(LOCAL_ENV.filter(config), []);
});

// A scratch folder with a repo in outer/ and a plain folder in plain/. The
// ceiling keeps git from finding a repo above it (a tmpdir inside one).
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "ward-git-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const outer = join(dir, "outer");
  const plain = join(dir, "plain");
  mkdirSync(outer);
  mkdirSync(plain);
  const ceiling = { GIT_CEILING_DIRECTORIES: dir };
  assert.equal(git(outer, ["init", "-q"]).status, 0);
  return { outer, plain, ceiling };
}

// Runs fn with these variables set in process.env, then puts them back.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, vars);
    fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("git reads the folder it is given, whatever GIT_DIR and GIT_WORK_TREE a hook exported", () => {
  const { outer, plain, ceiling } = scratch();
  const hook = { ...ceiling, GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: plain };
  withEnv(hook, () => {
    // Unscrubbed, git would take plain for outer's work tree.
    const raw = spawnSync("git", ["-C", plain, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    });
    assert.equal(raw.stdout.trim(), "true", "the hook's GIT_DIR wins over -C");
    assert.notEqual(git(plain, ["rev-parse", "--git-dir"]).status, 0, "not a repository");
    assert.equal(git(outer, ["rev-parse", "--is-inside-work-tree"]).stdout.trim(), "true");
  });
});

test("git scrubs an env the caller passes and keeps the rest of it", () => {
  const { outer, plain, ceiling } = scratch();
  const env = { ...process.env, ...ceiling, GIT_DIR: join(outer, ".git") };
  assert.notEqual(git(plain, ["rev-parse", "--git-dir"], { env }).status, 0, "not a repository");
  // Config set through the env still arrives.
  const extra = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "ward.probe", GIT_CONFIG_VALUE_0: "on" };
  const config = git(plain, ["config", "--get", "ward.probe"], { env: { ...env, ...extra } });
  assert.equal(config.stdout.trim(), "on");
});
