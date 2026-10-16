// Applies the Ward standard to one repo: the files it carries (the caller,
// the Dependabot config, Directory.Build.props, the npm scripts the node
// contract needs) and the settings GitHub holds for it (Dependabot, secret
// scanning, CodeQL default setup off once the caller's codeql job takes over,
// the ruleset on the default branch, auto-merge). Every command prints what
// it would do and changes nothing until --apply. The ward skill in loadout
// drives it; by hand: node tools/apply.mjs <command>.
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
import { requiredChecksFrom } from "./automerge.mjs";
import { languagesFor, trackedFiles } from "./codeql-languages.mjs";
import { planSteps } from "./node-contract.mjs";
import {
  CODEQL_PINNED,
  exceptionsFor,
  fetchRepoData,
  indentOf,
  parseCaller,
  REQUIRED_CHECK,
  request,
  SELF_CODEQL,
  WARD,
} from "./repo-audit.mjs";
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
// then mine, not the script's. inputs names the caller inputs the tie leaves
// unset, the one the choice is for first, so an existing caller that already
// sets it can settle the stop.
function pickOne(paths, what, module, inputs, stops) {
  if (paths.length === 0) return "";
  const top = Math.min(...paths.map(depth));
  const shallowest = paths.filter((path) => depth(path) === top);
  if (shallowest.length === 1) return shallowest[0];
  const text = `More than one ${what} at the same depth (${shallowest.join(", ")}); set that input yourself.`;
  stops.push({ module, inputs, text });
  return "";
}

const EF_INPUTS = ["dotnet-ef-project", "dotnet-ef-startup-project"];

// The caller inputs and the Dependabot blocks a tree needs. paths are
// repo-relative with forward slashes; csproj holds the text of every .csproj
// in paths, by path. A planned stack is reported as uncovered, never guessed.
// Each stop names the module (node or dotnet) whose choice it blocks and the
// inputs it leaves unset.
export function planInputs(paths, csproj, stacks) {
  const stops = [];
  const kept = paths.filter((path) => !ignored(path, stacks.ignore));
  const detected = detectStacks(kept, stacks);
  const filesOf = (name) => detected.find((stack) => stack.name === name)?.files ?? [];
  const uncovered = detected.filter((stack) => stack.status !== "shipped").map((s) => s.name);

  const manifests = filesOf("node");
  const manifest = pickOne(manifests, "package.json", "node", ["node"], stops);
  const solutions = filesOf("dotnet").filter((path) => /\.slnx?$/.test(path));
  const projects = filesOf("dotnet").filter((path) => path.endsWith(".csproj"));
  const dotnet = solutions.length
    ? pickOne(solutions, "solution file", "dotnet", ["dotnet"], stops)
    : pickOne(projects, "project file with no solution above it", "dotnet", ["dotnet"], stops);
  const text = (path) => csproj[path] ?? "";
  const wpf = projects.some((path) => /<UseWPF>\s*true\s*<\/UseWPF>/i.test(text(path)));

  // The project with the DbContext packages is the EF project; the one with
  // Design is the startup project when it is a different project. A repo with
  // only a Design reference has one project doing both jobs, so a tie there
  // leaves both inputs unset; beside an EF project it only leaves the startup.
  const withEf = projects.filter((path) => EF_PACKAGE.test(text(path)));
  const withDesign = projects.filter((path) => EF_DESIGN.test(text(path)));
  const efPick = pickOne(
    withEf,
    "project referencing Microsoft.EntityFrameworkCore",
    "dotnet",
    EF_INPUTS,
    stops,
  );
  const designPick = pickOne(
    withDesign,
    "project referencing Microsoft.EntityFrameworkCore.Design",
    "dotnet",
    withEf.length ? ["dotnet-ef-startup-project"] : EF_INPUTS,
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
    ruleset: JSON.parse(readFileSync(join(root, "templates", "ruleset.json"), "utf8")),
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

// A job named codeql, whatever it calls, quoted or with a comment after the key too.
const hasCodeqlKey = (text) =>
  lf(text)
    .split("\n")
    .some((line) => /^ {2}["']?codeql["']?:\s*(#.*)?$/.test(line));

// The template's codeql job, with the comment lines directly above it.
function codeqlBlock(template) {
  const lines = lf(template).split("\n");
  const at = lines.findIndex((line) => /^ {2}codeql:\s*$/.test(line));
  let first = at;
  while (first > 0 && /^ {2}#/.test(lines[first - 1])) first--;
  let last = at;
  while (last + 1 < lines.length && lines[last + 1].trim() !== "") last++;
  return lines.slice(first, last + 1);
}

// A caller from before v1.4.0 with the template's codeql job added: before the
// automerge job and the comments above it, or at the end when there is none.
// Nothing else changes, and a CRLF file stays CRLF. null when the jobs are not
// indented two spaces like the template's, because the block would break the YAML,
// or when a codeql job already exists, because a second key would break it too.
export function addCodeqlJob(text, template) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = lf(text).split("\n");
  if (hasCodeqlKey(text)) return null;
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return null;
  const firstJob = lines.slice(jobsAt + 1).find((line) => line.trim() && !/^\s*#/.test(line));
  if (!firstJob || indentOf(firstJob) !== 2) return null;
  const block = codeqlBlock(template);
  let at = lines.findIndex((line) => /^ {2}automerge:\s*$/.test(line));
  if (at === -1) {
    while (lines.length && lines.at(-1).trim() === "") lines.pop();
    lines.push("", ...block, "");
  } else {
    while (at > 0 && /^ {2}#/.test(lines[at - 1])) at--;
    lines.splice(at, 0, ...block, "");
  }
  return lines.join(eol);
}

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
// input existed is kept while the files say "". A caller from before v1.4.0
// gets the codeql job as an edit, unless its inputs drift: then I settle the
// whole file by hand, and the detail names the missing job too.
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
  if (!current.codeql) {
    if (hasCodeqlKey(text)) {
      const detail =
        "a codeql job exists but does not call malinfossum/ward/.github/workflows/codeql.yml; fix it by hand";
      return { path: CALLER, action: "drift", detail };
    }
    if (drift.length) {
      return { path: CALLER, action: "drift", detail: `${drift.join("; ")}; no codeql job` };
    }
    const content = addCodeqlJob(text, template);
    if (content == null) {
      const detail =
        "jobs are not indented two spaces; add the codeql job from templates/ward.yml by hand";
      return { path: CALLER, action: "drift", detail };
    }
    return { path: CALLER, action: "edit", detail: "add the codeql job", content };
  }
  if (!CODEQL_PINNED.test(current.codeql)) {
    drift.push(`the codeql job uses ${current.codeql}, not a full commit SHA`);
  }
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

// A caller that exists has already settled the inputs it sets: a tie for one
// of them is not a stop, and the caller's value is what the files say, so the
// caller is kept (or only gets the codeql job). An input the tie leaves unset
// beside it (the startup project with the EF project) follows the caller too,
// "" when the caller leaves it out, as planCaller reads it. A tie for an input
// the caller does not mention, or a caller that does not call Ward, stays a
// stop. The stops that remain come back; inputs is changed in place.
function settleByCaller(text, inputs, stops) {
  const current = text == null ? null : parseCaller(lf(text));
  if (!current) return stops;
  return stops.filter((stop) => {
    if (!Object.hasOwn(current.inputs, stop.inputs[0])) return true;
    for (const key of stop.inputs) inputs[key] = current.inputs[key] ?? DEFAULTS[key];
    return false;
  });
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
  const callerText = read(CALLER);
  const stops = settleByCaller(
    callerText,
    inputs,
    planned.stops.filter((stop) => !exceptions[stop.module]),
  );
  files.push(planCaller(callerText, inputs, templates.caller));
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
// it appeared after the plan was made. An edit changes package.json scripts or
// adds the caller's codeql job.
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

// Everything the settings commands decide on, read with one token that has
// admin on the repo (locally, gh auth token). The baseline comes from the
// same reads the audit makes, so what apply sets is what the audit checks.
export async function readState(repo, token) {
  const meta = (await request(`/repos/${repo}`, token)).body;
  if (!meta) throw new Error(`Cannot read ${repo}; the token must be allowed to see it.`);
  const data = await fetchRepoData(meta, { admin: token, read: token });
  const branch = encodeURIComponent(meta.default_branch);
  const at = (path) => request(`/repos/${repo}${path}`, token);
  const protection = await at(`/branches/${branch}/protection`);
  const classic = protection.status === 200;
  const listed = await at("/rulesets");
  const rulesets = (listed.body ?? []).filter((r) => r.target === "branch");
  const existing = rulesets.length === 1 ? (await at(`/rulesets/${rulesets[0].id}`)).body : null;
  const analyses = (await at(`/code-scanning/analyses?ref=refs/heads/${branch}&per_page=1`)).body;
  const pulls = (await at("/pulls?state=open&per_page=100")).body ?? [];
  return {
    repo,
    meta,
    branch: meta.default_branch,
    baseline: data.baseline,
    // The default branch's files and caller: where settings looks for the codeql
    // job and the languages it will scan when no --dir is given.
    tree: data.tree,
    caller: data.caller,
    classic,
    // Classic protection reads 401 or 403 without admin, which would pass for "none":
    // a token that cannot read it cannot be trusted with a ruleset either.
    rulesetsRead: listed.status === 200 && ![401, 403].includes(protection.status),
    rulesets,
    existing,
    analysed: Array.isArray(analyses) && analyses.length > 0,
    dependabotPulls: pulls.filter((p) => p.user?.login === "dependabot[bot]").map((p) => p.number),
  };
}

// Default setup names JavaScript and TypeScript apart; the workflow scans them as one.
const FOLD = { javascript: "javascript-typescript", typescript: "javascript-typescript" };

// The settings a repo still needs, from the baseline the audit reads. A
// field the token could not read is a stop, never a blind write: the write
// would fail for the same reason, and a silent retry would hide it. job: a
// caller with the codeql job is visible; languages: what that job will scan.
// Default setup goes off only when both hold and nothing it scans is lost, so
// a repo is never left unscanned by accident.
export function planSettings(baseline, { job = false, languages = [], isPrivate = false } = {}) {
  const { alerts, securityUpdates, analysis, codeScanning } = baseline;
  if ([alerts, securityUpdates, analysis, codeScanning].some((value) => value == null)) {
    const stop = "The token cannot read this repo's settings; it needs admin on the repo.";
    return { stops: [stop], actions: [], notes: [] };
  }
  const stops = [];
  const actions = [];
  const notes = [];
  if (!alerts)
    actions.push({ what: "Dependabot alerts on", method: "PUT", path: "/vulnerability-alerts" });
  if (!securityUpdates.enabled || securityUpdates.paused) {
    actions.push({
      what: "Dependabot security updates on",
      method: "PUT",
      path: "/automated-security-fixes",
    });
  }
  const on = { status: "enabled" };
  if (
    analysis.secret_scanning?.status !== "enabled" ||
    analysis.secret_scanning_push_protection?.status !== "enabled"
  ) {
    actions.push({
      what: "secret scanning and push protection on",
      method: "PATCH",
      path: "",
      body: { security_and_analysis: { secret_scanning: on, secret_scanning_push_protection: on } },
    });
  }
  if (codeScanning.state === "configured") {
    if (!job) {
      notes.push(
        "CodeQL default setup stays on until the caller has the codeql job; run files --apply, then settings --dir <checkout>.",
      );
    } else if (!Array.isArray(codeScanning.languages)) {
      stops.push(
        "CodeQL default setup does not say which languages it scans, so I cannot check the codeql job covers them.",
      );
    } else {
      const scanned = [...new Set(codeScanning.languages.map((name) => FOLD[name] ?? name))];
      const lost = scanned.filter((name) => !languages.includes(name));
      if (lost.length) {
        stops.push(
          `CodeQL default setup scans ${lost.join(", ")}, which the codeql job would not; add it to tools/codeql-languages.mjs first.`,
        );
      } else {
        actions.push({
          what: "CodeQL default setup off",
          method: "PATCH",
          path: "/code-scanning/default-setup",
          body: { state: "not-configured" },
        });
        // The PATCH answers 202 and finishes later; an upload before then is refused.
        notes.push(
          "GitHub turns default setup off in the background: push only once status reads default-setup=not-configured.",
        );
      }
    }
  }
  if (isPrivate) {
    notes.push(
      "This repo is private: CodeQL here needs GitHub Advanced Security, so leave the codeql job out of its caller.",
    );
  }
  return { stops, actions, notes };
}

export function statusLine(state) {
  const analysis = state.baseline.analysis ?? {};
  const rules = state.baseline.rules;
  const types = (rules ?? []).map((rule) => rule.type).sort();
  return [
    `${state.repo}:`,
    `auto-merge=${state.meta.allow_auto_merge}`,
    `secret-scanning=${analysis.secret_scanning?.status ?? "unread"}`,
    `push-protection=${analysis.secret_scanning_push_protection?.status ?? "unread"}`,
    `default-setup=${state.baseline.codeScanning?.state ?? "unread"}`,
    `analysed=${state.analysed}`,
    `rulesets=${state.rulesetsRead ? state.rulesets.length : "unread"}${state.classic ? "+classic" : ""}`,
    `rules=${rules ? types.join(",") || "none" : "unread"}`,
  ].join(" ");
}

// Only Ward's own codeql workflow counts as the job. A local path means Ward's
// scan only on Ward itself; on any other repo it points at a file that is not
// there, and a foreign workflow is not mine, so settings must keep default setup on.
// Any ref passes: the audit flags an unpinned one separately.
const WARD_CODEQL = /^malinfossum\/ward\/\.github\/workflows\/codeql\.yml@.+$/;
const hasCodeqlJob = (text, self) => {
  const ref = text == null ? null : parseCaller(lf(text))?.codeql;
  return Boolean(ref && (WARD_CODEQL.test(ref) || (self && ref === SELF_CODEQL)));
};

// Where settings can see the codeql job, and the tree that job will scan: the
// default branch, or a --dir checkout of this same repo, whose caller may have
// the job before it is merged. --dir has no default: run from a Ward clone, `.`
// would read Ward's own caller and pass for any repo.
function codeqlView(state, argv) {
  const self = state.repo.toLowerCase() === WARD;
  const onBranch = hasCodeqlJob(state.caller, self);
  if (!argv.includes("--dir")) return { job: onBranch, paths: state.tree };
  const dir = arg(argv, "--dir");
  if (!dir || !existsSync(dir)) {
    return { stop: `${dir || "--dir"} is not a directory I can read.` };
  }
  const origin = repoName([], dir);
  if (origin.toLowerCase() !== state.repo.toLowerCase()) {
    return { stop: `${dir} is a checkout of ${origin || "no GitHub repo"}, not ${state.repo}.` };
  }
  const local = join(dir, CALLER);
  const text = existsSync(local) ? readFileSync(local, "utf8") : null;
  return { job: onBranch || hasCodeqlJob(text, self), paths: trackedFiles(dir) ?? [] };
}

async function settingsCommand(state, argv, token, stacks) {
  const view = codeqlView(state, argv);
  if (view.stop) return { lines: [say("stop", view.stop)], exitCode: 1 };
  const { stops, actions, notes } = planSettings(state.baseline, {
    job: view.job,
    languages: languagesFor(view.paths, stacks.ignore),
    isPrivate: state.meta.private === true,
  });
  const lines = stops.map((stop) => say("stop", stop));
  for (const action of actions) lines.push(say("set", action.what));
  for (const note of notes) lines.push(say("note", note));
  if (stops.length) return { lines, exitCode: 1 };
  if (!actions.length && !notes.length) lines.push(say("keep", "every setting is already on"));
  if (argv.includes("--apply")) {
    for (const action of actions) {
      const call = () =>
        request(`/repos/${state.repo}${action.path}`, token, {
          method: action.method,
          body: action.body,
        });
      if (!(await attempt(lines, call, action.what))) return { lines, exitCode: 1 };
    }
  }
  return { lines, exitCode: 0 };
}

// One write, with its done line or its error line. Only a 2xx is done: a
// 401, 403 or 404 comes back as a status without throwing, and a refused
// write must not read as made. A failure mid-apply keeps the lines before it
// and stops; a rerun is idempotent, so nothing is lost.
async function attempt(lines, call, what) {
  try {
    const res = await call();
    if (res.status >= 200 && res.status < 300) {
      lines.push(say("done", what));
      return true;
    }
    lines.push(say("error", `${what} ${res.status}`));
    return false;
  } catch (error) {
    lines.push(say("error", error.message));
    return false;
  }
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
  "node tools/apply.mjs settings <owner/repo> [--dir <checkout>] [--apply]",
  "node tools/apply.mjs ruleset|automerge|status <owner/repo> [--apply] [--bypass-admin] [--no-codeql]",
  "Settings commands read GITHUB_TOKEN (locally: GITHUB_TOKEN=$(gh auth token)).",
].join("\n");

// The template over what the repo has: a rule type the template does not
// know stays, and the repo's own required checks stay beside ward / gate
// (workbench's test jobs, varde's api-tests). The template is never mutated.
export function mergeRuleset(template, existing, { bypassAdmin = false, noCodeql = false } = {}) {
  const body = structuredClone(template);
  const have = new Set(body.rules.map((rule) => rule.type));
  for (const rule of existing?.rules ?? []) if (!have.has(rule.type)) body.rules.push(rule);
  const mine = body.rules.find((rule) => rule.type === "required_status_checks");
  const theirs = existing?.rules?.find((rule) => rule.type === "required_status_checks");
  for (const check of theirs?.parameters?.required_status_checks ?? []) {
    if (!mine.parameters.required_status_checks.some((c) => c.context === check.context)) {
      mine.parameters.required_status_checks.push(check);
    }
  }
  if (noCodeql) body.rules = body.rules.filter((rule) => rule.type !== "code_scanning");
  if (bypassAdmin) {
    body.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
  }
  return body;
}

// want is contained in have: every key I would send is there with my value;
// arrays match element for element in any order and must be the same length,
// so a dropped check or an extra rule is a difference.
function contains(want, have) {
  if (Array.isArray(want)) {
    return (
      Array.isArray(have) &&
      want.length === have.length &&
      want.every((w) => have.some((h) => contains(w, h)))
    );
  }
  if (want && typeof want === "object") {
    return (
      Boolean(have) &&
      typeof have === "object" &&
      Object.entries(want).every(([key, value]) => contains(value, have[key]))
    );
  }
  return want === have;
}

// The API returns more than it was sent (ids, links, parameters I did not
// set); the ruleset is the same when everything I would send is already there.
export function sameRuleset(existing, body) {
  const { enforcement, conditions, bypass_actors, rules } = body;
  return contains({ enforcement, conditions, bypass_actors, rules }, existing);
}

export function planRuleset(state, template, { bypassAdmin = false, noCodeql = false } = {}) {
  const stops = [];
  if (!state.rulesetsRead) {
    stops.push("The token cannot list this repo's rulesets; it needs admin on the repo.");
  }
  if (state.classic) {
    stops.push("Classic branch protection is on; move it to a ruleset by hand first.");
  }
  if (state.rulesets.length > 1) {
    const ids = state.rulesets.map((r) => r.id).join(", ");
    stops.push(`More than one branch ruleset (${ids}); keep one, delete the rest, rerun.`);
  }
  if (stops.length) return { stops, wait: "", action: "", body: null };
  if (!noCodeql && !state.analysed) {
    // A repo CodeQL has no language for never gets an analysis; waiting would never end.
    const none = state.baseline.codeScanning?.languages?.length === 0;
    const wait = none
      ? `CodeQL has no language to analyse on ${state.branch}, so it will never analyse it; rerun with --no-codeql and add a dated ruleset exception in stacks.json.`
      : `CodeQL has not analysed ${state.branch} yet, and a code-scanning rule before that blocks every merge; rerun in a few minutes (up to an hour on a first run).`;
    return { stops, wait, action: "", body: null };
  }
  const body = mergeRuleset(template, state.existing, { bypassAdmin, noCodeql });
  const action = !state.existing ? "create" : sameRuleset(state.existing, body) ? "keep" : "update";
  return { stops, wait: "", action, body };
}

async function rulesetCommand(state, argv, token, template) {
  const plan = planRuleset(state, template, {
    bypassAdmin: argv.includes("--bypass-admin"),
    noCodeql: argv.includes("--no-codeql"),
  });
  if (plan.stops.length) return { lines: plan.stops.map((s) => say("stop", s)), exitCode: 1 };
  if (plan.wait) return { lines: [say("wait", plan.wait)], exitCode: 1 };
  const bypass = plan.body.bypass_actors.length ? " (repository admin bypass)" : "";
  const what = `ruleset "${plan.body.name}" with ${plan.body.rules.map((r) => r.type).join(", ")}${bypass}`;
  const lines = [say(plan.action, what)];
  if (plan.action !== "keep" && argv.includes("--apply")) {
    const create = plan.action === "create";
    const path = create
      ? `/repos/${state.repo}/rulesets`
      : `/repos/${state.repo}/rulesets/${state.existing.id}`;
    const call = () => request(path, token, { method: create ? "POST" : "PUT", body: plan.body });
    if (!(await attempt(lines, call, `ruleset ${plan.action}d`))) return { lines, exitCode: 1 };
  }
  return { lines, exitCode: 0 };
}

// Auto-merge on a repo whose default branch does not require the gate merges
// every Dependabot PR at once, so it is refused until the ruleset is there.
export function planAutomerge(state) {
  if (!requiredChecksFrom(state.baseline.rules ?? []).includes(REQUIRED_CHECK)) {
    const stop = `${state.branch} does not require "${REQUIRED_CHECK}", so auto-merge now would merge every Dependabot PR at once; run ruleset first.`;
    return { stops: [stop], enable: false, rebase: [] };
  }
  // The rebase nudge is for PRs that stalled before auto-merge existed; once it
  // is on, a rerun must not ask Dependabot to rebase every open PR again.
  const enable = !state.meta.allow_auto_merge;
  return { stops: [], enable, rebase: enable ? state.dependabotPulls : [] };
}

async function automergeCommand(state, argv, token) {
  const plan = planAutomerge(state);
  if (plan.stops.length) return { lines: plan.stops.map((s) => say("stop", s)), exitCode: 1 };
  const lines = [
    plan.enable ? say("set", "allow auto-merge") : say("keep", "auto-merge is already on"),
  ];
  for (const number of plan.rebase) lines.push(say("rebase", `#${number}`));
  if (argv.includes("--apply")) {
    if (plan.enable) {
      const call = () =>
        request(`/repos/${state.repo}`, token, {
          method: "PATCH",
          body: { allow_auto_merge: true },
        });
      if (!(await attempt(lines, call, "allow auto-merge"))) return { lines, exitCode: 1 };
    }
    for (const number of plan.rebase) {
      const call = () =>
        request(`/repos/${state.repo}/issues/${number}/comments`, token, {
          method: "POST",
          body: { body: "@dependabot rebase" },
        });
      if (!(await attempt(lines, call, `rebase asked on #${number}`)))
        return { lines, exitCode: 1 };
    }
  }
  return { lines, exitCode: 0 };
}

const SETTINGS_COMMANDS = ["settings", "ruleset", "automerge", "status"];
const REPO = /^[\w.-]+\/[\w.-]+$/;

// deps lets the tests pass their own stacks and templates.
export async function runApply(argv, env, deps = {}) {
  const [command, ...rest] = argv;
  const stacks = deps.stacks ?? loadStacks();
  const templates = deps.templates ?? readTemplates();
  if (command === "files") return filesCommand(rest, { stacks, templates });
  if (!SETTINGS_COMMANDS.includes(command) || !REPO.test(rest[0] ?? "")) {
    return { lines: [say("usage", USAGE)], exitCode: 1 };
  }
  const token = env.GITHUB_TOKEN || "";
  if (!token) {
    const stop = "GITHUB_TOKEN is not set; run with GITHUB_TOKEN=$(gh auth token).";
    return { lines: [say("stop", stop)], exitCode: 1 };
  }
  try {
    const state = await readState(rest[0], token);
    if (command === "status") return { lines: [say("status", statusLine(state))], exitCode: 0 };
    if (command === "settings") return await settingsCommand(state, rest, token, stacks);
    if (command === "ruleset") return await rulesetCommand(state, rest, token, templates.ruleset);
    return await automergeCommand(state, rest, token);
  } catch (error) {
    return { lines: [say("error", error.message)], exitCode: 1 };
  }
}

async function main() {
  const { lines, exitCode } = await runApply(process.argv.slice(2), process.env);
  for (const line of lines) console.log(line);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
