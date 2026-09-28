import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ME = "malinfossum.dev@proton.me";

// `npm run test:fixtures` runs under `node --test`, which sets
// NODE_TEST_CONTEXT in this process's environment. A fixture command that
// itself runs `node --test` (node-ok's own test script, run through
// node-contract.mjs) would inherit that variable and see a test run already
// in progress, skip its test files, and exit 0 — making "node-ok passes"
// vacuous. Strip it so a nested `node --test` actually runs.
function fixtureEnv(env) {
  const merged = { ...process.env, ...env };
  delete merged.NODE_TEST_CONTEXT;
  return merged;
}

function run(script, args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [resolve("tools", script), ...args], {
    cwd,
    encoding: "utf8",
    env: fixtureEnv(env),
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

// A throwaway git repo with one commit, run through the identity CLI.
function identity(email, message) {
  const dir = mkdtempSync(join(tmpdir(), "ward-identity-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir });
    git("init", "--quiet");
    const author = ["-c", "user.name=Fixture", "-c", `user.email=${email}`];
    git(...author, "commit", "--quiet", "--allow-empty", "-m", message);
    const env = { ALLOWED: ME, BASE: "", HEAD: "HEAD", PR_AUTHOR: "", PR_TITLE: "", PR_BODY: "" };
    return run("identity.mjs", [], { cwd: dir, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("identity passes my own commit", () => {
  const { status, out } = identity(ME, "Fix");
  assert.equal(status, 0, out);
});

test("node-ok passes the contract", () => {
  const { status, out } = run("node-contract.mjs", ["fixtures/node-ok"]);
  assert.equal(status, 0, out);
  // Guards against NODE_TEST_CONTEXT leaking into the nested `npm test`: if
  // it leaked, node-ok's own `node --test` would skip its files and exit 0
  // without ever running "fixture passes", and this assertion would fail.
  assert.match(out, /fixture passes/, out);
});

test("dotnet-ok passes", () => {
  const { status, out } = run("dotnet-check.mjs", ["fixtures/dotnet-ok"]);
  assert.equal(status, 0, out);
});

test("dotnet-pick passes when given its solution file", () => {
  const { status, out } = run("dotnet-check.mjs", ["fixtures/dotnet-pick/Pick.slnx"]);
  assert.equal(status, 0, out);
});

// Every module in ci.yml needs a fixture it rejects: a check that never fails
// is untested. A new module adds its cases here.
const REJECTS = {
  identity: [
    {
      name: "a foreign author with a co-author trailer",
      run: () =>
        identity("someone@example.com", "Fix\n\nCo-authored-by: Someone <someone@example.com>"),
      expect: /authored by <s…@example\.com>[\s\S]*co-author line/,
    },
  ],
  node: [
    {
      name: "node-broken: a missing test script and a failing lint",
      run: () => run("node-contract.mjs", ["fixtures/node-broken"]),
      expect: /no "test" script[\s\S]*::error::lint failed/,
    },
    {
      name: "node-ok in strict a11y mode without test:a11y",
      run: () => run("node-contract.mjs", ["fixtures/node-ok"], { env: { A11Y: "strict" } }),
      expect: /no "test:a11y" script/,
    },
  ],
  dotnet: [
    {
      name: "dotnet-broken: a warning fails the build",
      run: () => run("dotnet-check.mjs", ["fixtures/dotnet-broken"]),
      expect: /::error::build failed/,
    },
    {
      name: "dotnet-notests: no test project",
      run: () => run("dotnet-check.mjs", ["fixtures/dotnet-notests"]),
      expect: /No test project found/,
    },
  ],
};

for (const [module, cases] of Object.entries(REJECTS)) {
  for (const c of cases) {
    test(`${module} rejects ${c.name}`, () => {
      const { status, out } = c.run();
      assert.equal(status, 1, out);
      assert.match(out, c.expect);
    });
  }
}

test("every module in ci.yml has a fixture it rejects", () => {
  const jobs = readFileSync(".github/workflows/ci.yml", "utf8").split(/^jobs:$/m)[1];
  const modules = [...jobs.matchAll(/^ {2}([a-z][\w-]*):$/gm)]
    .map((m) => m[1])
    .filter((job) => job !== "gate");
  assert.deepEqual(modules.sort(), Object.keys(REJECTS).sort());
  for (const [module, cases] of Object.entries(REJECTS)) {
    assert.ok(cases.length > 0, `${module} has no rejecting case`);
  }
});
