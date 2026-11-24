// Runs the npm script contract for the node module. Which scripts are required
// depends on what the repo contains.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

// Flags that make a linter fix what it finds instead of reporting it: CI then
// passes with fixable errors still in the committed code. --fix also covers
// --fix-type, --fix-dangerously and --fix-dry-run (that one writes nothing, but
// leaves fixable errors out of the exit code); --fix=false is off. --write and
// --apply are Biome's and Prettier's, and -w is Prettier's short --write.
const FIXES = /(?:^|\s)--(?:fix|write|apply)(?!\w|=false)|\bprettier\b.*\s-w(?!\S)/;

// A run-s / run-p / npm-run-all pattern as a regex: * matches within one
// `:` segment, ** across segments.
function globToRegex(glob) {
  const body = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^:]*"),
    )
    .join(".*");
  return new RegExp(`^${body}$`);
}

// The scripts a command runs: `npm run x`, `npm run-script x`, and the
// arguments of run-s, run-p and npm-run-all, up to their `--`.
function calledScripts(cmd, names) {
  const called = [];
  for (const part of cmd.split(/&&|\|\||[;|]/)) {
    const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) =>
      w.replace(/^["']|["']$/g, ""),
    );
    for (let i = 0; i < words.length; i++) {
      if (words[i] === "npm" && (words[i + 1] === "run" || words[i + 1] === "run-script")) {
        const name = words.slice(i + 2).find((w) => !w.startsWith("-"));
        if (name) called.push(name);
      }
      if (["run-s", "run-p", "npm-run-all"].includes(words[i])) {
        for (const arg of words.slice(i + 1)) {
          if (arg === "--") break;
          if (arg.startsWith("-")) continue;
          // "build-only {@}": the first word is the script, the rest its arguments.
          const pattern = globToRegex(arg.split(/\s+/)[0]);
          called.push(...names.filter((name) => pattern.test(name)));
        }
      }
    }
  }
  return called;
}

// The scripts `npm run lint` reaches that fix instead of report: lint itself,
// npm's pre and post hooks around each script it runs, and the scripts it
// calls. A lint:fix helper that lint never runs is not flagged.
export function fixingLint(scripts) {
  const names = Object.keys(scripts);
  const reached = [];
  const queue = ["lint"];
  while (queue.length) {
    const name = queue.shift();
    if (!Object.hasOwn(scripts, name) || reached.includes(name)) continue;
    reached.push(name);
    queue.push(`pre${name}`, `post${name}`, ...calledScripts(scripts[name], names));
  }
  return reached.filter((name) => FIXES.test(scripts[name]));
}

function main() {
  const dir = process.argv[2] ?? ".";
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const { steps, missing } = planSteps({
    scripts,
    files: readdirSync(dir),
    a11y: process.env.A11Y ?? "off",
    hasPlaywright: "@playwright/test" in deps,
  });

  let failed = 0;
  for (const script of missing) {
    console.log(`::error::package.json has no "${script}" script, which this repo needs`);
    failed++;
  }
  for (const script of fixingLint(scripts)) {
    console.log(
      `::error::the "${script}" script fixes problems instead of reporting them, so CI passes with fixable errors still in the code. Make it check-only and move the fixing command to a script lint does not run, such as "fix"`,
    );
    failed++;
  }
  for (const step of steps) {
    console.log(`::group::${step.name}`);
    // The commands are fixed strings from the contract; npm needs a shell on Windows.
    const { status } = spawnSync(step.cmd, { cwd: dir, stdio: "inherit", shell: true });
    console.log("::endgroup::");
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
