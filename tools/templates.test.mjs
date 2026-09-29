import assert from "node:assert/strict";
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
  const patterns = [...block.matchAll(/- "([^"]+)"/g)].map((m) => m[1].replace("*", "Sample"));
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

test("only GitHub's own actions are grouped", () => {
  const block = read("templates/dependabot.yml")
    .split("actions-first-party:")[1]
    .split("update-types")[0];
  const patterns = [...block.matchAll(/- "([^"]+)"/g)].map((m) => m[1].replace("*", "sample"));
  assert.ok(patterns.length >= 3);
  for (const name of patterns) {
    assert.match(name, FIRST_PARTY_ACTIONS, `${name} is not a first-party action`);
  }
});

test("the caller template uses ci.yml@v1, a SHA-pinned auto-merge and a weekly run", () => {
  const caller = read("templates/ward.yml");
  assert.match(caller, /malinfossum\/ward\/\.github\/workflows\/ci\.yml@v1/);
  assert.match(caller, /dependabot-automerge\.yml@[0-9a-f]{40} # v\d/);
  assert.match(caller, /^\s{2}schedule:/m);
  assert.match(caller, /^\s{2}workflow_dispatch:/m);
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
