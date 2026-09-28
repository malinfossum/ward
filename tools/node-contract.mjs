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
