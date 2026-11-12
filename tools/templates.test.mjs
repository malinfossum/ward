import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIRST_PARTY_ACTIONS, RUNTIME_BOUND } from "./automerge.mjs";

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

// Dependabot moves a Ward pin from tag to tag only when the pin sits on a
// release tag's commit. On any other commit it tracks main and keeps a stale
// comment, and a commit off a side branch can run older code than the comment
// says. The template cannot name the release it ships in, so it pins the newest
// release that exists; apply.mjs repins a new caller to the release it runs
// from. GitHub's tags are the ones Dependabot sees, so this asks GitHub.
const WARD_PINS =
  /malinfossum\/ward\/\.github\/workflows\/([\w.-]+\.yml)@([0-9a-f]{40})(?: # (\S+))?/g;

function releaseTags() {
  const remote = spawnSync(
    "git",
    ["ls-remote", "--tags", "https://github.com/malinfossum/ward.git", "refs/tags/v*"],
    { encoding: "utf8" },
  );
  assert.equal(remote.status, 0, `cannot list Ward's tags on GitHub: ${remote.stderr}`);
  const tags = new Map();
  for (const line of remote.stdout.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{40})\trefs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/);
    // An annotated tag's peeled line names its commit; a lightweight tag has only the one.
    if (m && (m[3] || !tags.has(m[2]))) tags.set(m[2], m[1]);
  }
  return tags;
}

function pinProblems(text, tags) {
  const problems = [];
  for (const [, file, sha, comment] of text.matchAll(WARD_PINS)) {
    const named = [...tags].filter(([, commit]) => commit === sha).map(([tag]) => tag);
    if (named.length === 0) problems.push(`${file}@${sha} is not the commit of a vX.Y.Z tag`);
    else if (!named.includes(comment)) {
      problems.push(`${file}@${sha} says ${comment ?? "nothing"}, but it is ${named.join(", ")}`);
    }
  }
  return problems;
}

test("the caller template pins Ward's workflows to release tag commits, named in the comment", () => {
  const tags = releaseTags();
  assert.ok(tags.size >= 10, "GitHub lists Ward's release tags");
  const caller = read("templates/ward.yml");
  assert.equal([...caller.matchAll(WARD_PINS)].length, 2, "codeql and automerge are pinned");
  assert.deepEqual(pinProblems(caller, tags), []);

  // The pins v1.8.0 shipped with: the last commits that touched each file, not the tag commit.
  const shipped = [
    "codeql.yml@54ff16b186a09873e0aee94affdb4cb1ecb6c509 # v1.8.0",
    "dependabot-automerge.yml@87f6b9c2b6c9143db3746ed1907ed9b1343bda1d # v1.8.0",
    `codeql.yml@${tags.get("v1.7.1")} # v1.8.0`,
  ].map((pin) => `    uses: malinfossum/ward/.github/workflows/${pin}`);
  assert.equal(pinProblems(shipped.join("\n"), tags).length, 3);
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

test("every Dependabot block waits 21 days before a major", () => {
  const blocks = ecosystemBlocks();
  assert.ok(blocks.length >= 6);
  for (const { ecosystem, block } of blocks) {
    assert.match(block, /^ {4}cooldown:\r?\n {6}semver-major-days: 21\r?$/m, ecosystem);
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
