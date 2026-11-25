// Runs the npm script contract for the node module. Which scripts are required
// depends on what the repo contains.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { git } from "./git.mjs";

const MODES = new Set(["off", "warn", "strict"]);

export function planSteps({ scripts, files, a11y, hasPlaywright }) {
  if (!MODES.has(a11y)) throw new Error(`a11y must be off, warn or strict, got "${a11y}"`);
  const has = (name) => Object.hasOwn(scripts, name);
  const typed = files.includes("tsconfig.json") || files.some((f) => /^astro\.config\./.test(f));
  const worker = files.some((f) => /^wrangler\.(toml|json|jsonc)$/.test(f));

  // Functional e2e always fails the gate; the a11y mode softens only test:a11y.
  const contract = [
    { script: "lint", required: true },
    { script: "typecheck", required: typed },
    { script: "test", required: true },
    { script: "build", required: false },
    { script: "deploy:check", required: worker },
    { script: "test:e2e", required: false, browser: true },
    {
      script: "test:a11y",
      required: a11y !== "off",
      soft: a11y === "warn",
      skip: a11y === "off",
      browser: true,
    },
  ];

  const missing = contract.filter((c) => c.required && !has(c.script)).map((c) => c.script);
  const steps = [];
  let browsers = false;
  for (const c of contract) {
    if (c.skip || !has(c.script)) continue;
    if (c.browser && hasPlaywright && !browsers) {
      steps.push({
        name: "playwright browsers",
        cmd: "npx playwright install --with-deps --only-shell chromium",
        soft: false,
      });
      browsers = true;
    }
    steps.push({ name: c.script, cmd: `npm run ${c.script}`, soft: Boolean(c.soft) });
  }
  return { steps, missing };
}

// The tracked files that differ from the index, each with a hash of what is on
// disk now (null for one that is gone), keyed by its path from the top of the
// work tree: { files }. When git cannot read a work tree at dir (none there, no
// git, a container's dubious ownership), { reason } says why.
export function trackedChanges(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return { reason: why(top) };
  const root = top.stdout.trim();
  const diff = git(dir, ["diff", "--name-only", "-z"]);
  if (diff.status !== 0) return { reason: why(diff) };
  const names = diff.stdout.split("\0").filter(Boolean);
  return { files: new Map(names.map((name) => [name, hashOf(join(root, name))])) };
}

const why = (result) =>
  result.error?.message || result.stderr.trim().split("\n")[0] || `git exited ${result.status}`;

// A submodule shows up as a folder; its commit and its own diff say what changed in it.
function hashOf(path) {
  try {
    if (statSync(path).isDirectory()) {
      const state = git(path, ["rev-parse", "HEAD"]).stdout + git(path, ["diff", "HEAD"]).stdout;
      return `dir:${createHash("sha256").update(state).digest("hex")}`;
    }
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

// The paths whose state differs between two trackedChanges snapshots, so a
// file that was already changed before lint counts only if lint changed it again.
export function rewritten(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

const SHOWN = 10;

// A lint that fixes what it finds instead of reporting it lets CI pass with
// fixable errors still in the committed code. Whatever runner or flag does
// it, the fix shows up as a changed tracked file; caches and other untracked
// files are fine. A fix that writes nothing (--fix-dry-run) is not seen.
function lintCheck(before, after) {
  const reason = before.reason ?? after.reason;
  if (reason) {
    return {
      notice: `git cannot read a work tree here (${reason}), so the gate cannot see whether npm run lint changed files`,
    };
  }
  const changed = rewritten(before.files, after.files);
  if (!changed.length) return {};
  const more = changed.length > SHOWN ? ` and ${changed.length - SHOWN} more` : "";
  const list = changed.slice(0, SHOWN).join(", ") + more;
  return {
    error: `npm run lint changed ${list}: it fixes problems instead of reporting them, so CI passes with fixable errors still in the code. Make lint check-only and move the fixing command to a script lint does not run, such as "fix"`,
  };
}

function main() {
  const dir = process.argv[2] ?? ".";
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const { steps, missing } = planSteps({
    scripts: pkg.scripts ?? {},
    files: readdirSync(dir),
    a11y: process.env.A11Y ?? "off",
    hasPlaywright: "@playwright/test" in deps,
  });

  let failed = 0;
  for (const script of missing) {
    console.log(`::error::package.json has no "${script}" script, which this repo needs`);
    failed++;
  }
  for (const step of steps) {
    const before = step.name === "lint" ? trackedChanges(dir) : undefined;
    console.log(`::group::${step.name}`);
    // The commands are fixed strings from the contract; npm needs a shell on Windows.
    const { status } = spawnSync(step.cmd, { cwd: dir, stdio: "inherit", shell: true });
    console.log("::endgroup::");
    if (step.name === "lint") {
      const { notice, error } = lintCheck(before, trackedChanges(dir));
      if (notice) console.log(`::notice::${notice}`);
      if (error) {
        console.log(`::error::${error}`);
        failed++;
      }
    }
    if (status === 0) continue;
    if (step.soft) {
      console.log(`::warning::${step.name} failed (a11y is in warn mode)`);
    } else {
      console.log(`::error::${step.name} failed`);
      failed++;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
