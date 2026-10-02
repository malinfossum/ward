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

test("every job that runs steps has a 10 or 30 minute timeout", () => {
  let checked = 0;
  for (const file of workflows) {
    for (const job of jobsOf(file)) {
      if (!/^ {4}runs-on:/m.test(job.body)) continue;
      checked++;
      assert.match(job.body, /^ {4}timeout-minutes: (10|30)$/m, `${file}: job ${job.name}`);
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
  assert.equal(checked, 3, "ci.yml, dependabot-automerge.yml and repo-hygiene.yml");
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
