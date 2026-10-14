import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const files = [
  ...readdirSync(".github/workflows").map((f) => join(".github/workflows", f)),
  "templates/ward.yml",
];

test("every action is pinned to a full SHA with a version comment", () => {
  let matched = 0;
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*-?\s*uses:\s*(\S+)(.*)$/);
      if (!match || match[1].startsWith("./")) continue;
      const [target, rest] = [match[1], match[2]];
      if (/^malinfossum\/ward\/\.github\/workflows\/ci\.yml@v\d+$/.test(target)) continue;
      matched++;
      assert.match(target, /@[0-9a-f]{40}$/, `${file}: ${target} is not SHA-pinned`);
      assert.match(rest, /#\s*v\d/, `${file}: ${target} has no version comment`);
    }
  }
  // If no `uses:` line ever matched, the loop above ran zero assertions and
  // this test would pass whether or not any action is actually pinned.
  assert.ok(matched > 0, "no uses: line was scanned across the workflow files");
});

test("no workflow uses pull_request_target", () => {
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /pull_request_target/, file);
  }
});

test("no run step interpolates inputs, event data or the head branch directly", () => {
  let scanned = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const runBlocks = text.match(/run: [|>]?[^\n]*(\n\s{10,}[^\n]*)*/g) ?? [];
    for (const block of runBlocks) {
      scanned++;
      assert.doesNotMatch(
        block,
        /\$\{\{\s*(inputs\.|github\.event\.|github\.head_ref)/,
        `${file}: ${block}`,
      );
    }
  }
  // Same vacuous-pass guard: no run: block found means nothing was checked.
  assert.ok(scanned > 0, "no run: block was scanned across the workflow files");
});

test("nothing calls the auto-merge workflow by local path", () => {
  // A ./ call runs the PR head's version of a workflow that holds write access.
  for (const file of files) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /uses:\s*\.\/\.github\/workflows\/dependabot-automerge\.yml/,
      file,
    );
  }
});

test("dependabot-automerge.yml sets a per-PR concurrency group that does not cancel in progress", () => {
  const text = readFileSync(".github/workflows/dependabot-automerge.yml", "utf8");
  const match = text.match(/^concurrency:\n((?:^ {2}.*\n?)+)/m);
  assert.ok(match, "no concurrency block found");
  assert.match(match[1], /group:.*github\.event\.pull_request\.number/);
  assert.match(match[1], /cancel-in-progress:\s*false/);
});

// fetch-metadata fails its step on an unverified or non-Dependabot commit, so
// the decision step must still run and turn off auto-merge an earlier run enabled.
test("dependabot-automerge.yml runs the decision even when fetch-metadata fails", () => {
  const text = readFileSync(".github/workflows/dependabot-automerge.yml", "utf8");
  const step = text.match(/- name: Merge when safe\r?\n((?: {8}.*\r?\n?)+)/);
  assert.ok(step, "no Merge when safe step found");
  assert.match(step[1], /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m);
});

// The rest of this file guards what Global Constraints promise for every
// workflow, so a new workflow cannot quietly drop them.
const workflows = readdirSync(".github/workflows").map((f) => join(".github/workflows", f));
const readWorkflow = (file) => readFileSync(file, "utf8");

// The jobs: block as { name, body } pairs; body holds the job's indented lines.
function jobsOf(file) {
  const section = readWorkflow(file).split(/^jobs:\r?\n/m)[1] ?? "";
  const out = [];
  for (const line of section.split(/\r?\n/)) {
    const head = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (head) out.push({ name: head[1], body: "" });
    else if (out.length) out.at(-1).body += `${line}\n`;
  }
  return out;
}

test("every workflow grants only contents: read at the top level", () => {
  // The line after `contents: read` must not be another permission.
  for (const file of workflows) {
    assert.match(readWorkflow(file), /^permissions:\r?\n {2}contents: read\r?\n(?! )/m, file);
  }
});

test("every job that runs steps has a 10 or 30 minute timeout; CodeQL's analyze gets 60", () => {
  let checked = 0;
  for (const file of workflows) {
    for (const job of jobsOf(file)) {
      if (!/^ {4}runs-on:/m.test(job.body)) continue;
      checked++;
      // A cold CodeQL analysis of a C# tree can outrun 30 minutes; the spec gives it 60.
      const minutes = file.endsWith("codeql.yml") && job.name === "analyze" ? "60" : "(10|30)";
      assert.match(
        job.body,
        new RegExp(`^ {4}timeout-minutes: ${minutes}$`, "m"),
        `${file}: job ${job.name}`,
      );
    }
  }
  assert.ok(checked > 0, "no job with runs-on was scanned");
});

test("every workflow that runs steps turns telemetry off", () => {
  for (const file of workflows) {
    if (!/^ {4}runs-on:/m.test(readWorkflow(file))) continue;
    for (const name of [
      "DOTNET_CLI_TELEMETRY_OPTOUT",
      "ASTRO_TELEMETRY_DISABLED",
      "WRANGLER_SEND_METRICS",
    ]) {
      assert.match(readWorkflow(file), new RegExp(`^\\s+${name}:`, "m"), `${file}: ${name}`);
    }
  }
});

test("every reusable workflow fetches Ward's tools at its own commit", () => {
  let checked = 0;
  for (const file of workflows) {
    if (!/^ {2}workflow_call:/m.test(readWorkflow(file))) continue;
    checked++;
    assert.match(readWorkflow(file), /repository: \$\{\{ job\.workflow_repository \}\}/, file);
    assert.match(readWorkflow(file), /ref: \$\{\{ job\.workflow_sha \}\}/, file);
  }
  assert.equal(checked, 4, "ci.yml, codeql.yml, dependabot-automerge.yml and repo-hygiene.yml");
});

// secrets.NAME, secrets['NAME'] and a reusable call with `secrets: inherit`
// all hand a secret to the job.
const READS_SECRET = /secrets(\.|\[|:\s*inherit)/;

test("the secret detector sees every way a workflow can read a secret", () => {
  for (const text of [
    "token: secrets.WARD_AUDIT_TOKEN",
    "token: secrets['WARD_AUDIT_TOKEN']",
    "    secrets: inherit",
  ]) {
    assert.match(text, READS_SECRET);
  }
  assert.doesNotMatch("# this workflow reads no secrets", READS_SECRET);
});

test("a workflow that reads a secret runs only on a schedule or by hand", () => {
  let checked = 0;
  for (const file of workflows) {
    if (!READS_SECRET.test(readWorkflow(file))) continue;
    checked++;
    const on = readWorkflow(file).match(/^on:\r?\n((?: {2}.*\r?\n?)+)/m)?.[1] ?? "";
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(triggers, ["schedule", "workflow_dispatch"], file);
  }
  assert.equal(checked, 1, "repo-audit.yml is the one workflow that reads a secret");
});

test("the canary calls the published @v1 for the good fixtures and the v1 tag's fixture suite for the broken ones", () => {
  const text = readWorkflow(".github/workflows/canary.yml");
  assert.match(text, /^ {4}uses: malinfossum\/ward\/\.github\/workflows\/ci\.yml@v1$/m);
  assert.doesNotMatch(
    text,
    /uses: \.\/\.github\/workflows\//,
    "the canary must test the tag, not this checkout",
  );
  assert.match(text, /node: fixtures\/node-ok/);
  assert.match(text, /dotnet: fixtures\/dotnet-ok/);
  assert.match(text, /^ {10}ref: v1$/m);
  assert.match(text, /npm run test:fixtures/);
  assert.match(text, /node tools\/watchdog\.mjs repo-audit\.yml/);
  const on = text.match(/^on:\r?\n((?: {2}.*\r?\n?)+)/m)?.[1] ?? "";
  for (const trigger of ["schedule", "release", "workflow_dispatch"]) {
    assert.match(on, new RegExp(`^ {2}${trigger}:`, "m"), trigger);
  }
  assert.match(on, /types: \[published\]/);
  // A tag push would hand identity the old tag object as `before`, which the
  // checkout cannot fetch once v1 has moved; a release has no `before`.
  assert.doesNotMatch(on, /pull_request|push:/);
});

// ci.yml's node job runs `npm ci` and caches on <dir>/package-lock.json, so a
// fixture named as a `node:` input without a lock file fails before any check runs.
test("every node fixture a Ward caller names has a package-lock.json", () => {
  let checked = 0;
  for (const file of [".github/workflows/canary.yml", ".github/workflows/ward.yml"]) {
    for (const match of readWorkflow(file).matchAll(/^\s+node: (fixtures\/\S+)$/gm)) {
      checked++;
      assert.ok(
        existsSync(join(match[1], "package-lock.json")),
        `${file}: ${match[1]} has no lock file`,
      );
    }
  }
  assert.ok(checked > 0, "no fixture node input found");
});

test("the gate fails on a failed or cancelled module and lets a skipped one through", () => {
  const gate = jobsOf(".github/workflows/ci.yml").find((job) => job.name === "gate");
  assert.ok(gate, "no gate job in ci.yml");
  assert.match(gate.body, /needs: \[identity, node, dotnet\]/);
  assert.match(gate.body, /if: always\(\)/);
  assert.match(
    gate.body,
    /contains\(needs\.\*\.result, 'failure'\) \|\| contains\(needs\.\*\.result, 'cancelled'\)/,
  );
  assert.doesNotMatch(gate.body, /'skipped'/);
});

test("Ward's own auto-merge job pins a released commit and runs only for Dependabot PRs", () => {
  const job = jobsOf(".github/workflows/ward.yml").find((j) => j.name === "automerge");
  assert.ok(job, "no automerge job in ward.yml");
  assert.match(
    job.body,
    /^ {4}uses: malinfossum\/ward\/\.github\/workflows\/dependabot-automerge\.yml@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m,
  );
  assert.match(
    job.body,
    /^ {4}if: github\.event_name == 'pull_request' && github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'$/m,
  );
  assert.match(job.body, /^ {6}contents: write$/m);
  assert.match(job.body, /^ {6}pull-requests: write$/m);
  // Not asserted: that the template pins the same release. Dependabot bumps
  // ward.yml alone, and that PR must stay green so I can merge it.
});

test("no template carries an em dash", () => {
  for (const file of readdirSync("templates")) {
    const emDash = new RegExp(String.fromCharCode(0x2014));
    assert.doesNotMatch(readFileSync(join("templates", file), "utf8"), emDash, file);
  }
});

const CODEQL = ".github/workflows/codeql.yml";

test("codeql.yml analyses every language buildless and runs nothing else where it can write", () => {
  const text = readWorkflow(CODEQL);
  const inits = text.split(/^ {6}- /m).filter((step) => /codeql-action\/init@/.test(step));
  assert.ok(inits.length > 0, "no init step found");
  for (const step of inits) assert.match(step, /^ {10}build-mode: none$/m);
  const analyze = jobsOf(CODEQL).find((job) => job.name === "analyze");
  assert.ok(analyze, "no analyze job in codeql.yml");
  assert.doesNotMatch(analyze.body, /^\s*(- )?run:/m);
  assert.doesNotMatch(analyze.body, /autobuild/);
  const steps = [...analyze.body.matchAll(/^ {6}- (\S+):\s*([^@\s]+)/gm)].map(
    (m) => `${m[1]} ${m[2]}`,
  );
  assert.deepEqual(steps, [
    "uses actions/checkout",
    "uses github/codeql-action/init",
    "uses github/codeql-action/analyze",
  ]);
  assert.match(analyze.body, /^ {10}persist-credentials: false$/m);
  assert.match(analyze.body, /^ {10}category: "\/language:\$\{\{ matrix\.language \}\}"$/m);
  // init and analyze must run the same CodeQL; Dependabot bumps them together.
  const pins = [...text.matchAll(/github\/codeql-action\/\w+@([0-9a-f]{40})/g)].map((m) => m[1]);
  assert.equal(pins.length, 2);
  assert.equal(new Set(pins).size, 1, "init and analyze pin different commits");
});

test("codeql.yml holds security-events: write on analyze alone, fed by the languages job", () => {
  const text = readWorkflow(CODEQL);
  assert.match(text, /^ {2}workflow_call:\s*$/m);
  assert.doesNotMatch(text, /^ {4}inputs:/m, "codeql.yml takes no inputs");
  // Comments may name the permission; only YAML lines grant it.
  const code = (yaml) => yaml.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(code(text.split(/^jobs:/m)[0]), /security-events/);
  const jobs = jobsOf(CODEQL);
  assert.deepEqual(
    jobs.map((job) => job.name),
    ["languages", "analyze"],
  );
  const [languages, analyze] = jobs;
  assert.doesNotMatch(code(languages.body), /security-events/);
  assert.match(languages.body, /^ {6}languages: \$\{\{ steps\.detect\.outputs\.languages \}\}$/m);
  assert.match(languages.body, /run: node "\$RUNNER_TEMP\/ward\/tools\/codeql-languages\.mjs"/);
  assert.match(
    analyze.body,
    /^ {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}security-events: write\n(?! {6})/m,
  );
  assert.match(analyze.body, /^ {4}needs: languages$/m);
  assert.match(analyze.body, /^ {6}fail-fast: false$/m);
  assert.match(
    analyze.body,
    /^ {8}language: \$\{\{ fromJSON\(needs\.languages\.outputs\.languages\) \}\}$/m,
  );
});

test("only Ward's own ward.yml calls codeql.yml by local path, with what analyze needs", () => {
  for (const file of files) {
    if (file.replaceAll("\\", "/") === ".github/workflows/ward.yml") continue;
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /uses:\s*\.\/\.github\/workflows\/codeql\.yml/,
      file,
    );
  }
  const job = jobsOf(".github/workflows/ward.yml").find((j) => j.name === "codeql");
  assert.ok(job, "no codeql job in ward.yml");
  assert.match(job.body, /^ {4}uses: \.\/\.github\/workflows\/codeql\.yml$/m);
  for (const line of ["actions: read", "contents: read", "security-events: write"]) {
    assert.match(job.body, new RegExp(`^ {6}${line}$`, "m"), line);
  }
});
