import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBaseline, checkCaller, checkInputs, parseCaller, WARN_KINDS } from "./repo-audit.mjs";
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
