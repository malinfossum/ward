import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, requiredChecksFrom } from "./automerge.mjs";
import { DEPENDABOT } from "./identity.mjs";

const ok = {
  authors: [DEPENDABOT],
  ecosystem: "npm_and_yarn",
  updateType: "version-update:semver-patch",
  dependencies: ["vitest"],
  requiredChecks: ["ward / gate"],
  requiredCheck: "ward / gate",
};

test("a patch update merges", () => {
  assert.equal(decide(ok).merge, true);
});

test("a minor update merges", () => {
  assert.equal(decide({ ...ok, updateType: "version-update:semver-minor" }).merge, true);
});

test("a major update waits for me", () => {
  const result = decide({ ...ok, updateType: "version-update:semver-major" });
  assert.equal(result.merge, false);
  assert.match(result.reason, /semver-major/);
});

test("a runtime-bound .NET package waits for me", () => {
  for (const name of [
    "Microsoft.AspNetCore.OpenApi",
    "Microsoft.EntityFrameworkCore.Design",
    "Microsoft.Extensions.Hosting",
    "Microsoft.NET.Test.Sdk",
    "Microsoft.NETCore.App.Ref",
    "System.Text.Json",
    "dotnet-sdk",
    "mcr.microsoft.com/dotnet/aspnet",
  ]) {
    const result = decide({ ...ok, dependencies: ["vitest", name] });
    assert.equal(result.merge, false, name);
    assert.match(result.reason, /runtime-bound/);
  }
});

test("the dotnet-sdk ecosystem waits for me whatever the dependency is called", () => {
  for (const ecosystem of ["dotnet-sdk", "dotnet_sdk"]) {
    const result = decide({ ...ok, ecosystem, dependencies: ["sdk"] });
    assert.equal(result.merge, false, ecosystem);
    assert.match(result.reason, /runtime-bound/);
  }
});

test("an update of GitHub's own actions merges", () => {
  const dependencies = ["actions/checkout", "github/codeql-action", "dependabot/fetch-metadata"];
  assert.equal(decide({ ...ok, ecosystem: "github-actions", dependencies }).merge, true);
});

test("a third-party action waits for me", () => {
  const dependencies = ["actions/checkout", "hadolint/hadolint-action"];
  const result = decide({ ...ok, ecosystem: "github_actions", dependencies });
  assert.equal(result.merge, false);
  assert.match(result.reason, /third-party action: hadolint\/hadolint-action/);
});

test("a bump of Ward itself never auto-merges", () => {
  const refs = ["malinfossum/ward", "malinfossum/ward/.github/workflows/dependabot-automerge.yml"];
  for (const name of refs) {
    const result = decide({ ...ok, ecosystem: "github_actions", dependencies: [name] });
    assert.equal(result.merge, false, name);
    assert.match(result.reason, /Ward itself/);
  }
});

test("a PR with a commit by someone else never auto-merges", () => {
  const result = decide({ ...ok, authors: [DEPENDABOT, "malinfossum.dev@proton.me"] });
  assert.equal(result.merge, false);
  assert.match(result.reason, /someone other than Dependabot/);
});

test("a repo without the required check never auto-merges", () => {
  const result = decide({ ...ok, requiredChecks: [] });
  assert.equal(result.merge, false);
  assert.match(result.reason, /does not require "ward \/ gate"/);
});

test("requiredChecksFrom reads status-check rules", () => {
  const rules = [
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "ward / gate" }, { context: "fixtures" }] },
    },
  ];
  assert.deepEqual(requiredChecksFrom(rules), ["ward / gate", "fixtures"]);
});
