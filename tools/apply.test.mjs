import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  CALLER,
  DEPENDABOT,
  PROPS,
  planFiles,
  planInputs,
  readTemplates,
  renderCaller,
  renderDependabot,
  runApply,
  writeFiles,
} from "./apply.mjs";
import { parseCaller } from "./repo-audit.mjs";
import { loadStacks } from "./stacks.mjs";

const stacks = loadStacks();
const plan = (paths, csproj = {}) => planInputs(paths, csproj, stacks);
const pkg = (name) => `<PackageReference Include="${name}" Version="10.0.12" />`;
const DESIGN = pkg("Microsoft.EntityFrameworkCore.Design");
const SQLITE = pkg("Microsoft.EntityFrameworkCore.Sqlite");
const TOOLS = pkg("Microsoft.EntityFrameworkCore.Tools");
const WPF = "<UseWPF>true</UseWPF>";
const callerTemplate = readFileSync("templates/ward.yml", "utf8");
const dependabotTemplate = readFileSync("templates/dependabot.yml", "utf8");

test("node is the one package.json's directory, the root as .", () => {
  assert.equal(plan(["package.json", "src/a.js"]).inputs.node, ".");
  assert.equal(plan(["web/package.json"]).inputs.node, "web");
  assert.equal(plan(["README.md"]).inputs.node, "");
});

test("the shallowest package.json wins; a tie is a stop, never a guess", () => {
  assert.equal(plan(["package.json", "e2e/package.json"]).inputs.node, ".");
  const tie = plan(["web/package.json", "api/package.json"]);
  assert.equal(tie.stops[0].module, "node");
  assert.equal(tie.inputs.node, "");
  assert.match(
    tie.stops[0].text,
    /More than one package\.json at the same depth \(web\/package\.json, api\/package\.json\)/,
  );
});

test("dotnet is the solution file, or the only project when there is none", () => {
  assert.equal(plan(["App.slnx", "src/App/App.csproj"]).inputs.dotnet, "App.slnx");
  assert.equal(plan(["api/App.sln", "api/src/App/App.csproj"]).inputs.dotnet, "api/App.sln");
  assert.equal(plan(["Tool/Tool.csproj"]).inputs.dotnet, "Tool/Tool.csproj");
  const two = plan(["A/A.csproj", "B/B.csproj"]);
  assert.equal(two.inputs.dotnet, "");
  assert.match(two.stops[0].text, /More than one project file with no solution above it/);
  assert.equal(plan(["Legacy.sln", "App.slnx"]).stops.length, 1);
  assert.equal(two.stops[0].module, "dotnet");
});

test("WPF means windows-latest", () => {
  const paths = ["App.slnx", "src/App/App.csproj", "src/App.Data/App.Data.csproj"];
  assert.equal(plan(paths, { "src/App/App.csproj": WPF }).inputs["dotnet-os"], "windows-latest");
  assert.equal(plan(paths, {}).inputs["dotnet-os"], "ubuntu-latest");
});

test("the EF project holds the DbContext packages; the Design project is the startup project", () => {
  const paths = ["App.slnx", "src/App.Api/App.Api.csproj", "src/App.Data/App.Data.csproj"];
  const split = plan(paths, {
    "src/App.Api/App.Api.csproj": DESIGN,
    "src/App.Data/App.Data.csproj": SQLITE,
  });
  assert.equal(split.inputs["dotnet-ef-project"], "src/App.Data");
  assert.equal(split.inputs["dotnet-ef-startup-project"], "src/App.Api");
  assert.deepEqual(split.stops, []);

  const single = plan(["App.slnx", "src/App/App.csproj"], {
    "src/App/App.csproj": SQLITE + DESIGN + TOOLS,
  });
  assert.equal(single.inputs["dotnet-ef-project"], "src/App");
  assert.equal(single.inputs["dotnet-ef-startup-project"], "");

  const designOnly = plan(["App.slnx", "src/App/App.csproj"], { "src/App/App.csproj": DESIGN });
  assert.equal(designOnly.inputs["dotnet-ef-project"], "src/App");
  assert.equal(designOnly.inputs["dotnet-ef-startup-project"], "");

  const none = plan(paths, {});
  assert.equal(none.inputs["dotnet-ef-project"], "");
  assert.equal(none.inputs["dotnet-ef-startup-project"], "");
});

test("the Tools package alone, or a package that only looks like EF Core, is not an EF project", () => {
  const paths = ["App.slnx", "src/App/App.csproj"];
  const tools = plan(paths, { "src/App/App.csproj": TOOLS });
  assert.equal(tools.inputs["dotnet-ef-project"], "");
  const lookalike = plan(paths, {
    "src/App/App.csproj": pkg("Microsoft.EntityFrameworkCoreExtras"),
  });
  assert.equal(lookalike.inputs["dotnet-ef-project"], "");
});

test("two EF projects, or two Design projects, are a stop", () => {
  const paths = ["App.slnx", "src/A/A.csproj", "src/B/B.csproj"];
  const twoEf = plan(paths, { "src/A/A.csproj": SQLITE, "src/B/B.csproj": SQLITE });
  assert.match(
    twoEf.stops[0].text,
    /More than one project referencing Microsoft\.EntityFrameworkCore/,
  );
  assert.equal(twoEf.inputs["dotnet-ef-project"], "");
  const twoDesign = plan(paths, { "src/A/A.csproj": DESIGN, "src/B/B.csproj": DESIGN });
  assert.match(twoDesign.stops[0].text, /More than one project referencing/);
});

test("files under node_modules, bin and obj never count", () => {
  const { inputs } = plan(["node_modules/x/package.json", "bin/Debug/App.csproj", "README.md"]);
  assert.deepEqual(inputs, {
    node: "",
    dotnet: "",
    "dotnet-os": "ubuntu-latest",
    "dotnet-ef-project": "",
    "dotnet-ef-startup-project": "",
  });
});

test("a planned stack is reported as uncovered and still gets its Dependabot block", () => {
  const { uncovered, ecosystems } = plan(["pyproject.toml", "Dockerfile"]);
  assert.deepEqual(uncovered, ["python", "docker"]);
  assert.deepEqual(
    ecosystems.map((e) => e.ecosystem),
    ["github-actions", "docker", "pip"],
  );
});

test("Dependabot blocks follow the stacks: one per npm directory, nuget and dotnet-sdk with dotnet", () => {
  const { ecosystems } = plan([
    "package.json",
    "App.slnx",
    "src/App/App.csproj",
    "global.json",
    "e2e/package.json",
  ]);
  assert.deepEqual(ecosystems, [
    { ecosystem: "github-actions", directory: "/" },
    { ecosystem: "npm", directory: "/" },
    { ecosystem: "npm", directory: "/e2e" },
    { ecosystem: "nuget", directory: "/" },
    { ecosystem: "dotnet-sdk", directory: "/" },
  ]);
  const nested = plan([
    "api/App.sln",
    "api/global.json",
    "api/src/App/App.csproj",
    "web/Dockerfile",
  ]);
  assert.deepEqual(nested.ecosystems.slice(1), [
    { ecosystem: "nuget", directory: "/api" },
    { ecosystem: "dotnet-sdk", directory: "/api" },
    { ecosystem: "docker", directory: "/web" },
  ]);
});

test("renderCaller fills the inputs, keeps the comments aligned and round-trips through parseCaller", () => {
  const inputs = {
    node: "web",
    dotnet: "App.slnx",
    "dotnet-os": "ubuntu-latest",
    "dotnet-ef-project": "",
    "dotnet-ef-startup-project": "",
  };
  const text = renderCaller(callerTemplate, inputs);
  assert.match(text, /^ {6}node: "web" +# npm project directory/m);
  assert.match(text, /^ {6}a11y: "off"/m);
  const parsed = parseCaller(text);
  assert.equal(parsed.uses, "malinfossum/ward/.github/workflows/ci.yml@v1");
  for (const [key, value] of Object.entries(inputs)) assert.equal(parsed.inputs[key], value);
  const columns = text
    .split("\n")
    .filter((line) =>
      /^ {6}(node|a11y|dotnet|dotnet-os|dotnet-ef-project|dotnet-ef-startup-project):/.test(line),
    )
    .map((line) => line.indexOf("#"));
  assert.equal(columns.length, 6);
  assert.equal(new Set(columns).size, 1, `comment columns differ: ${columns}`);
});

test("renderCaller keeps a bare value bare and one space before a comment it cannot align", () => {
  const inputs = {
    node: "",
    dotnet: "api/App.slnx",
    "dotnet-os": "windows-latest",
    "dotnet-ef-project": "api/src/App.Data",
    "dotnet-ef-startup-project": "api/src/App.Api",
  };
  const text = renderCaller(callerTemplate, inputs);
  assert.match(text, /^ {6}dotnet-os: windows-latest +# windows-latest for WPF$/m);
  assert.match(text, /^ {6}dotnet-ef-project: "api\/src\/App\.Data" # EF Core project/m);
  assert.match(text, /^ {6}dotnet-ef-startup-project: "api\/src\/App\.Api" # startup project/m);
  assert.match(text, /^ {6}node: "" +# npm project directory/m);
  assert.equal(parseCaller(text).inputs["dotnet-ef-project"], "api/src/App.Data");
  assert.equal(parseCaller(text).inputs["dotnet-ef-startup-project"], "api/src/App.Api");
});

test("renderDependabot keeps one block per ecosystem, in order, with its directory and comments", () => {
  const text = renderDependabot(dependabotTemplate, [
    { ecosystem: "github-actions", directory: "/" },
    { ecosystem: "npm", directory: "/web" },
    { ecosystem: "nuget", directory: "/" },
  ]);
  const blocks = [...text.matchAll(/^ {2}- package-ecosystem: (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(blocks, ["github-actions", "npm", "nuget"]);
  assert.match(text, /^version: 2$/m);
  assert.match(text, /^ {2}# Only GitHub's own actions are grouped/m);
  assert.match(text, /package-ecosystem: npm[^\n]*\n {4}directory: \/web$/m);
  assert.match(text, /dotnet-runtime:/);
  assert.doesNotMatch(text, /pip|docker|dotnet-sdk/);
  assert.doesNotMatch(text, /delete the rest/);
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
});

test("renderDependabot repeats the npm block for a second directory", () => {
  const text = renderDependabot(dependabotTemplate, [
    { ecosystem: "github-actions", directory: "/" },
    { ecosystem: "npm", directory: "/" },
    { ecosystem: "npm", directory: "/e2e" },
  ]);
  assert.deepEqual(
    [...text.matchAll(/^ {4}directory: (\S+)/gm)].map((m) => m[1]),
    ["/", "/", "/e2e"],
  );
});

const templates = readTemplates();
const PKG = JSON.stringify(
  { name: "x", scripts: { lint: "biome ci .", test: "node --test" } },
  null,
  2,
);
const OFF = { node: "", dotnet: "", "dotnet-os": "ubuntu-latest", "dotnet-ef-project": "" };

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "ward-apply-"));
  made.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const actions = (plan) => plan.files.map((f) => [f.path, f.action]);
const file = (plan, path) => plan.files.find((f) => f.path === path);
const caller = (inputs) =>
  renderCaller(templates.caller, { ...OFF, "dotnet-ef-startup-project": "", ...inputs });

test("a fresh web repo gets the caller and the Dependabot config; node_modules is invisible", () => {
  const dir = repo({ "package.json": PKG, "src/app.js": "", "node_modules/x/package.json": "{}" });
  const plan = planFiles(dir, { templates });
  assert.equal(plan.inputs.node, ".");
  assert.deepEqual(actions(plan), [
    [CALLER, "create"],
    [DEPENDABOT, "create"],
    ["package.json", "keep"],
  ]);
  assert.match(file(plan, CALLER).content, /^ {6}node: "\."/m);
  assert.match(file(plan, DEPENDABOT).content, /package-ecosystem: npm/);
  assert.doesNotMatch(file(plan, DEPENDABOT).content, /nuget/);
});

test("a C# repo gets Directory.Build.props too; a changed copy is drift, never replaced", () => {
  const dir = repo({
    "App.slnx": "",
    "src/App/App.csproj": "<Project />",
    "tests/App.Tests/App.Tests.csproj": "<Project />",
  });
  const plan = planFiles(dir, { templates });
  assert.equal(plan.inputs.dotnet, "App.slnx");
  assert.equal(file(plan, PROPS).action, "create");
  assert.deepEqual(writeFiles(dir, plan), [CALLER, DEPENDABOT, PROPS]);
  assert.ok(templates.props.equals(readFileSync(join(dir, PROPS))));
  assert.equal(file(planFiles(dir, { templates }), PROPS).action, "keep");
  writeFileSync(join(dir, PROPS), "<Project></Project>\n");
  const drift = file(planFiles(dir, { templates }), PROPS);
  assert.equal(drift.action, "drift");
  assert.match(drift.detail, /differs from templates\/Directory\.Build\.props/);
});

test("a file that differs only in line endings is kept, not drift", () => {
  const crlf = (text) => text.replaceAll("\n", "\r\n");
  const dir = repo({
    "App.slnx": "",
    "src/App/App.csproj": "<Project />",
    [PROPS]: crlf(templates.props.toString("utf8")),
    [DEPENDABOT]: crlf(
      renderDependabot(templates.dependabot, [
        { ecosystem: "github-actions", directory: "/" },
        { ecosystem: "nuget", directory: "/" },
      ]),
    ),
    [CALLER]: crlf(caller({ dotnet: "App.slnx" })),
  });
  assert.deepEqual(actions(planFiles(dir, { templates })), [
    [CALLER, "keep"],
    [DEPENDABOT, "keep"],
    [PROPS, "keep"],
  ]);
});

test("an existing caller is kept when its inputs mean the same, and reported per input when not", () => {
  const same = { node: "./web", dotnet: ".", "dotnet-os": "ubuntu-latest" };
  const dir = repo({
    [CALLER]: caller(same),
    "web/package.json": PKG,
    "App.slnx": "",
    "src/App/App.csproj": "<Project />",
  });
  assert.equal(file(planFiles(dir, { templates }), CALLER).action, "keep");
  const old = caller(same).replace(/^ {6}dotnet-ef-startup-project:.*\n/m, "");
  writeFileSync(join(dir, CALLER), old);
  assert.equal(file(planFiles(dir, { templates }), CALLER).action, "keep");
  writeFileSync(join(dir, "src/App/App.csproj"), `<Project>${SQLITE}</Project>`);
  const drift = file(planFiles(dir, { templates }), CALLER);
  assert.equal(drift.action, "drift");
  assert.match(drift.detail, /^dotnet-ef-project is "", the files say "src\/App"$/);
});

test("a hand-edited caller (a11y in warn, an extra address) is never overwritten", () => {
  const text = caller({ node: "." })
    .replace('a11y: "off"', 'a11y: "warn"')
    .replace(
      /(dotnet-ef-startup-project: ""[^\n]*\n)/,
      "$1      allowed-emails: x@users.noreply.github.com\n",
    );
  const dir = repo({ [CALLER]: text, "package.json": PKG });
  const plan = planFiles(dir, { templates });
  assert.equal(file(plan, CALLER).action, "keep");
  assert.deepEqual(writeFiles(dir, plan), [DEPENDABOT]);
  assert.equal(readFileSync(join(dir, CALLER), "utf8"), text);
});

test("writeFiles refuses a file that appeared after the plan was made", () => {
  const dir = repo({ "package.json": PKG });
  const plan = planFiles(dir, { templates });
  mkdirSync(join(dir, dirname(CALLER)), { recursive: true });
  writeFileSync(join(dir, CALLER), "mine\n", { flag: "wx" });
  assert.throws(() => writeFiles(dir, plan), { code: "EEXIST" });
  assert.equal(readFileSync(join(dir, CALLER), "utf8"), "mine\n");
});

test("a caller that does not call Ward, and a dependabot.yml missing a block, are drift", () => {
  const dir = repo({
    [CALLER]: "name: Ward\non: [push]\njobs:\n  x:\n    runs-on: ubuntu-latest\n",
    [DEPENDABOT]: "version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n",
    "package.json": PKG,
    "App.slnx": "",
    "src/App/App.csproj": "<Project />",
  });
  const plan = planFiles(dir, { templates });
  assert.match(file(plan, CALLER).detail, /does not call malinfossum\/ward/);
  assert.equal(file(plan, DEPENDABOT).action, "drift");
  assert.equal(file(plan, DEPENDABOT).detail, "no block for npm at /, nuget at /");
});

test("missing scripts are added in the file's own indentation; test is asked for, never guessed", () => {
  const pkg = [
    "{",
    '\t"name": "x",',
    '\t"scripts": {',
    '\t\t"lint": "biome ci ."',
    "\t},",
    '\t"devDependencies": {',
    '\t\t"@biomejs/biome": "2.5.15",',
    '\t\t"typescript": "7.0.2"',
    "\t}",
    "}",
    "",
  ].join("\n");
  const dir = repo({ "package.json": pkg, "tsconfig.json": "{}", "wrangler.jsonc": "{}" });
  const plan = planFiles(dir, { templates });
  const edit = plan.files.find((f) => f.action === "edit");
  assert.equal(edit.detail, "scripts: typecheck, deploy:check");
  assert.match(edit.content, /^\t\t"typecheck": "tsc --noEmit",$/m);
  assert.match(edit.content, /^\t\t"deploy:check": "wrangler deploy --dry-run"$/m);
  assert.ok(plan.files.some((f) => f.action === "ask" && /"test" script/.test(f.detail)));
  assert.deepEqual(plan.notes, [
    "deploy:check runs wrangler: add wrangler as a devDependency first.",
  ]);
  writeFiles(dir, plan);
  const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(written.scripts), ["lint", "typecheck", "deploy:check"]);
});

test("an Astro repo gets astro check; a repo without Biome gets lint and a note", () => {
  const manifest = { name: "x", scripts: { test: "vitest run" }, dependencies: { astro: "7.3.5" } };
  const dir = repo({ "package.json": JSON.stringify(manifest), "astro.config.mjs": "" });
  const plan = planFiles(dir, { templates });
  const edit = plan.files.find((f) => f.action === "edit");
  assert.equal(edit.detail, "scripts: lint, typecheck");
  assert.match(edit.content, /"typecheck": "astro check"/);
  assert.match(edit.content, /"lint": "biome ci \."/);
  assert.match(plan.notes[0], /^lint runs Biome: add @biomejs\/biome/);
});

test("a module in the exceptions stays off in the caller and is noted with its reason", () => {
  const dir = repo({ "package.json": PKG, "App.slnx": "", "src/App/App.csproj": SQLITE });
  const reason = "Course repo with one solution per week (2026-10-02).";
  const plan = planFiles(dir, { templates, exceptions: { dotnet: reason } });
  assert.equal(plan.inputs.node, ".");
  assert.equal(plan.inputs.dotnet, "");
  assert.equal(plan.inputs["dotnet-ef-project"], "");
  assert.deepEqual(actions(plan), [
    [CALLER, "create"],
    [DEPENDABOT, "create"],
    ["package.json", "keep"],
  ]);
  assert.match(file(plan, CALLER).content, /^ {6}dotnet: ""/m);
  assert.deepEqual(plan.notes, [`dotnet stays off: ${reason}`]);
});

test("the files command prints the plan and writes only with --apply; a stop writes nothing", async () => {
  const dir = repo({ "package.json": PKG });
  const dry = await runApply(["files", "--dir", dir], {}, { templates });
  assert.equal(dry.exitCode, 0);
  assert.ok(dry.lines[0].startsWith('inputs  node="." dotnet=""'));
  assert.ok(dry.lines.includes(`create  ${CALLER}`));
  assert.ok(!existsSync(join(dir, CALLER)));
  const wet = await runApply(["files", "--dir", dir, "--apply"], {}, { templates });
  assert.ok(wet.lines.includes(`wrote   ${CALLER}`));
  assert.ok(existsSync(join(dir, CALLER)));
  const tied = repo({ "a/package.json": PKG, "b/package.json": PKG, "pyproject.toml": "" });
  const tie = await runApply(["files", "--dir", tied, "--apply"], {}, { templates });
  assert.equal(tie.exitCode, 1);
  assert.ok(tie.lines.some((l) => l.startsWith("stop    More than one package.json")));
  assert.ok(tie.lines.some((l) => l.startsWith("warn    python files found")));
  assert.ok(!existsSync(join(tied, CALLER)));
  const broken = await runApply(
    ["files", "--dir", repo({ "package.json": "{" })],
    {},
    { templates },
  );
  assert.equal(broken.exitCode, 1);
  assert.ok(broken.lines.some((l) => l.startsWith("stop    package.json is not valid JSON")));
  const gone = await runApply(
    ["files", "--dir", join(tmpdir(), "ward-no-such-dir")],
    {},
    { templates },
  );
  assert.equal(gone.exitCode, 1);
  assert.ok(gone.lines[0].startsWith("stop"));
});

test("the files command resolves exceptions by repo name, from --repo or the origin remote", async () => {
  const withExceptions = {
    ...stacks,
    exceptions: { "malinfossum/backend-course": { dotnet: "One solution per week (2026-10-02)." } },
  };
  const deps = { templates, stacks: withExceptions };
  const files = { "package.json": PKG, "App.slnx": "", "src/App/App.csproj": "<Project />" };
  const named = await runApply(
    ["files", "--dir", repo(files), "--repo", "MalinFossum/Backend-Course"],
    {},
    deps,
  );
  assert.ok(named.lines.includes("note    dotnet stays off: One solution per week (2026-10-02)."));
  assert.match(named.lines[0], /dotnet=""/);
  const other = await runApply(
    ["files", "--dir", repo(files), "--repo", "malinfossum/x"],
    {},
    deps,
  );
  assert.match(other.lines[0], /dotnet="App\.slnx"/);

  const cloned = repo(files);
  const git = (...args) => spawnSync("git", ["-C", cloned, ...args]);
  git("init", "-q");
  git("remote", "add", "origin", "git@github.com:malinfossum/backend-course.git");
  const viaRemote = await runApply(["files", "--dir", cloned], {}, deps);
  assert.match(viaRemote.lines[0], /dotnet=""/);
  const noRemote = await runApply(["files", "--dir", repo(files)], {}, deps);
  assert.match(noRemote.lines[0], /dotnet="App\.slnx"/);
});

test("an excepted module's stops are dropped; the note still names it", () => {
  const dir = repo({ "package.json": PKG, "A.slnx": "", "B.slnx": "", "src/A/A.csproj": "" });
  const open = planFiles(dir, { templates });
  assert.equal(open.stops.length, 1);
  assert.equal(open.stops[0].module, "dotnet");
  const reason = "One solution per week (2026-10-02).";
  const plan = planFiles(dir, { templates, exceptions: { dotnet: reason } });
  assert.deepEqual(plan.stops, []);
  assert.equal(plan.inputs.dotnet, "");
  assert.deepEqual(plan.notes, [`dotnet stays off: ${reason}`]);
});

test("in a git work tree the tree is what git would add: an ignored folder is invisible", () => {
  const dir = repo({
    ".gitignore": "ignored/\n",
    "ignored/package.json": PKG,
    "web/package.json": PKG,
    "gone.txt": "",
  });
  assert.equal(spawnSync("git", ["-C", dir, "init", "-q"]).status, 0);
  const plan = planFiles(dir, { templates });
  assert.equal(plan.inputs.node, "web");
  assert.deepEqual(plan.stops, []);
  assert.deepEqual(
    plan.ecosystems.map((e) => `${e.ecosystem} ${e.directory}`),
    ["github-actions /", "npm /web"],
  );
  assert.doesNotMatch(file(plan, DEPENDABOT).content, /directory: \/ignored/);
  spawnSync("git", ["-C", dir, "add", "gone.txt"]);
  rmSync(join(dir, "gone.txt"));
  assert.doesNotThrow(() => planFiles(dir, { templates }));
  const plain = repo({ ".gitignore": "ignored/\n", "ignored/package.json": PKG });
  assert.equal(planFiles(plain, { templates }).inputs.node, "ignored");
});

test("a write that fails halfway is reported: the plan lines, what was written, the error, exit 1", async () => {
  const dir = repo({ "package.json": PKG });
  // A directory where the Dependabot file goes: the plan sees no file and says create.
  mkdirSync(join(dir, DEPENDABOT), { recursive: true });
  const out = await runApply(["files", "--dir", dir, "--apply"], {}, { templates });
  assert.equal(out.exitCode, 1);
  assert.ok(out.lines[0].startsWith('inputs  node="."'));
  assert.ok(out.lines.includes(`create  ${CALLER}`));
  assert.ok(out.lines.includes(`create  ${DEPENDABOT}`));
  assert.ok(out.lines.includes(`wrote   ${CALLER}`));
  assert.ok(!out.lines.includes(`wrote   ${DEPENDABOT}`));
  const last = out.lines.at(-1);
  assert.ok(last.startsWith("error   Stopped writing:"), last);
  assert.ok(existsSync(join(dir, CALLER)));
});
