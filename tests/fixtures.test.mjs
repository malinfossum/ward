import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { git, scrubbed } from "../tools/git.mjs";

const ME = "malinfossum.dev@proton.me";

// `npm run test:fixtures` runs under `node --test`, which sets
// NODE_TEST_CONTEXT in this process's environment. A fixture command that
// itself runs `node --test` (node-ok's own test script, run through
// node-contract.mjs) would inherit that variable and see a test run already
// in progress, skip its test files, and exit 0. That would make "node-ok
// passes" vacuous, so it is stripped and a nested `node --test` actually runs.
// A GIT_DIR a hook exported would point identity.mjs at the hook's repo, so
// git's repo-local variables go too.
function fixtureEnv(env) {
  const merged = scrubbed({ ...process.env, ...env });
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
    const setup = (...args) => {
      const result = git(dir, args);
      assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    };
    setup("init", "--quiet");
    const author = ["-c", "user.name=Fixture", "-c", `user.email=${email}`];
    setup(...author, "commit", "--quiet", "--allow-empty", "-m", message);
    const env = { ALLOWED: ME, BASE: "", HEAD: "HEAD", PR_AUTHOR: "", PR_TITLE: "", PR_BODY: "" };
    return run("identity.mjs", [], { cwd: dir, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A fixture copied out of Ward and run through the node contract, in a git
// repo of its own with the fixture committed, or (repo: false) in no repo.
// Run in place, a fixture that rewrites files would dirty Ward's own tree,
// and the lint check would see any Ward file saved while the lint runs.
// The ceiling keeps git from finding a repo above the temp folder.
function copied(fixture, { repo = true, env: extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ward-node-"));
  try {
    cpSync(join("fixtures", fixture), dir, { recursive: true });
    const env = { ...extra, GIT_CEILING_DIRECTORIES: dirname(dir) };
    if (repo) {
      const setup = (...args) => {
        const result = git(dir, args, { env: fixtureEnv(env) });
        assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
      };
      setup("init", "--quiet");
      setup("add", ".");
      const author = ["-c", "user.name=Fixture", "-c", `user.email=${ME}`];
      setup(...author, "commit", "--quiet", "-m", "Fixture");
    }
    const result = run("node-contract.mjs", [dir], { env });
    return { ...result, ran: existsSync(join(dir, ".lintcache")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("node-lint-fix passes outside a git repo, with a notice that the lint check was skipped", () => {
  const { status, out, ran } = copied("node-lint-fix", { repo: false });
  assert.equal(status, 0, out);
  assert.ok(ran, "the lint ran in the copy");
  assert.match(
    out,
    /::notice::git cannot read a work tree here \(fatal: not a git repository/,
    out,
  );
  assert.equal(
    readFileSync("fixtures/node-lint-fix/src.js", "utf8"),
    'export const greeting = "hi";\n',
    "Ward's own copy stays untouched",
  );
  assert.ok(!existsSync("fixtures/node-lint-fix/.lintcache"));
});

test("identity passes my own commit", () => {
  const { status, out } = identity(ME, "Fix");
  assert.equal(status, 0, out);
});

test("node-ok passes the contract", () => {
  const { status, out } = copied("node-ok");
  assert.equal(status, 0, out);
  assert.doesNotMatch(out, /::notice::git cannot read/, out);
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

const EF = { EF_PROJECT: "fixtures/dotnet-ef/src/Fixture.Data" };

test("dotnet-ef passes with a tool manifest and an EF path from the repo root", () => {
  const { status, out } = run("dotnet-check.mjs", ["fixtures/dotnet-ef"], { env: EF });
  assert.equal(status, 0, out);
  assert.match(out, /::group::tool restore/, out);
  assert.match(out, /::group::pending migrations/, out);
});

test("dotnet-ok runs no tool restore when there is no manifest", () => {
  const { out } = run("dotnet-check.mjs", ["fixtures/dotnet-ok"]);
  assert.doesNotMatch(out, /tool restore/, out);
});

test("powershell-ok passes under Pester 5", () => {
  const { status, out } = run("powershell-check.mjs", ["fixtures/powershell-ok"]);
  assert.equal(status, 0, out);
  assert.match(out, /fixture passes/, out);
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
      run: () => copied("node-broken"),
      expect: /no "test" script[\s\S]*::error::lint failed/,
    },
    {
      name: "node-ok in strict a11y mode without test:a11y",
      run: () => copied("node-ok", { env: { A11Y: "strict" } }),
      expect: /no "test:a11y" script/,
    },
    {
      name: "node-lint-fix: a lint that passes only because it rewrites a tracked file",
      run: () => copied("node-lint-fix"),
      expect: /::error::npm run lint changed tracked files: src\.js\. A lint that fixes/,
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
    {
      name: "dotnet-ef: a model change without a migration",
      run: () =>
        run("dotnet-check.mjs", ["fixtures/dotnet-ef"], { env: { ...EF, FIXTURE_PENDING: "1" } }),
      expect: /::error::pending migrations failed/,
    },
  ],
  powershell: [
    {
      name: "powershell-broken: a failing test",
      run: () => run("powershell-check.mjs", ["fixtures/powershell-broken"]),
      expect: /::error::Pester failed: 1 of 2 tests/,
    },
    {
      name: "powershell-notests: scripts without a test file",
      run: () => run("powershell-check.mjs", ["fixtures/powershell-notests"]),
      expect: /::error::No Pester tests found/,
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
