import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide,
  isReleaseTag,
  requiredChecksFrom,
  rulesOrNone,
  wardTargets,
} from "./automerge.mjs";
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

test("a .NET container image without a registry prefix also waits for me", () => {
  for (const name of ["dotnet/aspnet", "dotnet/sdk"]) {
    const result = decide({ ...ok, dependencies: ["vitest", name] });
    assert.equal(result.merge, false, name);
    assert.match(result.reason, /runtime-bound/);
    assert.match(result.reason, new RegExp(name.replace("/", "\\/")));
  }
});

test("an unrelated container image merges", () => {
  for (const name of ["node", "library/nginx"]) {
    assert.equal(decide({ ...ok, dependencies: ["vitest", name] }).merge, true, name);
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

const WARD_AUTOMERGE = "malinfossum/ward/.github/workflows/dependabot-automerge.yml";
const WARD_CODEQL = "malinfossum/ward/.github/workflows/codeql.yml";
const RELEASE = "bf47ebacef790cd4847856c10f63b0d3601f1c22";
const MAIN_ONLY = "84a8785a7875f38855a93ad4747133fd9dcd75a6";
const wardBump = {
  ...ok,
  ecosystem: "github_actions",
  // fetch-metadata reads a SHA-to-SHA bump as a major, so Ward ignores it.
  updateType: "version-update:semver-major",
  dependencyType: "direct:production",
  dependencies: [WARD_AUTOMERGE, WARD_CODEQL],
  wardPins: [{ sha: RELEASE, release: "v1.7.1", onMain: true }],
};

test("a Ward bump to a release tag on main merges", () => {
  const result = decide(wardBump);
  assert.equal(result.merge, true);
  assert.match(result.reason, /Ward release v1\.7\.1/);
});

test("a Ward bump to an untagged commit waits for me", () => {
  const result = decide({
    ...wardBump,
    wardPins: [
      { sha: RELEASE, release: "v1.7.1", onMain: true },
      { sha: MAIN_ONLY, release: null, onMain: true },
    ],
  });
  assert.equal(result.merge, false);
  assert.match(result.reason, /84a8785 is not a Ward release/);
});

test("a Ward bump to a release tag that is not on main waits for me", () => {
  const result = decide({
    ...wardBump,
    wardPins: [{ sha: RELEASE, release: "v1.7.1", onMain: false }],
  });
  assert.equal(result.merge, false);
  assert.match(result.reason, /not on Ward's main/);
});

test("a Ward bump with no Ward pin in the diff waits for me", () => {
  const result = decide({ ...wardBump, wardPins: [] });
  assert.equal(result.merge, false);
  assert.match(result.reason, /no Ward pin/);
});

test("a Ward bump still needs the gate and Dependabot's own commits", () => {
  assert.equal(decide({ ...wardBump, requiredChecks: [] }).merge, false);
  assert.equal(decide({ ...wardBump, authors: [DEPENDABOT, "someone@example.com"] }).merge, false);
});

test("a Ward bump mixed with another dependency waits for me", () => {
  const result = decide({ ...wardBump, dependencies: [WARD_CODEQL, "actions/checkout"] });
  assert.equal(result.merge, false);
  assert.match(result.reason, /own PR/);
});

test("isReleaseTag takes vX.Y.Z only", () => {
  for (const name of ["v1.7.1", "v2.0.0", "v10.20.30"])
    assert.equal(isReleaseTag(name), true, name);
  for (const name of ["v1", "v1.7", "1.7.1", "v1.7.1-rc.1", "v1.7.1x", "release"]) {
    assert.equal(isReleaseTag(name), false, name);
  }
});

test("wardTargets reads the Ward SHAs a diff adds, not the ones it removes", () => {
  const diff = [
    "diff --git a/.github/workflows/ward.yml b/.github/workflows/ward.yml",
    `-    uses: ${WARD_CODEQL}@268e66a338df8b4b7f0b929e62243dfda07c8acb # v1.4.0`,
    `+    uses: ${WARD_CODEQL}@${MAIN_ONLY} # v1.4.0`,
    `-    uses: ${WARD_AUTOMERGE}@2e968236b033d738a637386491921ff39d071445 # v1.6.0`,
    `+    uses: ${WARD_AUTOMERGE}@${RELEASE} # v1.7.1`,
    "+    uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    `+      - uses: "${WARD_CODEQL}@${RELEASE}"`,
  ].join("\n");
  assert.deepEqual(wardTargets(diff), [MAIN_ONLY, RELEASE]);
});

test("a look-alike of Ward never auto-merges", () => {
  const result = decide({
    ...ok,
    ecosystem: "github_actions",
    dependencies: ["malinfossum/ward-tools"],
  });
  assert.equal(result.merge, false);
  assert.match(result.reason, /look-alike of Ward/);
});

test("a major of a development dependency merges", () => {
  const result = decide({
    ...ok,
    updateType: "version-update:semver-major",
    dependencyType: "direct:development",
    dependencies: ["jsdom"],
  });
  assert.equal(result.merge, true);
  assert.match(result.reason, /development/);
});

test("a major of a production or indirect dependency waits for me", () => {
  for (const dependencyType of ["direct:production", "indirect", "", undefined]) {
    const result = decide({
      ...ok,
      updateType: "version-update:semver-major",
      dependencyType,
      dependencies: ["react"],
    });
    assert.equal(result.merge, false, String(dependencyType));
    assert.match(result.reason, /semver-major/);
  }
});

test("a development major of a runtime-bound .NET package still waits for me", () => {
  const result = decide({
    ...ok,
    ecosystem: "nuget",
    updateType: "version-update:semver-major",
    dependencyType: "direct:development",
    dependencies: ["Microsoft.EntityFrameworkCore.Design"],
  });
  assert.equal(result.merge, false);
  assert.match(result.reason, /runtime-bound/);
});

test("a development major of a third-party action still waits for me", () => {
  const result = decide({
    ...ok,
    ecosystem: "github_actions",
    updateType: "version-update:semver-major",
    dependencyType: "direct:development",
    dependencies: ["hadolint/hadolint-action"],
  });
  assert.equal(result.merge, false);
  assert.match(result.reason, /third-party action/);
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

test("a missing ecosystem never auto-merges", () => {
  const result = decide({ ...ok, ecosystem: "", dependencies: ["hadolint/hadolint-action"] });
  assert.equal(result.merge, false);
  assert.match(result.reason, /missing Dependabot metadata/);
});

test("missing dependencies never auto-merges", () => {
  const result = decide({ ...ok, ecosystem: "nuget", dependencies: [] });
  assert.equal(result.merge, false);
  assert.match(result.reason, /missing Dependabot metadata/);
});

test("no authors at all never auto-merges", () => {
  const result = decide({ ...ok, authors: [] });
  assert.equal(result.merge, false);
  assert.match(result.reason, /someone other than Dependabot/);
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

test("rulesOrNone: no rules where GitHub Free refuses them on a private repo", () => {
  const refused = Object.assign(
    new Error("Command failed: gh api repos/me/private/rules/branches/main"),
    {
      stderr:
        "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n",
    },
  );
  assert.deepEqual(
    rulesOrNone(() => {
      throw refused;
    }),
    [],
  );
  assert.deepEqual(decide({ ...ok, requiredChecks: requiredChecksFrom([]) }).merge, false);
});

test("rulesOrNone: any other failure still throws", () => {
  const down = Object.assign(
    new Error("Command failed: gh api repos/me/repo/rules/branches/main"),
    {
      stderr: "gh: Server Error (HTTP 502)\n",
    },
  );
  assert.throws(
    () =>
      rulesOrNone(() => {
        throw down;
      }),
    /Command failed/,
  );
  assert.deepEqual(
    rulesOrNone(() => [{ type: "deletion" }]),
    [{ type: "deletion" }],
  );
});
