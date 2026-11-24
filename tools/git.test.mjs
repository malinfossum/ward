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
  const dir = mkdtempSync(join(tmpdir(), "ward-git-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const outer = join(dir, "outer");
  const plain = join(dir, "plain");
  mkdirSync(outer);
  mkdirSync(plain);
  assert.equal(git(outer, ["init", "-q"]).status, 0);
  withEnv({ GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: plain }, () => {
    assert.notEqual(git(plain, ["rev-parse", "--git-dir"]).status, 0, "not a repository");
    assert.equal(git(outer, ["rev-parse", "--is-inside-work-tree"]).stdout.trim(), "true");
    // PATH and the rest still reach git.
    assert.equal(git(plain, ["--version"]).status, 0);
  });
});

test("git scrubs an env the caller passes and keeps the rest of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ward-git-env-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_DIR: join(dir, "nowhere") };
  const config = git(dir, ["config", "--get", "ward.probe"], {
    env: {
      ...env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "ward.probe",
      GIT_CONFIG_VALUE_0: "on",
    },
  });
  // GIT_DIR is gone, so dir reads as no repo, and config from the env still arrives.
  assert.equal(config.stdout.trim(), "on");
  assert.notEqual(git(dir, ["rev-parse", "--git-dir"], { env }).status, 0);
});
