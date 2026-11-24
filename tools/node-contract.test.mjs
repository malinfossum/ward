import assert from "node:assert/strict";
import { test } from "node:test";
import { fixingLint, planSteps } from "./node-contract.mjs";

test("the lint family is flagged by name when it fixes, whatever runs it", () => {
  const scripts = {
    lint: 'concurrently "npm:lint:*"',
    "lint:oxlint": "oxlint . --fix",
    "lint:eslint": "eslint . --fix-dry-run --cache",
    "lint:biome": "biome check --write .",
    "lint:old": "biome check --apply",
    "prelint:css": "stylelint --fix",
    fix: "eslint . --fix",
    "format:lint": "prettier --write .",
  };
  assert.deepEqual(fixingLint(scripts), [
    "lint:oxlint",
    "lint:eslint",
    "lint:biome",
    "lint:old",
    "prelint:css",
  ]);
});

test("a :fix variant counts only when lint runs it", () => {
  const helper = { lint: "eslint .", "lint:fix": "eslint . --fix", "lint:js:fix": "eslint --fix" };
  assert.deepEqual(fixingLint(helper), []);
  const globbed = { lint: 'run-s "lint:*"', "lint:fix": "eslint . --fix" };
  assert.deepEqual(fixingLint(globbed), ["lint:fix"]);
});

test("npm's pre and post hooks and run chains reach scripts outside the family", () => {
  const scripts = {
    lint: "pnpm --silent run format && eslint .",
    format: "prettier -w .",
    postformat: "biome format --write .",
    postpostformat: "eslint --fix",
    style: "stylelint --fix",
    "lint:all": 'concurrently "npm run style" \'sh -c "npm run types"\'',
    types: "tsc --noEmit",
  };
  // postpostformat is a hook's hook, which npm never runs.
  assert.deepEqual(fixingLint(scripts), ["format", "postformat", "style"]);
});

test("run-p with arguments and --; * stays in one segment, ** crosses them", () => {
  const scripts = {
    lint: 'run-p "check:* {@}" "deep:** {@}" --',
    "check:css:deep": "stylelint --fix",
    "deep:css:deep": "stylelint --fix",
    "check:js": "eslint .",
  };
  assert.deepEqual(fixingLint(scripts), ["deep:css:deep"]);
});

test("a check-only lint passes, and look-alike flags are no fix", () => {
  const scripts = {
    lint: 'run-s "lint:*"',
    "lint:eslint": "eslint . --cache --fix=false",
    "lint:fixtures": "node check.mjs --fixtures",
    "lint:fixed": "tool --fixed-width",
    "lint:watch": "tsc -w",
    "lint:prettier": "prettier --check . && npm run lint -w packages/app",
    "lint:bad": null,
  };
  assert.deepEqual(fixingLint(scripts), []);
});

const base = {
  scripts: { lint: "x", test: "x" },
  files: ["package.json"],
  a11y: "off",
  hasPlaywright: false,
};
const names = (plan) => plan.steps.map((s) => s.name);

test("plain JS runs lint and test", () => {
  const plan = planSteps(base);
  assert.deepEqual(names(plan), ["lint", "test"]);
  assert.deepEqual(plan.missing, []);
});

test("a missing test script is reported", () => {
  const plan = planSteps({ ...base, scripts: { lint: "x" } });
  assert.deepEqual(plan.missing, ["test"]);
});

test("tsconfig.json requires typecheck", () => {
  const plan = planSteps({ ...base, files: ["package.json", "tsconfig.json"] });
  assert.deepEqual(plan.missing, ["typecheck"]);
});

test("an Astro config requires typecheck", () => {
  const plan = planSteps({ ...base, files: ["astro.config.mjs"] });
  assert.deepEqual(plan.missing, ["typecheck"]);
});

test("a wrangler config requires deploy:check", () => {
  const plan = planSteps({ ...base, files: ["wrangler.jsonc"] });
  assert.deepEqual(plan.missing, ["deploy:check"]);
});

test("steps run in contract order, with one browser install", () => {
  const scripts = {
    "test:a11y": "x",
    "test:e2e": "x",
    "deploy:check": "x",
    build: "x",
    test: "x",
    typecheck: "x",
    lint: "x",
  };
  const plan = planSteps({ ...base, scripts, a11y: "strict", hasPlaywright: true });
  assert.deepEqual(names(plan), [
    "lint",
    "typecheck",
    "test",
    "build",
    "deploy:check",
    "playwright browsers",
    "test:e2e",
    "test:a11y",
  ]);
});

test("test:e2e runs whenever it exists and never goes soft", () => {
  for (const a11y of ["off", "warn"]) {
    const plan = planSteps({ ...base, scripts: { ...base.scripts, "test:e2e": "x" }, a11y });
    const e2e = plan.steps.find((s) => s.name === "test:e2e");
    assert.equal(e2e?.soft, false, a11y);
  }
});

test("a11y off skips test:a11y even when it exists", () => {
  const plan = planSteps({ ...base, scripts: { ...base.scripts, "test:a11y": "x" } });
  assert.deepEqual(names(plan), ["lint", "test"]);
});

test("a11y warn makes test:a11y soft", () => {
  const plan = planSteps({ ...base, scripts: { ...base.scripts, "test:a11y": "x" }, a11y: "warn" });
  const a11y = plan.steps.find((s) => s.name === "test:a11y");
  assert.equal(a11y.soft, true);
});

test("a11y strict without test:a11y is reported", () => {
  assert.deepEqual(planSteps({ ...base, a11y: "strict" }).missing, ["test:a11y"]);
});

test("an unknown a11y mode throws", () => {
  assert.throws(() => planSteps({ ...base, a11y: "loud" }), /off, warn or strict/);
});
