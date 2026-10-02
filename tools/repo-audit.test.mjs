import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  auditRepo,
  canaryFindings,
  checkBaseline,
  checkCaller,
  checkCanary,
  checkInputs,
  checkRuntimes,
  checkSuppressions,
  EOL,
  exceptionsFor,
  expectsAdminRead,
  fetchRepoData,
  findSuppressions,
  hardCount,
  lastRunProblem,
  parseCaller,
  redactEmails,
  report,
  request,
  runAudit,
  suppressionRow,
  targetFrameworks,
  tokenFor,
  WARD,
  WARN_KINDS,
  warnKindsFor,
} from "./repo-audit.mjs";
import { fetchFile, listRepos } from "./repo-hygiene.mjs";
import { detectStacks, loadStacks } from "./stacks.mjs";

const stacks = loadStacks();
const kinds = (findings) => findings.map(([kind]) => kind);

const CALLER = `name: Ward
on:
  pull_request:
permissions:
  contents: read
jobs:
  ward:
    uses: malinfossum/ward/.github/workflows/ci.yml@v1
    with:
      node: "web" # the site
      a11y: 'warn'
      dotnet: api/App.slnx
      dotnet-ef-project: ""

  automerge:
    if: github.event_name == 'pull_request'
    uses: malinfossum/ward/.github/workflows/dependabot-automerge.yml@2939fee7aac178f0fdbc4ee9505a3e0464314e0c # v1.0.0
    with:
      required-check: ward / gate
`;

test("parseCaller reads the ci.yml ref and its inputs, stripping quotes and comments", () => {
  const caller = parseCaller(CALLER);
  assert.equal(caller.uses, "malinfossum/ward/.github/workflows/ci.yml@v1");
  assert.deepEqual(caller.inputs, {
    node: "web",
    a11y: "warn",
    dotnet: "api/App.slnx",
    "dotnet-ef-project": "",
  });
});

test("parseCaller reads a caller with no with: block, and none for a file that never calls ci.yml", () => {
  const bare = "jobs:\n  ward:\n    uses: malinfossum/ward/.github/workflows/ci.yml@v1\n";
  assert.deepEqual(parseCaller(bare), {
    uses: "malinfossum/ward/.github/workflows/ci.yml@v1",
    inputs: {},
    automerge: "",
  });
  assert.equal(parseCaller("jobs:\n  build:\n    runs-on: ubuntu-latest\n"), null);
});

test("a caller the line parser cannot read is absent, not a caller with wrong inputs", () => {
  const before =
    "jobs:\n  ward:\n    with:\n      node: web\n    uses: malinfossum/ward/.github/workflows/ci.yml@v1\n";
  assert.equal(parseCaller(before), null);
  const flow =
    "jobs:\n  ward:\n    uses: malinfossum/ward/.github/workflows/ci.yml@v1\n    with: { node: web }\n";
  assert.equal(parseCaller(flow), null);
  assert.deepEqual(kinds(checkCaller(flow, { self: false })), ["caller"]);
});

test("a block scalar input makes the caller unreadable, the same as flow style", () => {
  for (const marker of ["|", ">-"]) {
    const text = `jobs:\n  ward:\n    uses: malinfossum/ward/.github/workflows/ci.yml@v1\n    with:\n      node: ${marker}\n        web\n`;
    assert.equal(parseCaller(text), null, marker);
  }
  const quoted =
    'jobs:\n  ward:\n    uses: malinfossum/ward/.github/workflows/ci.yml@v1\n    with:\n      node: "|web"\n';
  assert.deepEqual(parseCaller(quoted).inputs, { node: "|web" });
});

test("a comment line inside the with block does not end it", () => {
  const text = [
    "jobs:",
    "  ward:",
    "    uses: malinfossum/ward/.github/workflows/ci.yml@v1",
    "    with:",
    "      node: web",
    "# a comment at column zero",
    "    # a comment at the job's indent",
    "      dotnet: api/App.slnx",
    "",
  ].join("\n");
  assert.deepEqual(parseCaller(text).inputs, { node: "web", dotnet: "api/App.slnx" });
});

test("checkCaller wants ward.yml present and on @v1", () => {
  assert.deepEqual(kinds(checkCaller(null, { self: false })), ["caller"]);
  assert.deepEqual(
    kinds(checkCaller("jobs:\n  x:\n    runs-on: ubuntu-latest\n", { self: false })),
    ["caller"],
  );
  const pinned = CALLER.replace("ci.yml@v1", "ci.yml@2939fee7aac178f0fdbc4ee9505a3e0464314e0c");
  const [finding] = checkCaller(pinned, { self: false });
  assert.equal(finding[0], "caller");
  assert.match(finding[1], /must be malinfossum\/ward\/\.github\/workflows\/ci\.yml@v1/);
  assert.deepEqual(checkCaller(CALLER, { self: false }), []);
});

test("Ward itself may call ci.yml by local path; nobody else may", () => {
  const local = "jobs:\n  ward:\n    uses: ./.github/workflows/ci.yml\n    with:\n      node: .\n";
  assert.deepEqual(checkCaller(local, { self: true }), []);
  assert.deepEqual(kinds(checkCaller(local, { self: false })), ["caller"]);
  assert.deepEqual(parseCaller(local).inputs, { node: "." });
});

test("the automerge job must point at Ward's dependabot-automerge.yml at a full commit SHA", () => {
  const sha = "2939fee7aac178f0fdbc4ee9505a3e0464314e0c";
  assert.equal(
    parseCaller(CALLER).automerge,
    `malinfossum/ward/.github/workflows/dependabot-automerge.yml@${sha}`,
  );
  const floating = CALLER.replace(
    `dependabot-automerge.yml@${sha} # v1.0.0`,
    "dependabot-automerge.yml@v1",
  );
  const [finding] = checkCaller(floating, { self: false });
  assert.equal(finding[0], "caller");
  assert.match(finding[1], /automerge job uses .*@v1; it must be .* at a full commit SHA/);
  const local = CALLER.replace(
    `malinfossum/ward/.github/workflows/dependabot-automerge.yml@${sha} # v1.0.0`,
    "./.github/workflows/dependabot-automerge.yml",
  );
  assert.deepEqual(kinds(checkCaller(local, { self: true })), ["caller"]);
  assert.deepEqual(checkCaller(CALLER, { self: false }), []);
});

test("a stack whose module is off in the caller is a finding", () => {
  const paths = ["package.json", "api/App.slnx", "api/App/App.csproj"];
  const detected = detectStacks(paths, stacks);
  const findings = checkInputs({ node: "." }, detected, paths);
  assert.deepEqual(kinds(findings), ["inputs"]);
  assert.match(
    findings[0][1],
    /dotnet files .*api\/App\.slnx.* but the caller's dotnet input is empty/,
  );
  assert.equal(checkInputs({ node: ".", dotnet: "" }, detected, paths).length, 1);
  assert.deepEqual(checkInputs({ node: ".", dotnet: "api/App.slnx" }, detected, paths), []);
});

test("an input that points at nothing on the default branch is a finding", () => {
  const paths = ["web/package.json", "src/App/App.csproj"];
  const detected = detectStacks(paths, stacks);
  const findings = checkInputs({ node: "site", dotnet: "src/Old.slnx" }, detected, paths);
  assert.deepEqual(kinds(findings), ["inputs", "inputs"]);
  assert.match(findings[0][1], /site\/package\.json is not on the default branch/);
  assert.match(findings[1][1], /src\/Old\.slnx, which is not on the default branch/);
  assert.deepEqual(checkInputs({ node: "web", dotnet: "src/App" }, detected, paths), []);
});

test("a leading ./ in an input is the same path as without it", () => {
  const paths = ["web/package.json", "src/App/App.csproj"];
  const detected = detectStacks(paths, stacks);
  assert.deepEqual(checkInputs({ node: "./web", dotnet: "./src/App" }, detected, paths), []);
  const rootPaths = ["package.json"];
  const root = detectStacks(rootPaths, stacks);
  assert.deepEqual(checkInputs({ node: "./" }, root, rootPaths), []);
  const findings = checkInputs({ node: "./site", dotnet: "./src/App" }, detected, paths);
  assert.deepEqual(kinds(findings), ["inputs"]);
  assert.match(findings[0][1], /node points at \.\/site, but site\/package\.json is not/);
});

test("a planned stack is an uncovered warning, with or without a caller", () => {
  const paths = ["pyproject.toml", "package.json"];
  const detected = detectStacks(paths, stacks);
  const withCaller = checkInputs({ node: "." }, detected, paths);
  assert.deepEqual(kinds(withCaller), ["uncovered"]);
  assert.ok(WARN_KINDS.has("uncovered"));
  assert.deepEqual(kinds(checkInputs(null, detected, paths)), ["uncovered"]);
});

const baseline = {
  securityUpdates: { enabled: true, paused: false },
  alerts: true,
  analysis: {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  },
  codeScanning: { state: "configured" },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "code_scanning",
      parameters: {
        code_scanning_tools: [
          {
            tool: "CodeQL",
            security_alerts_threshold: "high_or_higher",
            alerts_threshold: "errors",
          },
        ],
      },
    },
    { type: "pull_request", parameters: { required_approving_review_count: 0 } },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "ward / gate" }] },
    },
  ],
};

test("the full baseline passes", () => {
  assert.deepEqual(checkBaseline(baseline), []);
});

test("each baseline setting that is off is its own finding", () => {
  const off = {
    securityUpdates: { enabled: false, paused: false },
    alerts: false,
    analysis: {
      secret_scanning: { status: "disabled" },
      secret_scanning_push_protection: { status: "disabled" },
    },
    codeScanning: { state: "not-configured" },
    rules: [],
  };
  const findings = checkBaseline(off);
  assert.deepEqual(kinds(findings), [
    "baseline",
    "baseline",
    "baseline",
    "baseline",
    "baseline",
    "ruleset",
    "ruleset",
    "ruleset",
    "ruleset",
    "ruleset",
  ]);
  assert.match(findings[5][1], /does not require a pull request/);
  assert.match(findings[9][1], /"ward \/ gate"/);
});

test("paused security updates and a ruleset without the gate are findings", () => {
  const paused = { ...baseline, securityUpdates: { enabled: true, paused: true } };
  assert.deepEqual(kinds(checkBaseline(paused)), ["baseline"]);
  const noGate = {
    ...baseline,
    rules: baseline.rules.filter((rule) => rule.type !== "required_status_checks"),
  };
  assert.deepEqual(kinds(checkBaseline(noGate)), ["ruleset"]);
});

test("a ruleset that allows force pushes or skips code scanning is a finding per rule", () => {
  const loose = {
    ...baseline,
    rules: baseline.rules.filter(
      (rule) => !["non_fast_forward", "code_scanning"].includes(rule.type),
    ),
  };
  const findings = checkBaseline(loose);
  assert.deepEqual(kinds(findings), ["ruleset", "ruleset"]);
  assert.match(findings[0][1], /force push/);
  assert.match(findings[1][1], /code scanning/);
});

test("a field missing from the fetched data is a token warning, not a crash", () => {
  for (const field of ["securityUpdates", "alerts", "analysis", "codeScanning", "rules"]) {
    const findings = checkBaseline({ ...baseline, [field]: undefined });
    assert.deepEqual(kinds(findings), ["token"], field);
  }
});

test("CodeQL off is a finding only where CodeQL has a language to analyse", () => {
  const docsOnly = { ...baseline, codeScanning: { state: "not-configured", languages: [] } };
  assert.deepEqual(checkBaseline(docsOnly), []);
  const withCode = {
    ...baseline,
    codeScanning: { state: "not-configured", languages: ["actions"] },
  };
  assert.deepEqual(kinds(checkBaseline(withCode)), ["baseline"]);
});

test("a setting the token cannot read is a token warning, not a pass and not a false red", () => {
  const unreadable = {
    securityUpdates: null,
    alerts: null,
    analysis: null,
    codeScanning: null,
    rules: null,
  };
  const findings = checkBaseline(unreadable);
  assert.deepEqual(kinds(findings), ["token"]);
  assert.match(findings[0][1], /Administration \(read\)/);
  assert.match(findings[0][1], /branch rules/);
  assert.ok(WARN_KINDS.has("token"));
});

const PROPS = `<Project>
  <PropertyGroup>
    <NuGetAudit>true</NuGetAudit>
  </PropertyGroup>
  <ItemGroup>
    <!-- 2026-09-30: transitive via Foo 1.2; fixed upstream in 1.3, bump when released. -->
    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-aaaa-bbbb-cccc" />

    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-dddd-eeee-ffff" /> <!-- 2026-10-01 waiting on Bar -->
    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-gggg-hhhh-iiii" />
    <!--
      Two lines, dated 2026-08-01:
      needed until the .NET 10 bump.
    -->
    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-jjjj-kkkk-llll" />
  </ItemGroup>
</Project>
`;

test("findSuppressions pairs each suppression with the comment beside or above it", () => {
  const found = findSuppressions({ "Directory.Build.props": PROPS });
  assert.deepEqual(
    found.map((s) => [s.advisory.slice(-19), s.dated]),
    [
      ["GHSA-aaaa-bbbb-cccc", true],
      ["GHSA-dddd-eeee-ffff", true],
      ["GHSA-gggg-hhhh-iiii", false],
      ["GHSA-jjjj-kkkk-llll", true],
    ],
  );
  assert.match(found[0].reason, /^2026-09-30: transitive/);
  assert.equal(found[2].reason, "");
  assert.match(found[3].reason, /Two lines, dated 2026-08-01: needed until/);
  assert.equal(found[0].file, "Directory.Build.props");
});

test("the template's example suppression inside a comment does not count", () => {
  const template = readFileSync("templates/Directory.Build.props", "utf8");
  assert.match(template, /NuGetAuditSuppress/, "the template still shows the example");
  assert.deepEqual(findSuppressions({ "Directory.Build.props": template }), []);
});

test("an undated suppression is a finding; a dated one is only listed", () => {
  const findings = checkSuppressions(findSuppressions({ "api/App.csproj": PROPS }));
  assert.deepEqual(kinds(findings), ["suppression"]);
  assert.match(
    findings[0][1],
    /api\/App\.csproj: .*GHSA-gggg-hhhh-iiii has no dated reason \(YYYY-MM-DD\)/,
  );
});

test("the EOL table holds the dates verified on endoflife.date", () => {
  assert.equal(EOL.dotnet["net8.0"], "2026-11-10");
  assert.equal(EOL.dotnet["net9.0"], "2026-11-10");
  assert.equal(EOL.node["20"], "2026-04-30");
  assert.equal(EOL.node["22"], "2027-04-30");
});

test("targetFrameworks reads single and multi-target projects", () => {
  const files = {
    "a/A.csproj": "<TargetFramework>net8.0</TargetFramework>",
    "b/B.csproj": "<TargetFrameworks>net8.0;net10.0-windows</TargetFrameworks>",
  };
  assert.deepEqual(targetFrameworks(files), [
    { file: "a/A.csproj", tfm: "net8.0" },
    { file: "b/B.csproj", tfm: "net8.0" },
    { file: "b/B.csproj", tfm: "net10.0-windows" },
  ]);
});

test("a runtime within 90 days of end of life, or past it, is a finding", () => {
  const frameworks = [
    { file: "a/A.csproj", tfm: "net8.0" },
    { file: "b/B.csproj", tfm: "net10.0-windows" },
    { file: "c/C.csproj", tfm: "netstandard2.0" },
    { file: "d/D.csproj", tfm: "net472" },
  ];
  const near = checkRuntimes({ frameworks, nodeVersion: "", today: "2026-09-30" });
  assert.deepEqual(kinds(near), ["runtime"]);
  assert.match(near[0][1], /a\/A\.csproj: net8\.0 reaches end of life on 2026-11-10/);
  const past = checkRuntimes({ frameworks, nodeVersion: "", today: "2026-12-01" });
  assert.match(past[0][1], /reached end of life/);
  const far = checkRuntimes({ frameworks, nodeVersion: "", today: "2026-06-01" });
  assert.deepEqual(far, []);
});

test("the caller's node-version is checked the same way; an unknown major is a finding", () => {
  const today = "2026-09-30";
  assert.deepEqual(checkRuntimes({ frameworks: [], nodeVersion: "24", today }), []);
  const old = checkRuntimes({ frameworks: [], nodeVersion: "20.x", today });
  assert.match(old[0][1], /Node 20 reached end of life on 2026-04-30/);
  const soon = checkRuntimes({ frameworks: [], nodeVersion: "22", today: "2027-03-01" });
  assert.match(soon[0][1], /Node 22 reaches end of life/);
  const unknown = checkRuntimes({ frameworks: [], nodeVersion: "12", today });
  assert.match(unknown[0][1], /not in the EOL table/);
});

test("a retired runtime reads as past end of life, not as missing from the table", () => {
  const frameworks = [{ file: "a/A.csproj", tfm: "net6.0" }];
  const dotnet = checkRuntimes({ frameworks, nodeVersion: "", today: "2026-09-30" });
  assert.deepEqual(dotnet, [["runtime", "a/A.csproj: net6.0 reached end of life on 2024-11-12."]]);
  const node = checkRuntimes({ frameworks: [], nodeVersion: "18", today: "2026-09-30" });
  assert.match(node[0][1], /Node 18 reached end of life on 2025-04-30/);
});

test("targetFrameworks dedupes the same runtime in one file", () => {
  const files = {
    "a/A.csproj": "<TargetFrameworks>net8.0;net8.0-windows</TargetFrameworks>",
  };
  const frameworks = targetFrameworks(files);
  const findings = checkRuntimes({ frameworks, nodeVersion: "", today: "2026-09-30" });
  assert.deepEqual(kinds(findings), ["runtime"]);
  assert.equal(findings.length, 1, "exactly one runtime finding for net8.0");
  assert.match(findings[0][1], /a\/A\.csproj: net8\.0 reaches end of life/);
});

test("a healthy canary run passes", () => {
  const runs = {
    total_count: 3,
    workflow_runs: [{ conclusion: "success", updated_at: "2026-09-28T06:00:00Z", html_url: "u" }],
  };
  assert.deepEqual(checkCanary(runs, "2026-09-30T08:00:00Z"), []);
});

test("a red, stale, never-run or missing canary is a hard finding", () => {
  const red = {
    workflow_runs: [{ conclusion: "failure", updated_at: "2026-09-29T06:00:00Z", html_url: "u" }],
  };
  assert.match(checkCanary(red, "2026-09-30T08:00:00Z")[0][1], /ended failure: u/);
  const stale = {
    workflow_runs: [{ conclusion: "success", updated_at: "2026-09-20T06:00:00Z", html_url: "u" }],
  };
  assert.match(checkCanary(stale, "2026-09-30T08:00:00Z")[0][1], /10 days old/);
  assert.match(
    checkCanary({ total_count: 0, workflow_runs: [] }, "2026-09-30T08:00:00Z")[0][1],
    /never completed/,
  );
  // Since Plan 5 the canary exists: a 404 is a deleted or renamed canary.
  const missing = checkCanary(null, "2026-09-30T08:00:00Z");
  assert.deepEqual(kinds(missing), ["canary"]);
  assert.match(missing[0][1], /No canary\.yml in malinfossum\/ward/);
  assert.ok(!WARN_KINDS.has("canary-missing"));
  for (const findings of [
    missing,
    checkCanary(red, "x"),
    checkCanary(stale, "2026-09-30T08:00:00Z"),
  ]) {
    assert.ok(!WARN_KINDS.has(findings[0][0]));
  }
});

test("lastRunProblem: liveness only when requireSuccess is off; a bad date is never fresh", () => {
  const fresh = { conclusion: "failure", updated_at: "2026-09-29T06:00:00Z", html_url: "u" };
  const runs = { workflow_runs: [fresh] };
  assert.match(lastRunProblem("repo-audit.yml", runs, "2026-09-30T08:00:00Z"), /ended failure/);
  assert.equal(
    lastRunProblem("repo-audit.yml", runs, "2026-09-30T08:00:00Z", { requireSuccess: false }),
    null,
  );
  const old = {
    workflow_runs: [{ ...fresh, conclusion: "success", updated_at: "2026-09-21T06:00:00Z" }],
  };
  assert.match(
    lastRunProblem("repo-audit.yml", old, "2026-09-30T08:00:00Z", { requireSuccess: false }),
    /repo-audit\.yml run is 9 days old/,
  );
  assert.match(lastRunProblem("x.yml", null, "2026-09-30T08:00:00Z"), /never completed/);
  assert.match(
    lastRunProblem("x.yml", { workflow_runs: [{ ...fresh, conclusion: "success" }] }, "x"),
    /days old/,
  );
});

test("auditRepo runs every check over one repo's data", () => {
  const data = {
    self: false,
    tree: ["package.json", "api/App.slnx", "api/App/App.csproj", "api/Directory.Build.props"],
    caller: CALLER.replace('node: "web" # the site', "node: .").replace(
      "dotnet: api/App.slnx",
      "dotnet: api/App.slnx\n      node-version: '20'",
    ),
    files: {
      "api/Directory.Build.props": PROPS,
      "api/App/App.csproj": "<TargetFramework>net8.0</TargetFramework>",
    },
    baseline,
  };
  const { findings, suppressions } = auditRepo(data, { stacks, today: "2026-09-30" });
  assert.deepEqual(kinds(findings).sort(), ["runtime", "runtime", "suppression"]);
  assert.equal(suppressions.length, 4);
});

test("tokenFor: an org's own token, WARD_AUDIT_TOKEN for my repos only, never the Actions token", () => {
  const env = {
    GITHUB_TOKEN: "actions",
    WARD_AUDIT_TOKEN: "audit",
    AUDIT_TOKEN_ROOKDEX: "org",
  };
  assert.equal(tokenFor("rookdex", env), "org");
  assert.equal(tokenFor("wendhq", env), "");
  assert.equal(tokenFor("malinfossum", env), "audit");
  assert.equal(tokenFor("malinfossum", { GITHUB_TOKEN: "actions" }), "");
  assert.equal(tokenFor("funn-team", { AUDIT_TOKEN_FUNN_TEAM: "t" }), "t");
  assert.equal(tokenFor("x", {}), "");
});

test("a token finding fails the run where admin read is promised", () => {
  assert.equal(expectsAdminRead("malinfossum", {}), true);
  assert.equal(expectsAdminRead("rookdex", {}), false);
  assert.equal(expectsAdminRead("rookdex", { AUDIT_TOKEN_ROOKDEX: "t" }), true);
});

test("a kind named in --warn-kinds is a warning; the same kind without the flag is a failure", () => {
  const findings = [
    ["caller", "x"],
    ["baseline", "y"],
    ["uncovered", "z"],
  ];
  assert.equal(hardCount(findings, warnKindsFor("malinfossum", {})), 2);
  assert.equal(hardCount(findings, warnKindsFor("malinfossum", {}, ["caller"])), 1);
  assert.ok(!warnKindsFor("malinfossum", {}).has("token"));
  assert.ok(warnKindsFor("rookdex", {}).has("token"));
});

const NOW = "2026-09-30T06:00:00Z";

test("canaryFindings: only a 404 means no canary; 401 and 403 are a token finding", () => {
  assert.deepEqual(kinds(canaryFindings(404, null, NOW)), ["canary"]);
  for (const status of [401, 403]) {
    const findings = canaryFindings(status, null, NOW);
    assert.deepEqual(kinds(findings), ["token"]);
    assert.match(findings[0][1], new RegExp(`HTTP ${status}`));
    assert.ok(findings[0][1].includes(WARD));
  }
  const runs = { workflow_runs: [{ conclusion: "success", updated_at: "2026-09-29T06:00:00Z" }] };
  assert.deepEqual(canaryFindings(200, runs, NOW), checkCanary(runs, NOW));
});

test("a canary that cannot be read fails the run on my own repo", () => {
  const own = warnKindsFor(WARD.split("/")[0], {});
  assert.equal(hardCount(canaryFindings(403, null, NOW), own), 1);
  assert.equal(hardCount(canaryFindings(401, null, NOW), own), 1);
  assert.equal(hardCount(canaryFindings(404, null, NOW), own), 1);
});

test("the suppression table redacts email addresses from the public reason", () => {
  assert.equal(
    redactEmails("ask a.b+c@proton.me or x@y.co.uk today"),
    "ask [redacted] or [redacted] today",
  );
  const row = suppressionRow({
    repo: "malinfossum/x",
    file: "Directory.Build.props",
    advisory: "https://github.com/advisories/GHSA-1",
    reason: "2026-09-30 mail m.fossum@proton.me",
  });
  assert.ok(!row.includes("@"));
  assert.ok(row.includes("[redacted]"));
  assert.ok(suppressionRow({ repo: "r", file: "f", advisory: "a", reason: "" }).includes("(none)"));
});

// A stand-in for fetch: the first route whose pattern matches the API path
// answers, a route whose status is an Error throws it like a network failure,
// and an unrouted path gets a 599 so a missing route fails loudly. Every call
// is recorded with its Authorization header. Each test restores the real fetch
// in a finally, so no test ever touches the network.
function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push({ path, auth: init.headers?.Authorization ?? "" });
    const route = routes.find(([pattern]) => pattern.test(path));
    if (!route) return new Response(null, { status: 599 });
    const [, status, body] = route;
    if (status instanceof Error) throw status;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// Runs fn with console.log captured, so annotations printed by the code under
// test never reach the test log (where CI would read them as real ones).
async function quietly(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    return { lines, result: await fn() };
  } finally {
    console.log = original;
  }
}

const b64 = (text) => Buffer.from(text).toString("base64");
const SETTINGS = /\/(automated-security-fixes|vulnerability-alerts|code-scanning\/default-setup)$/;
const META = {
  full_name: "malinfossum/x",
  default_branch: "main",
  security_and_analysis: baseline.analysis,
};
const REPO_ROUTES = [
  [
    /\/git\/trees\/main\?recursive=1$/,
    200,
    {
      truncated: false,
      tree: [
        { type: "blob", path: "package.json" },
        { type: "tree", path: "src" },
        { type: "blob", path: "src/App.csproj" },
      ],
    },
  ],
  [/\/contents\/\.github\/workflows\/ward\.yml$/, 200, { content: b64(CALLER) }],
  [
    /\/contents\/src\/App\.csproj$/,
    200,
    { content: b64("<TargetFramework>net8.0</TargetFramework>") },
  ],
  [/\/rules\/branches\/main$/, 200, baseline.rules],
];

test("fetchRepoData: with admin read, 200 and 204 fill every setting", async () => {
  const stub = stubFetch([
    [/\/automated-security-fixes$/, 200, { enabled: true, paused: false }],
    [/\/vulnerability-alerts$/, 204],
    [/\/code-scanning\/default-setup$/, 200, { state: "configured" }],
    ...REPO_ROUTES,
  ]);
  try {
    const data = await fetchRepoData(META, { admin: "admin", read: "read", stacks });
    assert.deepEqual(data.baseline, baseline);
    assert.deepEqual(data.tree, ["package.json", "src/App.csproj"]);
    assert.equal(data.caller, CALLER);
    assert.deepEqual(data.files, { "src/App.csproj": "<TargetFramework>net8.0</TargetFramework>" });
    assert.deepEqual(checkBaseline(data.baseline), []);
    for (const call of stub.calls) {
      assert.equal(call.auth, SETTINGS.test(call.path) ? "Bearer admin" : "Bearer read", call.path);
    }
  } finally {
    stub.restore();
  }
});

test("fetchRepoData: with admin read, a 404 on either Dependabot endpoint means off", async () => {
  const stub = stubFetch([
    [/\/automated-security-fixes$/, 404],
    [/\/vulnerability-alerts$/, 404],
    [/\/code-scanning\/default-setup$/, 200, { state: "configured" }],
    ...REPO_ROUTES,
  ]);
  try {
    const data = await fetchRepoData(META, { admin: "admin", read: "read", stacks });
    assert.deepEqual(data.baseline.securityUpdates, { enabled: false, paused: false });
    assert.equal(data.baseline.alerts, false);
    const findings = checkBaseline(data.baseline);
    assert.deepEqual(kinds(findings), ["baseline", "baseline"]);
    assert.match(findings[0][1], /alerts are off/);
    assert.match(findings[1][1], /security updates are off/);
  } finally {
    stub.restore();
  }
});

test("fetchRepoData: without admin read every setting is unreadable, whatever the endpoints say", async () => {
  const stub = stubFetch([
    [/\/automated-security-fixes$/, 403],
    [/\/vulnerability-alerts$/, 404],
    [/\/code-scanning\/default-setup$/, 403],
    ...REPO_ROUTES,
  ]);
  try {
    const { security_and_analysis, ...plain } = META;
    const data = await fetchRepoData(plain, { admin: "admin", read: "read", stacks });
    const { securityUpdates, alerts, analysis, codeScanning } = data.baseline;
    assert.deepEqual([securityUpdates, alerts, analysis, codeScanning], [null, null, null, null]);
    assert.ok(!stub.calls.some((call) => SETTINGS.test(call.path)), "no settings request");
    const findings = checkBaseline(data.baseline);
    assert.deepEqual(kinds(findings), ["token"]);
    assert.match(findings[0][1], /Administration \(read\)/);
  } finally {
    stub.restore();
  }
});

test("fetchRepoData: with no admin token the settings are not read and one finding names the secret", async () => {
  const stub = stubFetch(REPO_ROUTES);
  try {
    // A user token as the read token can see security_and_analysis; the
    // missing admin token still decides.
    for (const [owner, secret] of [
      ["malinfossum", "WARD_AUDIT_TOKEN"],
      ["rookdex", "AUDIT_TOKEN_ROOKDEX"],
    ]) {
      const meta = { ...META, full_name: `${owner}/x` };
      const data = await fetchRepoData(meta, { admin: "", read: "read", stacks });
      const { securityUpdates, alerts, analysis, codeScanning } = data.baseline;
      assert.deepEqual([securityUpdates, alerts, analysis, codeScanning], [null, null, null, null]);
      assert.deepEqual(checkBaseline(data.baseline), [
        ["token", `${secret} is not set, so the settings of ${owner}/x were not read.`],
      ]);
    }
    assert.ok(!stub.calls.some((call) => SETTINGS.test(call.path)), "no settings request");
    assert.ok(stub.calls.every((call) => call.auth === "Bearer read"));
  } finally {
    stub.restore();
  }
});

test("fetchRepoData: a tree that does not answer 200 is an error, never an empty repo", async () => {
  const stub = stubFetch([[/\/git\/trees\//, 404]]);
  try {
    await assert.rejects(
      fetchRepoData(META, { admin: "admin", read: "read", stacks }),
      /GitHub API 404 on the tree of malinfossum\/x/,
    );
  } finally {
    stub.restore();
  }
});

test("listRepos pages until a short page, drops private and fork repos, and a missing owner is empty", async () => {
  const repo = (name, extra = {}) => ({
    name,
    full_name: `malinfossum/${name}`,
    owner: { login: "malinfossum" },
    fork: false,
    private: false,
    ...extra,
  });
  const first = Array.from({ length: 100 }, (_, i) => repo(`r${String(i).padStart(3, "0")}`));
  first[0] = repo("forked", { fork: true });
  first[1] = repo("hidden", { private: true });
  const stub = stubFetch([
    [/\/users\/malinfossum\/repos\?.*&page=1$/, 200, first],
    [/\/users\/malinfossum\/repos\?.*&page=2$/, 200, [repo("zz")]],
    [/\/users\/ghost\/repos/, 404],
  ]);
  try {
    const names = (await listRepos(["malinfossum"], "read")).map((r) => r.name);
    assert.equal(names.length, 99);
    assert.ok(!names.includes("forked") && !names.includes("hidden"));
    assert.equal(names.at(-1), "zz");
    const pages = stub.calls.filter((call) => call.path.startsWith("/users/malinfossum/"));
    assert.equal(pages.length, 2, "stops after the short second page");
    assert.deepEqual(await listRepos(["ghost"], "read"), []);
  } finally {
    stub.restore();
  }
});

test("fetchFile decodes a 200 and reads a 404 as no file", async () => {
  const stub = stubFetch([
    [/\/contents\/docs\/a\.md$/, 200, { content: b64("héllo\n") }],
    [/\/contents\/missing\.md$/, 404],
  ]);
  try {
    assert.equal(await fetchFile("malinfossum/x", "docs/a.md", "read"), "héllo\n");
    assert.equal(await fetchFile("malinfossum/x", "missing.md", "read"), null);
  } finally {
    stub.restore();
  }
});

test("an annotation escapes newlines, so a message cannot start a workflow command", async () => {
  const message = "line one\n::stop-commands::token\r\n100% sure";
  const { lines, result } = await quietly(() =>
    report("malinfossum/x", [["baseline", message]], "error"),
  );
  assert.equal(
    lines.find((line) => line.startsWith("::")),
    "::error::malinfossum/x [baseline] line one%0A::stop-commands::token%0D%0A100%25 sure",
  );
  assert.ok(lines.every((line) => !/[\r\n]/.test(line)));
  assert.ok(result.includes("- **baseline**: line one ::stop-commands::token 100% sure\n"));
});

test("a failed repo list or canary read is an error finding, and the summary still comes back", async () => {
  const stub = stubFetch([
    [/\/users\/rookdex\/repos/, 502],
    [/\/users\/malinfossum\/repos/, 200, []],
    [/\/canary\.yml\/runs/, 503],
  ]);
  try {
    const { result } = await quietly(() =>
      runAudit(["--owner", "rookdex,malinfossum", "--mode", "strict"], { GITHUB_TOKEN: "read" }),
    );
    assert.match(
      result.summary,
      /### rookdex\n\n- \*\*error\*\*: rookdex: could not list repos \(HTTP 502\)\n/,
    );
    assert.match(
      result.summary,
      /### malinfossum\/ward canary\n\n- \*\*error\*\*: .*GitHub API 503/,
    );
    assert.ok(stub.calls.some((call) => call.path.startsWith("/users/malinfossum/repos")));
    assert.equal(result.failures, 2);
  } finally {
    stub.restore();
  }
  const thrown = stubFetch([
    [/\/users\//, 200, []],
    [/\/canary\.yml\/runs/, new TypeError("fetch failed")],
  ]);
  try {
    const { result } = await quietly(() =>
      runAudit(["--mode", "strict"], { GITHUB_TOKEN: "read" }),
    );
    assert.match(result.summary, /### malinfossum\/ward canary\n\n- \*\*error\*\*: .*fetch failed/);
    assert.equal(result.failures, 1);
  } finally {
    thrown.restore();
  }
});

test("an error on an archived repo is a warning in the archived section, never a failure", async () => {
  const listed = {
    name: "old",
    full_name: "rookdex/old",
    owner: { login: "rookdex" },
    archived: true,
    fork: false,
    private: false,
  };
  const stub = stubFetch([
    [/\/users\/rookdex\/repos/, 200, [listed]],
    [/^\/repos\/rookdex\/old$/, 500],
    [
      /\/canary\.yml\/runs/,
      200,
      {
        workflow_runs: [
          { conclusion: "success", updated_at: new Date().toISOString(), html_url: "u" },
        ],
      },
    ],
  ]);
  try {
    const { lines, result } = await quietly(() =>
      runAudit(["--owner", "rookdex", "--include-archived", "--mode", "strict"], {
        GITHUB_TOKEN: "read",
      }),
    );
    assert.equal(result.failures, 0);
    const archived = result.summary.split("<details>")[1] ?? "";
    assert.match(archived, /### rookdex\/old \(archived\)\n\n- \*\*error\*\*: GitHub API 500/);
    assert.ok(lines.some((line) => line.startsWith("::warning::rookdex/old (archived) [error]")));
  } finally {
    stub.restore();
  }
});

test("an org without its own token: one token finding naming the secret, and the admin token never sent", async () => {
  const stub = stubFetch([
    [
      /\/users\/rookdex\/repos/,
      200,
      [
        {
          name: "x",
          full_name: "rookdex/x",
          owner: { login: "rookdex" },
          fork: false,
          private: false,
        },
      ],
    ],
    [
      /^\/repos\/rookdex\/x$/,
      200,
      { full_name: "rookdex/x", default_branch: "main", archived: false },
    ],
    [/\/git\/trees\/main/, 200, { truncated: false, tree: [] }],
    [/\/contents\//, 404],
    [/\/rules\/branches\/main$/, 200, baseline.rules],
    [
      /\/canary\.yml\/runs/,
      200,
      {
        workflow_runs: [
          { conclusion: "success", updated_at: new Date().toISOString(), html_url: "u" },
        ],
      },
    ],
  ]);
  try {
    const env = { GITHUB_TOKEN: "read", WARD_AUDIT_TOKEN: "mine" };
    const { result } = await quietly(() =>
      runAudit(["--owner", "rookdex", "--mode", "strict"], env),
    );
    const tokenLines = result.summary.split("\n").filter((line) => line.startsWith("- **token**"));
    assert.deepEqual(tokenLines, [
      "- **token**: AUDIT_TOKEN_ROOKDEX is not set, so the settings of rookdex/x were not read.",
    ]);
    assert.ok(stub.calls.every((call) => call.auth === "Bearer read"));
    assert.ok(!stub.calls.some((call) => SETTINGS.test(call.path)));
  } finally {
    stub.restore();
  }
});

const liveToken = process.env.GITHUB_TOKEN || "";
// The one test that touches the network. Skipped without a token, so `npm test`
// in CI and on a fresh clone stays offline; run it locally with
// GITHUB_TOKEN=$(gh auth token) npm test.
test("live: Ward itself passes the baseline, caller and input checks", {
  skip: !liveToken && "no GITHUB_TOKEN in the environment",
}, async () => {
  const meta = (await request(`/repos/${WARD}`, liveToken)).body;
  assert.equal(meta.full_name, WARD);
  const data = await fetchRepoData(meta, { admin: liveToken, read: liveToken });
  assert.equal(data.self, true);
  assert.ok(data.tree.includes("package.json"));
  assert.match(data.caller, /uses: \.\/\.github\/workflows\/ci\.yml/);
  const { findings } = auditRepo(data, { stacks, today: new Date().toISOString().slice(0, 10) });
  const hard = findings.filter(([kind]) =>
    ["baseline", "ruleset", "caller", "inputs"].includes(kind),
  );
  assert.deepEqual(hard, []);
});

const STACKS_WITH_EXCEPTIONS = {
  ...stacks,
  exceptions: {
    "malinfossum/Backend-Course": { dotnet: "Course repo, one solution per week (2026-10-02)." },
  },
};

test("exceptionsFor matches the repo name case-insensitively and is empty otherwise", () => {
  assert.deepEqual(exceptionsFor("malinfossum/backend-course", STACKS_WITH_EXCEPTIONS), {
    dotnet: "Course repo, one solution per week (2026-10-02).",
  });
  assert.deepEqual(exceptionsFor("malinfossum/other", STACKS_WITH_EXCEPTIONS), {});
  assert.deepEqual(exceptionsFor("malinfossum/backend-course", { ...stacks, exceptions: {} }), {});
});

test("an exception can also defer a caller, ruleset or baseline finding on a joint repo", () => {
  const paths = ["Wend.slnx"];
  const deferred = {
    ...stacks,
    exceptions: { "wendhq/wend": { ruleset: "Waiting for the co-owner (2026-10-02)." } },
  };
  const { findings } = auditRepo(
    {
      repo: "wendhq/wend",
      tree: paths,
      caller: null,
      files: {},
      baseline: { ...baseline, rules: [] },
      self: false,
    },
    { stacks: deferred, today: "2026-10-02" },
  );
  assert.ok(!findings.some(([kind]) => kind === "ruleset"), "ruleset findings are deferred");
  assert.ok(findings.some(([kind, msg]) => kind === "exception" && /ruleset .*deferred/.test(msg)));
  assert.ok(
    findings.some(([kind]) => kind === "caller"),
    "an undeferred kind still fails",
  );
});

test("an excepted module that is off is a warning naming the reason, never an inputs finding", () => {
  const paths = ["Week 01/A.slnx", "Week 02/B.slnx"];
  const detected = detectStacks(paths, stacks);
  const exceptions = { dotnet: "Course repo, one solution per week (2026-10-02)." };
  const findings = checkInputs({ node: "", dotnet: "" }, detected, paths, exceptions);
  assert.deepEqual(kinds(findings), ["exception"]);
  assert.match(findings[0][1], /dotnet is off by exception: Course repo/);
  assert.ok(WARN_KINDS.has("exception"));
  // Without the exception the same caller is an inputs failure.
  assert.deepEqual(kinds(checkInputs({ node: "", dotnet: "" }, detected, paths)), ["inputs"]);
});

test("a stale exception is reported: no files for that module, or the input is set anyway", () => {
  const exceptions = { dotnet: "Gone (2026-10-02)." };
  const none = checkInputs(
    { node: "." },
    detectStacks(["package.json"], stacks),
    ["package.json"],
    exceptions,
  );
  assert.deepEqual(kinds(none), ["exception"]);
  assert.match(none[0][1], /stale exception for dotnet/);
  const paths = ["A.slnx"];
  const on = checkInputs({ dotnet: "A.slnx" }, detectStacks(paths, stacks), paths, exceptions);
  assert.deepEqual(kinds(on), ["exception"]);
  assert.match(on[0][1], /stale exception for dotnet/);
});

test("auditRepo passes the repo's exceptions through", () => {
  const paths = ["Week 01/A.slnx"];
  const caller = [
    "jobs:",
    "  ward:",
    "    uses: malinfossum/ward/.github/workflows/ci.yml@v1",
    "    with:",
    '      dotnet: ""',
  ].join("\n");
  const { findings } = auditRepo(
    { repo: "malinfossum/backend-course", tree: paths, caller, files: {}, baseline, self: false },
    { stacks: STACKS_WITH_EXCEPTIONS, today: "2026-10-02" },
  );
  assert.ok(findings.some(([kind]) => kind === "exception"));
  assert.ok(!findings.some(([kind]) => kind === "inputs"));
});
