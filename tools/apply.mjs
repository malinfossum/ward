// Applies the Ward standard to one repo: the files it carries (the caller,
// the Dependabot config, Directory.Build.props, the npm scripts the node
// contract needs) and the settings GitHub holds for it (Dependabot, secret
// scanning, CodeQL, the ruleset on the default branch, auto-merge). Every
// command prints what it would do and changes nothing until --apply. The
// ward skill in loadout drives it; by hand: node tools/apply.mjs <command>.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planSteps } from "./node-contract.mjs";
import { exceptionsFor, parseCaller } from "./repo-audit.mjs";
import { detectStacks, ignored, loadStacks } from "./stacks.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CALLER = ".github/workflows/ward.yml";
export const DEPENDABOT = ".github/dependabot.yml";
export const PROPS = "Directory.Build.props";
const DEFAULTS = {
  node: "",
  dotnet: "",
  "dotnet-os": "ubuntu-latest",
  "dotnet-ef-project": "",
  "dotnet-ef-startup-project": "",
};

const depth = (path) => path.split("/").length;
export const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
const asDirectory = (dir) => (dir === "." ? "/" : `/${dir}`);

// Any EF Core package except Design and Tools, which only the tooling needs.
const EF_PACKAGE = /Microsoft\.EntityFrameworkCore(?:\.(?!(?:Design|Tools)\b)[\w.]+)?(?![\w.])/;
const EF_DESIGN = /Microsoft\.EntityFrameworkCore\.Design(?![\w.])/;

// The shallowest of the candidates; a tie is a stop, because the choice is
// then mine, not the script's.
function pickOne(paths, what, module, stops) {
  if (paths.length === 0) return "";
  const top = Math.min(...paths.map(depth));
  const shallowest = paths.filter((path) => depth(path) === top);
  if (shallowest.length === 1) return shallowest[0];
  const text = `More than one ${what} at the same depth (${shallowest.join(", ")}); set that input yourself.`;
  stops.push({ module, text });
  return "";
}

// The caller inputs and the Dependabot blocks a tree needs. paths are
// repo-relative with forward slashes; csproj holds the text of every .csproj
// in paths, by path. A planned stack is reported as uncovered, never guessed.
// Each stop names the module (node or dotnet) whose choice it blocks.
export function planInputs(paths, csproj, stacks) {
  const stops = [];
  const kept = paths.filter((path) => !ignored(path, stacks.ignore));
  const detected = detectStacks(kept, stacks);
  const filesOf = (name) => detected.find((stack) => stack.name === name)?.files ?? [];
  const uncovered = detected.filter((stack) => stack.status !== "shipped").map((s) => s.name);

  const manifests = filesOf("node");
  const manifest = pickOne(manifests, "package.json", "node", stops);
  const solutions = filesOf("dotnet").filter((path) => /\.slnx?$/.test(path));
  const projects = filesOf("dotnet").filter((path) => path.endsWith(".csproj"));
  const dotnet = solutions.length
    ? pickOne(solutions, "solution file", "dotnet", stops)
    : pickOne(projects, "project file with no solution above it", "dotnet", stops);
  const text = (path) => csproj[path] ?? "";
  const wpf = projects.some((path) => /<UseWPF>\s*true\s*<\/UseWPF>/i.test(text(path)));

  // The project with the DbContext packages is the EF project; the one with
  // Design is the startup project when it is a different project. A repo with
  // only a Design reference has one project doing both jobs.
  const withEf = projects.filter((path) => EF_PACKAGE.test(text(path)));
  const withDesign = projects.filter((path) => EF_DESIGN.test(text(path)));
  const efPick = pickOne(
    withEf,
    "project referencing Microsoft.EntityFrameworkCore",
    "dotnet",
    stops,
  );
  const designPick = pickOne(
    withDesign,
    "project referencing Microsoft.EntityFrameworkCore.Design",
    "dotnet",
    stops,
  );
  const ef = withEf.length ? efPick : designPick;
  const startup = ef && designPick && designPick !== ef ? designPick : "";

  const inputs = {
    node: manifest ? dirOf(manifest) : "",
    dotnet,
    "dotnet-os": wpf ? "windows-latest" : "ubuntu-latest",
    "dotnet-ef-project": ef ? dirOf(ef) : "",
    "dotnet-ef-startup-project": startup ? dirOf(startup) : "",
  };
  const ecosystems = [{ ecosystem: "github-actions", directory: "/" }];
  for (const path of manifests) {
    ecosystems.push({ ecosystem: "npm", directory: asDirectory(dirOf(path)) });
  }
  // Dependabot looks only in the directory a block names, so the nuget block
  // sits beside the solution and a nested global.json, Dockerfile or
  // pyproject.toml gets a block of its own (varde keeps global.json under api/).
  const dirs = (files) => [...new Set(files.map((path) => dirOf(path)))];
  if (dotnet) ecosystems.push({ ecosystem: "nuget", directory: asDirectory(dirOf(dotnet)) });
  for (const dir of dirs(kept.filter((path) => /(^|\/)global\.json$/.test(path)))) {
    ecosystems.push({ ecosystem: "dotnet-sdk", directory: asDirectory(dir) });
  }
  for (const [stack, ecosystem] of [
    ["docker", "docker"],
    ["python", "pip"],
  ]) {
    for (const dir of dirs(filesOf(stack))) {
      ecosystems.push({ ecosystem, directory: asDirectory(dir) });
    }
  }
  return { inputs, ecosystems, uncovered, stops };
}

// Fills the template's input lines. A quoted template value stays quoted, a
// bare one stays bare, and the comment keeps its column when the value fits.
export function renderCaller(template, inputs) {
  return template
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s+)([\w-]+):\s*("[^"]*"|[^\s#]*)\s*(#.*)?$/);
      if (!m || !Object.hasOwn(inputs, m[2])) return line;
      const quoted = m[3].startsWith('"');
      const value = quoted ? `"${inputs[m[2]]}"` : inputs[m[2]] || '""';
      const head = `${m[1]}${m[2]}: ${value}`;
      if (!m[4]) return head;
      return head.padEnd(Math.max(line.indexOf("#"), head.length + 1)) + m[4];
    })
    .join("\n");
}

// Keeps the template's header and one block per ecosystem entry, with its
// directory set; the comment lines above a block travel with it.
export function renderDependabot(template, ecosystems) {
  const [header, body] = template.split("updates:\n");
  const blocks = [];
  let current = null;
  let comments = [];
  for (const line of body.split("\n")) {
    const start = line.match(/^ {2}- package-ecosystem: (\S+)/);
    if (start) {
      current = { ecosystem: start[1], lines: [...comments, line] };
      comments = [];
      blocks.push(current);
    } else if (line.trim() === "") {
      current = null;
      comments = [];
    } else if (current) {
      current.lines.push(line);
    } else {
      comments.push(line);
    }
  }
  const chosen = ecosystems.flatMap(({ ecosystem, directory }) => {
    const block = blocks.find((b) => b.ecosystem === ecosystem);
    if (!block) return [];
    const lines = block.lines.map((l) => l.replace(/^( {4}directory: ).*$/, `$1${directory}`));
    return [lines.join("\n")];
  });
  const intro = header.replace(
    /^# Ward baseline\..*$/m,
    "# Ward baseline, written by the ward skill from the stacks in this repo.",
  );
  return `${intro}updates:\n${chosen.join("\n\n")}\n`;
}

export function readTemplates(root = ROOT) {
  return {
    caller: readFileSync(join(root, "templates", "ward.yml"), "utf8"),
    dependabot: readFileSync(join(root, "templates", "dependabot.yml"), "utf8"),
    props: readFileSync(join(root, "templates", PROPS)),
  };
}

const git = (dir, args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

// Inside a git work tree, the files git knows or would add (tracked, plus
// untracked that .gitignore does not hide), so an ignored .claude/worktrees
// copy or build output never counts. A plain directory is walked instead.
function gitFiles(dir) {
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]).status !== 0) return null;
  const listed = git(dir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (listed.status !== 0) return null;
  return [...new Set(listed.stdout.split("\0").filter(Boolean))].filter((path) => {
    try {
      return lstatSync(join(dir, path)).isFile();
    } catch {
      return false;
    }
  });
}

// Every file under dir as a repo-relative path with forward slashes, minus
// the prefixes stack detection ignores (node_modules, bin, obj, .git).
export function listTree(dir, stacks) {
  const walked = () =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  return (gitFiles(dir) ?? walked()).filter((path) => !ignored(path, stacks.ignore)).sort();
}

const SCRIPT_FOR = {
  lint: () => "biome ci .",
  typecheck: (deps) => ("astro" in deps ? "astro check" : "tsc --noEmit"),
  "deploy:check": () => "wrangler deploy --dry-run",
};

// The scripts the node contract requires and package.json lacks, with the
// standard command for each. test is never guessed: the runner is mine to
// pick. A note names the package a script needs; nothing is installed here.
export function missingScripts(pkg, files) {
  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const { missing } = planSteps({ scripts, files, a11y: "off", hasPlaywright: false });
  const add = {};
  const ask = [];
  const notes = [];
  for (const name of missing) {
    if (SCRIPT_FOR[name]) add[name] = SCRIPT_FOR[name](deps);
    else ask.push(name);
  }
  if (add.lint && !("@biomejs/biome" in deps)) {
    notes.push("lint runs Biome: add @biomejs/biome as a devDependency and a biome.json first.");
  }
  if (add.typecheck === "tsc --noEmit" && !("typescript" in deps)) {
    notes.push("typecheck runs tsc: add typescript as a devDependency first.");
  }
  if (add["deploy:check"] && !("wrangler" in deps)) {
    notes.push("deploy:check runs wrangler: add wrangler as a devDependency first.");
  }
  return { add, ask, notes };
}

// package.json with the scripts added, in the file's own indentation and
// line endings.
export function withScripts(text, add) {
  const pkg = JSON.parse(text);
  pkg.scripts = { ...(pkg.scripts ?? {}), ...add };
  const indent = text.match(/^(\t| +)"/m)?.[1] ?? "  ";
  const out = `${JSON.stringify(pkg, null, indent)}\n`;
  return text.includes("\r\n") ? out.replaceAll("\n", "\r\n") : out;
}

// A Windows checkout may hold CRLF where the template holds LF; that is not drift.
const lf = (text) => text.replaceAll("\r\n", "\n");

// `./web`, `web` and `web/` are one directory; `./` alone is the root.
const bare = (value) => (value ?? "").replace(/^\.\//, "").replace(/\/$/, "") || ".";
const sameDir = (a, b) => bare(a.replace(/^\//, "")) === bare(b.replace(/^\//, ""));

// `dotnet: "."` next to a planned `App.slnx` at the root is the same choice.
function sameInput(key, current, planned) {
  if (key === "dotnet-os") return (current || DEFAULTS[key]) === planned;
  if (!current && !planned) return true;
  if (!current || !planned) return false;
  if (bare(current) === bare(planned)) return true;
  return key === "dotnet" && bare(current) === bare(dirOf(planned));
}

// An input the caller leaves out counts as "", so a caller written before an
// input existed is kept while the files say "".
function planCaller(text, inputs, template) {
  if (text == null)
    return { path: CALLER, action: "create", content: renderCaller(template, inputs) };
  const current = parseCaller(lf(text));
  if (!current) {
    const detail = "does not call malinfossum/ward/.github/workflows/ci.yml@v1";
    return { path: CALLER, action: "drift", detail };
  }
  const drift = Object.keys(DEFAULTS)
    .filter((key) => !sameInput(key, current.inputs[key], inputs[key]))
    .map(
      (key) =>
        `${key} is "${current.inputs[key] ?? DEFAULTS[key]}", the files say "${inputs[key]}"`,
    );
  if (drift.length) return { path: CALLER, action: "drift", detail: drift.join("; ") };
  return { path: CALLER, action: "keep" };
}

function planDependabot(text, ecosystems, template) {
  if (text == null) {
    return { path: DEPENDABOT, action: "create", content: renderDependabot(template, ecosystems) };
  }
  const have = [];
  for (const line of lf(text).split("\n")) {
    const eco = line.match(/^\s*-\s*package-ecosystem:\s*"?([\w-]+)/);
    const dir = line.match(/^\s*directory:\s*"?([^"\s#]+)/);
    if (eco) have.push({ ecosystem: eco[1], directory: "/" });
    else if (dir && have.length) have[have.length - 1].directory = dir[1];
  }
  const missing = ecosystems.filter(
    (e) => !have.some((h) => h.ecosystem === e.ecosystem && sameDir(h.directory, e.directory)),
  );
  if (!missing.length) return { path: DEPENDABOT, action: "keep" };
  const detail = `no block for ${missing.map((e) => `${e.ecosystem} at ${e.directory}`).join(", ")}`;
  return { path: DEPENDABOT, action: "drift", detail };
}

// Turns off the shipped modules the repo keeps off on purpose (stacks.json
// exceptions): the planned input is "" and a note gives the reason. The EF
// inputs belong to dotnet and go with it.
function applyExceptions(inputs, stacks, exceptions, stops) {
  const notes = [];
  for (const module of stacks.modules) {
    const reason = exceptions[module.name];
    if (module.status !== "shipped" || !reason) continue;
    // A module whose choice was a stop has an empty input but is still detected.
    if (!inputs[module.input] && !stops.some((stop) => stop.module === module.name)) continue;
    inputs[module.input] = "";
    if (module.name === "dotnet") {
      inputs["dotnet-ef-project"] = "";
      inputs["dotnet-ef-startup-project"] = "";
    }
    notes.push(`${module.name} stays off: ${reason}`);
  }
  return notes;
}

// What the repo at dir should carry, and what it carries today. Nothing here
// overwrites: a file that exists and differs is drift for me to settle by
// hand, so a hand edit (a co-owner's address, a11y in warn) survives a rerun.
// exceptions names the modules that stay off for this repo, with the reason.
export function planFiles(
  dir,
  { stacks = loadStacks(), templates = readTemplates(), exceptions = {} } = {},
) {
  const paths = listTree(dir, stacks);
  const read = (path) => (paths.includes(path) ? readFileSync(join(dir, path), "utf8") : null);
  const csproj = Object.fromEntries(
    paths.filter((p) => p.endsWith(".csproj")).map((p) => [p, read(p)]),
  );
  const planned = planInputs(paths, csproj, stacks);
  const { inputs, ecosystems, uncovered } = planned;
  const files = [];
  const notes = applyExceptions(inputs, stacks, exceptions, planned.stops);
  // A module kept off on purpose has nothing to decide, so its stops go too.
  const stops = planned.stops.filter((stop) => !exceptions[stop.module]);
  files.push(planCaller(read(CALLER), inputs, templates.caller));
  files.push(planDependabot(read(DEPENDABOT), ecosystems, templates.dependabot));
  if (inputs.dotnet) {
    if (!paths.includes(PROPS)) {
      files.push({ path: PROPS, action: "create", content: templates.props });
    } else if (lf(templates.props.toString("utf8")) === lf(read(PROPS))) {
      files.push({ path: PROPS, action: "keep" });
    } else {
      files.push({ path: PROPS, action: "drift", detail: `differs from templates/${PROPS}` });
    }
  }
  if (inputs.node) {
    const manifest = inputs.node === "." ? "package.json" : `${inputs.node}/package.json`;
    const text = read(manifest);
    let pkg = null;
    try {
      pkg = JSON.parse(text);
    } catch {
      stops.push({ module: "node", text: `${manifest} is not valid JSON.` });
    }
    if (pkg) {
      const siblings = paths
        .filter((p) => dirOf(p) === inputs.node)
        .map((p) => p.slice(p.lastIndexOf("/") + 1));
      const { add, ask, notes: scriptNotes } = missingScripts(pkg, siblings);
      notes.push(...scriptNotes);
      const names = Object.keys(add);
      if (names.length) {
        const detail = `scripts: ${names.join(", ")}`;
        files.push({ path: manifest, action: "edit", detail, content: withScripts(text, add) });
      }
      for (const name of ask) {
        const detail = `add a "${name}" script; the runner is yours to choose`;
        files.push({ path: manifest, action: "ask", detail });
      }
      if (!names.length && !ask.length) files.push({ path: manifest, action: "keep" });
    }
  }
  return { inputs, ecosystems, uncovered, stops, files, notes };
}

// Writes the create and edit actions under dir; returns the paths written. A
// create uses the wx flag, so a file that exists is never overwritten even if
// it appeared after the plan was made. An edit changes package.json scripts.
// written fills as it goes, so a caller still has the paths done before a throw.
export function writeFiles(dir, plan, written = []) {
  for (const file of plan.files) {
    if (file.action !== "create" && file.action !== "edit") continue;
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, file.action === "create" ? { flag: "wx" } : undefined);
    written.push(file.path);
  }
  return written;
}

const say = (word, text) => `${word.padEnd(7)} ${text}`;
const arg = (argv, flag, fallback = "") => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

// owner/name from an origin URL (https or ssh); "" when it is not GitHub's.
export function repoFromRemote(url) {
  return url.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? "";
}

// The repo's full name: --repo when given, else the origin remote, else "".
function repoName(argv, dir) {
  const named = arg(argv, "--repo");
  if (named) return named;
  const remote = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" });
  return remote.status === 0 ? repoFromRemote(remote.stdout) : "";
}

function filesCommand(argv, { stacks, templates }) {
  const dir = arg(argv, "--dir", ".");
  if (!existsSync(dir))
    return { lines: [say("stop", `${dir} is not a directory I can read.`)], exitCode: 1 };
  const repo = repoName(argv, dir);
  const exceptions = repo ? exceptionsFor(repo, stacks) : {};
  const plan = planFiles(dir, { stacks, templates, exceptions });
  const lines = [];
  const shown = Object.entries(plan.inputs).map(([key, value]) => `${key}="${value}"`);
  lines.push(say("inputs", shown.join(" ")));
  for (const name of plan.uncovered) {
    const text = `${name} files found, but no Ward module covers them yet; draft the module as a PR to Ward.`;
    lines.push(say("warn", text));
  }
  for (const stop of plan.stops) lines.push(say("stop", stop.text));
  for (const file of plan.files) {
    lines.push(say(file.action, file.detail ? `${file.path}: ${file.detail}` : file.path));
  }
  for (const note of plan.notes) lines.push(say("note", note));
  if (plan.stops.length) return { lines, exitCode: 1 };
  if (argv.includes("--apply")) {
    const written = [];
    try {
      writeFiles(dir, plan, written);
    } catch (error) {
      for (const path of written) lines.push(say("wrote", path));
      lines.push(say("error", `Stopped writing: ${error.message}`));
      return { lines, exitCode: 1 };
    }
    for (const path of written) lines.push(say("wrote", path));
  }
  return { lines, exitCode: 0 };
}

export const USAGE = [
  "node tools/apply.mjs files [--dir <repo>] [--repo <owner/name>] [--apply]",
  "node tools/apply.mjs settings|ruleset|automerge|status <owner/repo> [--apply] [--bypass-admin] [--no-codeql]",
  "Settings commands read GITHUB_TOKEN (locally: GITHUB_TOKEN=$(gh auth token)).",
].join("\n");

// deps lets the tests pass their own stacks and templates.
export async function runApply(argv, _env, deps = {}) {
  const [command, ...rest] = argv;
  const stacks = deps.stacks ?? loadStacks();
  const templates = deps.templates ?? readTemplates();
  if (command === "files") return filesCommand(rest, { stacks, templates });
  return { lines: [say("usage", USAGE)], exitCode: 1 };
}

async function main() {
  const { lines, exitCode } = await runApply(process.argv.slice(2), process.env);
  for (const line of lines) console.log(line);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
