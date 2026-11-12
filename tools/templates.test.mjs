import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FIRST_PARTY_ACTIONS, RUNTIME_BOUND } from "./automerge.mjs";
import { pinProblems, releaseTags, WARD_PINS } from "./template-pins.mjs";

const read = (path) => readFileSync(path, "utf8");

test("the branch ruleset requires ward / gate without strict up-to-date", () => {
  const ruleset = JSON.parse(read("templates/ruleset.json"));
  const checks = ruleset.rules.find((r) => r.type === "required_status_checks");
  assert.deepEqual(checks.parameters.required_status_checks, [{ context: "ward / gate" }]);
  // Dependabot does not rebase a PR that is only behind, so strict mode stalls auto-merge.
  assert.equal(checks.parameters.strict_required_status_checks_policy, false);
  assert.deepEqual(ruleset.bypass_actors, []);
});

test("the tag ruleset blocks creating, moving and deleting v* tags, admin bypass only", () => {
  const ruleset = JSON.parse(read("templates/ruleset-tags.json"));
  assert.equal(ruleset.target, "tag");
  assert.deepEqual(ruleset.conditions.ref_name.include, ["refs/tags/v*"]);
  assert.deepEqual(
    ruleset.rules.map((r) => r.type),
    ["creation", "update", "deletion"],
  );
  assert.deepEqual(ruleset.bypass_actors, [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ]);
});

test("every Dependabot runtime exclusion is also refused by auto-merge", () => {
  const block = read("templates/dependabot.yml").split("dotnet-runtime:")[1];
  const patterns = [...block.matchAll(/- "([^"]+)"/g)].map((m) => m[1].replaceAll("*", "Sample"));
  assert.ok(patterns.length >= 5);
  for (const name of patterns) {
    assert.ok(
      RUNTIME_BOUND.some((p) => p.test(name)),
      `${name} would auto-merge`,
    );
  }
});

test("runtime-bound NuGet packages are grouped for minor and patch only", () => {
  const block = read("templates/dependabot.yml")
    .split("dotnet-runtime:")[1]
    .split("nuget-minor-patch:")[0];
  assert.match(block, /update-types: \[minor, patch\]/);
});

test("both Ward pins share one group, every update type", () => {
  const block = read("templates/dependabot.yml")
    .split(/^ {6}ward:\r?$/m)[1]
    .split(/^\s*- package-ecosystem/m)[0];
  assert.deepEqual(
    [...block.matchAll(/- "([^"]+)"/g)].map((m) => m[1]),
    ["malinfossum/ward*"],
  );
  assert.doesNotMatch(block, /update-types/);
});

test("only GitHub's own actions are grouped", () => {
  const block = read("templates/dependabot.yml")
    .split("actions-first-party:")[1]
    .split("update-types")[0];
  const patterns = [...block.matchAll(/- "([^"]+)"/g)].map((m) => m[1].replaceAll("*", "sample"));
  assert.ok(patterns.length >= 3);
  for (const name of patterns) {
    assert.match(name, FIRST_PARTY_ACTIONS, `${name} is not a first-party action`);
  }
});

test("the caller template uses ci.yml@v1, a SHA-pinned auto-merge and a weekly run", () => {
  const caller = read("templates/ward.yml");
  assert.match(caller, /malinfossum\/ward\/\.github\/workflows\/ci\.yml@v1/);
  assert.match(caller, /dependabot-automerge\.yml@[0-9a-f]{40} # v\d/);
  assert.doesNotMatch(caller, /@0{40}/, "auto-merge still pins the pre-release placeholder");
  assert.match(caller, /^\s{2}schedule:/m);
  assert.match(caller, /^\s{2}workflow_dispatch:/m);
});

// The live check runs in Ward's fixtures job (tools/template-pins.mjs), from the
// tags the checkout fetched, so npm test never needs the network.
const V180 = "3957164ca48d2df9b43bdebd09a788b0e78f9df6";
const V171 = "bf47ebacef790cd4847856c10f63b0d3601f1c22";
const TAGS = new Map([
  ["v1.7.1", V171],
  ["v1.8.0", V180],
]);
const pin = (rest) => `    uses: malinfossum/ward/.github/workflows/${rest}`;

test("a template pin passes only on a release tag commit named in its comment", () => {
  assert.deepEqual(pinProblems(pin(`codeql.yml@${V180} # v1.8.0`), TAGS), []);
  // The pins v1.8.0 shipped with: the last commits that touched each file, not the tag commit.
  const shipped = [
    pin("codeql.yml@54ff16b186a09873e0aee94affdb4cb1ecb6c509 # v1.8.0"),
    pin("dependabot-automerge.yml@87f6b9c2b6c9143db3746ed1907ed9b1343bda1d # v1.8.0"),
    pin(`codeql.yml@${V171} # v1.8.0`),
    pin(`codeql.yml@${V180}`),
  ];
  assert.deepEqual(pinProblems(shipped.join("\n"), TAGS), [
    "codeql.yml@54ff16b186a09873e0aee94affdb4cb1ecb6c509 is not the commit of a vX.Y.Z tag",
    "dependabot-automerge.yml@87f6b9c2b6c9143db3746ed1907ed9b1343bda1d is not the commit of a vX.Y.Z tag",
    `codeql.yml@${V171} says v1.8.0, but it is v1.7.1`,
    `codeql.yml@${V180} says nothing, but it is v1.8.0`,
  ]);
});

test("the caller template pins Ward twice, codeql and automerge", () => {
  const caller = read("templates/ward.yml");
  const files = [...caller.matchAll(WARD_PINS)].map((m) => m[1]);
  assert.deepEqual(files, ["codeql.yml", "dependabot-automerge.yml"]);
});

test("release tags resolve to commits for annotated and lightweight tags, offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "ward-tags-"));
  const git = (...args) =>
    spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
    });
  try {
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "one");
    git("tag", "-a", "v1.0.0", "-m", "annotated");
    git("tag", "v1");
    git("commit", "-q", "--allow-empty", "-m", "two");
    git("tag", "v1.1.0");
    const tags = releaseTags(dir);
    assert.deepEqual([...tags.keys()].sort(), ["v1.0.0", "v1.1.0"]);
    assert.equal(tags.get("v1.0.0"), git("rev-parse", "HEAD~1").stdout.trim());
    assert.equal(tags.get("v1.1.0"), git("rev-parse", "HEAD").stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixtures carry the template Directory.Build.props unchanged", () => {
  const template = readFileSync("templates/Directory.Build.props");
  const copies = readdirSync("fixtures")
    .map((dir) => join("fixtures", dir, "Directory.Build.props"))
    .filter((path) => existsSync(path));
  assert.ok(copies.length >= 3, "dotnet-ok, dotnet-broken and dotnet-pick each carry a copy");
  for (const path of copies) {
    assert.ok(template.equals(readFileSync(path)), `${path} has drifted from the template`);
  }
});

test("the caller template's codeql job is SHA-pinned and sits between ward and automerge", () => {
  const caller = read("templates/ward.yml");
  const jobs = caller.split(/^jobs:\r?\n/m)[1];
  assert.deepEqual(
    [...jobs.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)].map((m) => m[1]),
    ["ward", "codeql", "automerge"],
  );
  assert.match(
    caller,
    /^ {4}uses: malinfossum\/ward\/\.github\/workflows\/codeql\.yml@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m,
  );
  const block = jobs.split(/^ {2}codeql:\s*$/m)[1].split(/^ {2}automerge:/m)[0];
  for (const line of ["actions: read", "contents: read", "security-events: write"]) {
    assert.match(block, new RegExp(`^ {6}${line}$`, "m"), line);
  }
});

const ecosystemBlocks = () =>
  read("templates/dependabot.yml")
    .split(/^ {2}- package-ecosystem: /m)
    .slice(1)
    .map((block) => ({ ecosystem: block.split(/[\s#]/)[0], block }));

// Dependabot rejects the semver-*-days cooldown keys for these ecosystems
// (docs: dependabot-options-reference, "cooldown"), so the config check fails.
const noSemverCooldown = new Set(["github-actions", "docker"]);

test("every Dependabot block that can tell a major apart waits 21 days before one", () => {
  const blocks = ecosystemBlocks();
  assert.ok(blocks.length >= 6);
  for (const { ecosystem, block } of blocks) {
    if (noSemverCooldown.has(ecosystem)) {
      assert.doesNotMatch(block, /semver-(major|minor|patch)-days/, ecosystem);
    } else {
      assert.match(block, /^ {4}cooldown:\r?\n {6}semver-major-days: 21\r?$/m, ecosystem);
    }
  }
});

test(".NET majors are ignored until I move to the next runtime", () => {
  const ignores = (name) =>
    [
      ...ecosystemBlocks()
        .find((b) => b.ecosystem === name)
        .block.matchAll(
          /- dependency-name: "([^"]+)"\r?\n\s+update-types: \["version-update:semver-major"\]/g,
        ),
    ].map((m) => m[1]);
  assert.deepEqual(ignores("nuget"), ["Microsoft.*", "System.*"]);
  assert.deepEqual(ignores("dotnet-sdk"), ["*"]);
  assert.deepEqual(ignores("npm"), []);
});
