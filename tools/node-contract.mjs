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
// --apply are Biome's and Prettier's, and -w is Prettier's short --write, so it
// counts only inside a prettier command (npm's -w is a workspace).
const LONG_FIX = /(?:^|\s)--(?:fix|write|apply)(?!\w|=false)/;
const PRETTIER_W = /\bprettier\b.*\s-w(?!\S)/;
const segments = (cmd) => cmd.split(/&&|\|\||[;|]/);
const fixes = (cmd) =>
  typeof cmd === "string" && segments(cmd).some((s) => LONG_FIX.test(s) || PRETTIER_W.test(s));

// lint, lint:* and their pre and post hooks: a lint runner usually reaches
// them in ways no parser here follows (concurrently, sh -c, pnpm). A :fix
// script is the fixing variant on purpose and counts only when lint runs it.
const LINT_FAMILY = /^(?:pre|post)?lint(?::|$)/;
const FIX_VARIANT = /(?:^|:)fix(?::|$)/;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

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

// The scripts a command runs: `<npm|pnpm|yarn|bun> [flags] run x`, the
// arguments of run-s, run-p and npm-run-all up to their `--`, concurrently's
// npm:<script>, and a quoted command (concurrently "npm run a", sh -c '...').
function calledScripts(cmd, names) {
  const called = [];
  const matching = (glob) => {
    const pattern = globToRegex(glob);
    return names.filter((name) => pattern.test(name));
  };
  for (const part of segments(cmd)) {
    const raw = part.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const words = raw.map((w) => w.replace(/^["']|["']$/g, ""));
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (/^["']/.test(raw[i]) && /\s/.test(word)) called.push(...calledScripts(word, names));
      if (word.startsWith("npm:")) called.push(...matching(word.slice(4)));
      if (RUNNERS.has(word)) {
        const rest = words.slice(i + 1).filter((w) => !w.startsWith("-"));
        if ((rest[0] === "run" || rest[0] === "run-script") && rest[1]) {
          called.push(...matching(rest[1]));
        }
      }
      if (["run-s", "run-p", "npm-run-all"].includes(word)) {
        for (const arg of words.slice(i + 1)) {
          if (arg === "--") break;
          if (arg.startsWith("-")) continue;
          // "build-only {@}": the first word is the script, the rest its arguments.
          called.push(...matching(arg.split(/\s+/)[0]));
        }
      }
    }
  }
  return called;
}

// The scripts that fix instead of report and that `npm run lint` runs or
// likely runs: the lint family by name, plus every script lint reaches
// (npm's pre and post hooks around each, and the scripts it calls), so a
// lint:fix that lint does run is caught. In package.json order.
export function fixingLint(scripts) {
  const names = Object.keys(scripts);
  const family = names.filter((n) => LINT_FAMILY.test(n) && !FIX_VARIANT.test(n));
  const flagged = new Set(family);
  const reached = new Set();
  // Start from lint and the rest of the family, since lint likely runs them too.
  const queue = ["lint", ...family].map((name) => ({ name, hook: false }));
  while (queue.length) {
    const { name, hook } = queue.shift();
    if (!Object.hasOwn(scripts, name) || reached.has(name)) continue;
    reached.add(name);
    flagged.add(name);
    // npm runs prelint and postlint, but never a hook's own hooks.
    if (!hook) queue.push({ name: `pre${name}`, hook: true }, { name: `post${name}`, hook: true });
    if (typeof scripts[name] === "string") {
      queue.push(...calledScripts(scripts[name], names).map((n) => ({ name: n, hook: false })));
    }
  }
  return names.filter((name) => flagged.has(name) && fixes(scripts[name]));
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
