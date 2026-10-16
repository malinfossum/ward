import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  addCodeqlJob,
  CALLER,
  DEPENDABOT,
  mergeRuleset,
  PROPS,
  planAutomerge,
  planFiles,
  planInputs,
  planRuleset,
  planSettings,
  readState,
  readTemplates,
  renderCaller,
  renderDependabot,
  runApply,
  sameRuleset,
  statusLine,
  writeFiles,
} from "./apply.mjs";
import { parseCaller, request } from "./repo-audit.mjs";
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

test("a stop names the inputs it leaves unset, the tied one first", () => {
  const paths = ["App.slnx", "src/A/A.csproj", "src/B/B.csproj"];
  assert.deepEqual(plan(["web/package.json", "api/package.json"]).stops[0].inputs, ["node"]);
  assert.deepEqual(plan(["A.slnx", "B.slnx", "src/A/A.csproj"]).stops[0].inputs, ["dotnet"]);
  const twoEf = plan(paths, { "src/A/A.csproj": SQLITE, "src/B/B.csproj": SQLITE });
  assert.deepEqual(twoEf.stops[0].inputs, ["dotnet-ef-project", "dotnet-ef-startup-project"]);
  const twoDesign = plan(paths, { "src/A/A.csproj": DESIGN, "src/B/B.csproj": DESIGN });
  assert.deepEqual(twoDesign.stops[0].inputs, ["dotnet-ef-project", "dotnet-ef-startup-project"]);
  const efAndTwoDesign = plan(["App.slnx", "src/A/A.csproj", "src/B/B.csproj", "src/C/C.csproj"], {
    "src/A/A.csproj": SQLITE,
    "src/B/B.csproj": DESIGN,
    "src/C/C.csproj": DESIGN,
  });
  assert.deepEqual(efAndTwoDesign.stops[0].inputs, ["dotnet-ef-startup-project"]);
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

// The template's codeql job with the blank line above it: a caller from before
// v1.4.0 is the template without it.
const CODEQL_BLOCK = /\n {2}# CodeQL[^\n]*\n {2}codeql:\n(?: {4}[^\n]*\n)+/;
const AUTOMERGE_BLOCK = /\n {2}automerge:\n(?: {4}[^\n]*\n)+/;
const crlf = (text) => text.replaceAll("\n", "\r\n");

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

test("a caller without the codeql job gets it before automerge, in its own line endings", () => {
  const full = caller({ node: "." });
  const old = full.replace(CODEQL_BLOCK, "");
  assert.notEqual(old, full, "the template has no codeql block to remove");
  const dir = repo({ [CALLER]: old, "package.json": PKG });
  const edit = file(planFiles(dir, { templates }), CALLER);
  assert.deepEqual([edit.action, edit.detail], ["edit", "add the codeql job"]);
  assert.equal(edit.content, full);
  writeFileSync(join(dir, CALLER), crlf(old));
  assert.equal(file(planFiles(dir, { templates }), CALLER).content, crlf(full));
});

test("a caller without automerge gets the codeql job at the end, and a hand edit survives", () => {
  const full = caller({ node: "." })
    .replace(AUTOMERGE_BLOCK, "")
    .replace('a11y: "off"', 'a11y: "warn"');
  const old = full.replace(CODEQL_BLOCK, "");
  const dir = repo({ [CALLER]: old, "package.json": PKG });
  const plan = planFiles(dir, { templates });
  assert.equal(file(plan, CALLER).content, full);
  assert.deepEqual(writeFiles(dir, plan), [CALLER, DEPENDABOT]);
  assert.equal(readFileSync(join(dir, CALLER), "utf8"), full);
  assert.equal(file(planFiles(dir, { templates }), CALLER).action, "keep");
});

test("input drift plus a missing codeql job stays drift; an unpinned codeql job is drift", () => {
  const dir = repo({
    [CALLER]: caller({ node: "." }).replace(CODEQL_BLOCK, ""),
    "web/package.json": PKG,
  });
  const drift = file(planFiles(dir, { templates }), CALLER);
  assert.equal(drift.action, "drift");
  assert.equal(drift.detail, 'node is ".", the files say "web"; no codeql job');
  const floating = caller({ node: "." }).replace(/codeql\.yml@[0-9a-f]{40}/, "codeql.yml@v1");
  const pinless = repo({ [CALLER]: floating, "package.json": PKG });
  const unpinned = file(planFiles(pinless, { templates }), CALLER);
  assert.equal(unpinned.action, "drift");
  assert.equal(
    unpinned.detail,
    "the codeql job uses malinfossum/ward/.github/workflows/codeql.yml@v1, not a full commit SHA",
  );
});

test("a codeql job that calls something else is drift, never a second codeql key", () => {
  const foreign = caller({ node: "." }).replace(
    /uses: malinfossum\/ward\/\.github\/workflows\/codeql\.yml@\S+/,
    "uses: github/codeql-action/analyze@v3",
  );
  assert.equal(addCodeqlJob(foreign, templates.caller), null);
  const commented = foreign.replace("  codeql:", "  codeql: # scan");
  assert.equal(addCodeqlJob(commented, templates.caller), null);
  const quoted = foreign.replace("  codeql:", '  "codeql":');
  assert.equal(addCodeqlJob(quoted, templates.caller), null);
  const dir = repo({ [CALLER]: foreign, "package.json": PKG });
  const plan = planFiles(dir, { templates });
  const drift = file(plan, CALLER);
  assert.equal(drift.action, "drift");
  assert.equal(
    drift.detail,
    "a codeql job exists but does not call malinfossum/ward/.github/workflows/codeql.yml; fix it by hand",
  );
  assert.equal(drift.content, undefined);
  writeFiles(dir, plan);
  assert.equal(readFileSync(join(dir, CALLER), "utf8"), foreign);
});

test("a caller whose jobs are not indented two spaces is drift, never a broken edit", () => {
  const four = caller({ node: "." }).replace(CODEQL_BLOCK, "").replace(/^( +)/gm, "$1$1");
  const dir = repo({ [CALLER]: four, "package.json": PKG });
  const plan = file(planFiles(dir, { templates }), CALLER);
  assert.equal(plan.action, "drift");
  assert.equal(
    plan.detail,
    "jobs are not indented two spaces; add the codeql job from templates/ward.yml by hand",
  );
});

// Hugin, as the v1.4.0 migration found it: a caller from before the codeql
// job and before the startup input, two projects referencing EF Core at the
// same depth, and no Directory.Build.props.
const HUGIN = {
  "Hugin.slnx": "",
  "Hugin.Infrastructure/Hugin.Infrastructure.csproj": `<Project>${SQLITE}</Project>`,
  "Hugin.Tests/Hugin.Tests.csproj": `<Project>${SQLITE}</Project>`,
};
const huginCaller = (ef) =>
  caller({ dotnet: "Hugin.slnx", "dotnet-ef-project": ef })
    .replace(CODEQL_BLOCK, "")
    .replace(/^ {6}dotnet-ef-startup-project:.*\n/m, "");

test("a tie for an input the caller already sets is not a stop: the value is kept, the codeql job is the only edit", async () => {
  const dir = repo({ ...HUGIN, [CALLER]: huginCaller("") });
  const plan = planFiles(dir, { templates });
  assert.deepEqual(plan.stops, []);
  assert.equal(plan.inputs["dotnet-ef-project"], "");
  assert.equal(plan.inputs["dotnet-ef-startup-project"], "");
  const edit = file(plan, CALLER);
  assert.deepEqual([edit.action, edit.detail], ["edit", "add the codeql job"]);
  assert.equal(
    edit.content,
    huginCaller("").replace(AUTOMERGE_BLOCK, (block) => {
      const full = caller({ dotnet: "Hugin.slnx" });
      return full.slice(full.search(CODEQL_BLOCK), full.search(AUTOMERGE_BLOCK)) + block;
    }),
  );
  // Directory.Build.props is still planned: a caller-only run discards it or accepts it.
  assert.deepEqual(actions(plan), [
    [CALLER, "edit"],
    [DEPENDABOT, "create"],
    [PROPS, "create"],
  ]);
  const run = await runApply(["files", "--dir", dir], {}, { templates });
  assert.equal(run.exitCode, 0);
  assert.ok(run.lines.includes(`edit    ${CALLER}: add the codeql job`));
  assert.ok(run.lines.includes(`create  ${PROPS}`));
  assert.ok(!run.lines.some((l) => l.startsWith("stop")));
});

test("a settled input keeps the caller's own value, and the caller is kept once it has the codeql job", () => {
  const dir = repo({ ...HUGIN, [CALLER]: huginCaller("Hugin.Infrastructure") });
  const plan = planFiles(dir, { templates });
  assert.deepEqual(plan.stops, []);
  assert.equal(plan.inputs["dotnet-ef-project"], "Hugin.Infrastructure");
  assert.equal(file(plan, CALLER).action, "edit");
  const done = repo({
    ...HUGIN,
    [CALLER]: caller({ dotnet: "Hugin.slnx", "dotnet-ef-project": "Hugin.Infrastructure" }),
  });
  assert.deepEqual(planFiles(done, { templates }).stops, []);
  assert.equal(file(planFiles(done, { templates }), CALLER).action, "keep");
});

test("a tie for an input the caller does not mention, or a caller that does not parse, stays a stop", async () => {
  const silent = huginCaller("").replace(/^ {6}dotnet-ef-project:.*\n/m, "");
  const dir = repo({ ...HUGIN, [CALLER]: silent });
  const plan = planFiles(dir, { templates });
  assert.equal(plan.stops.length, 1);
  assert.equal(plan.stops[0].inputs[0], "dotnet-ef-project");
  const run = await runApply(["files", "--dir", dir, "--apply"], {}, { templates });
  assert.equal(run.exitCode, 1);
  assert.ok(!existsSync(join(dir, PROPS)));
  const foreign = repo({ ...HUGIN, [CALLER]: "jobs:\n  ci:\n    uses: other/ci.yml@v1\n" });
  assert.equal(planFiles(foreign, { templates }).stops.length, 1);
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

// A fetch stub that records method, path, auth and the parsed body of every
// call, and answers from routes [pattern, status, body, method?]; first match
// wins, and a route with a method answers only that method.
function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push({
      method: init.method ?? "GET",
      path,
      auth: init.headers?.Authorization ?? "",
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const method = init.method ?? "GET";
    const route = routes.find(
      ([pattern, , , only]) => pattern.test(path) && (!only || only === method),
    );
    if (!route) return new Response(null, { status: 599 });
    const [, status, body] = route;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return {
    calls,
    writes: () => calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path]),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const SCAN_OFF = { status: "disabled" };
const ON = { status: "enabled" };
const META = {
  full_name: "malinfossum/x",
  default_branch: "main",
  allow_auto_merge: false,
  security_and_analysis: { secret_scanning: SCAN_OFF, secret_scanning_push_protection: SCAN_OFF },
};
const GATE = {
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: false,
    required_status_checks: [{ context: "ward / gate" }],
  },
};
// A bare repo: nothing on, no ruleset, CodeQL never ran. The reads answer GET
// only, so a write needs its own route; overrides go first.
const READS = [
  [/^\/repos\/malinfossum\/x$/, 200, META],
  [/\/git\/trees\/main/, 200, { truncated: false, tree: [] }],
  [/\/contents\//, 404],
  [/\/rules\/branches\/main$/, 200, []],
  [/\/automated-security-fixes$/, 404],
  [/\/vulnerability-alerts$/, 404],
  [/\/code-scanning\/default-setup$/, 200, { state: "not-configured", languages: ["javascript"] }],
  [/\/branches\/main\/protection$/, 404],
  [/\/rulesets$/, 200, []],
  [/\/code-scanning\/analyses/, 404],
  [/\/pulls\?/, 200, []],
].map(([pattern, status, body]) => [pattern, status, body, "GET"]);
const WRITES = [
  [/\/(vulnerability-alerts|automated-security-fixes)$/, 204, undefined, "PUT"],
  [/^\/repos\/malinfossum\/x$/, 200, {}, "PATCH"],
  [/\/code-scanning\/default-setup$/, 202, {}, "PATCH"],
];
const bareRoutes = (overrides = []) => [...overrides, ...READS, ...WRITES];
const ENV = { GITHUB_TOKEN: "t" };
const b64 = (text) => Buffer.from(text).toString("base64");

test("request sends a JSON body with the method and the token", async () => {
  const stub = stubFetch([[/./, 200, { ok: true }]]);
  try {
    const res = await request("/repos/a/b", "t", { method: "PATCH", body: { x: 1 } });
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    assert.deepEqual(stub.calls[0], {
      method: "PATCH",
      path: "/repos/a/b",
      auth: "Bearer t",
      body: { x: 1 },
    });
  } finally {
    stub.restore();
  }
});

test("settings: plans the three changes a bare repo needs and makes them only with --apply", async () => {
  const stub = stubFetch(bareRoutes());
  try {
    const dry = await runApply(["settings", "malinfossum/x"], ENV);
    assert.equal(dry.exitCode, 0);
    assert.deepEqual(
      dry.lines.filter((l) => l.startsWith("set")).map((l) => l.slice(8)),
      [
        "Dependabot alerts on",
        "Dependabot security updates on",
        "secret scanning and push protection on",
      ],
    );
    assert.deepEqual(stub.writes(), []);
    const wet = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.deepEqual(stub.writes(), [
      ["PUT", "/repos/malinfossum/x/vulnerability-alerts"],
      ["PUT", "/repos/malinfossum/x/automated-security-fixes"],
      ["PATCH", "/repos/malinfossum/x"],
    ]);
    const patches = stub.calls.filter((c) => c.method === "PATCH").map((c) => c.body);
    assert.deepEqual(patches[0], {
      security_and_analysis: { secret_scanning: ON, secret_scanning_push_protection: ON },
    });
    assert.equal(wet.lines.filter((l) => l.startsWith("done")).length, 3);
    assert.ok(stub.calls.every((c) => c.auth === "Bearer t"));
  } finally {
    stub.restore();
  }
});

test("settings: everything on is kept; a setting the token cannot read is a stop, never a blind write", async () => {
  const onMeta = {
    ...META,
    security_and_analysis: { secret_scanning: ON, secret_scanning_push_protection: ON },
  };
  const stub = stubFetch(
    bareRoutes([
      [/^\/repos\/malinfossum\/x$/, 200, onMeta],
      [/\/automated-security-fixes$/, 200, { enabled: true, paused: false }],
      [/\/vulnerability-alerts$/, 204],
      [
        /\/code-scanning\/default-setup$/,
        200,
        { state: "not-configured", languages: ["javascript"] },
      ],
    ]),
  );
  try {
    const kept = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.ok(kept.lines.includes("keep    every setting is already on"));
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
  const { security_and_analysis: _, ...notAdmin } = META;
  const blind = stubFetch(bareRoutes([[/^\/repos\/malinfossum\/x$/, 200, notAdmin]]));
  try {
    const stop = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(stop.exitCode, 1);
    assert.ok(
      stop.lines.some((l) => l.startsWith("stop    The token cannot read this repo's settings")),
    );
    assert.deepEqual(blind.writes(), []);
  } finally {
    blind.restore();
  }
});

test("settings: an API failure mid-apply keeps the lines before it and stops", async () => {
  const stub = stubFetch(
    bareRoutes([[/^\/repos\/malinfossum\/x$/, 422, { message: "nope" }, "PATCH"]]),
  );
  try {
    const { lines, exitCode } = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(exitCode, 1);
    assert.deepEqual(
      lines.filter((l) => /^(done|error)/.test(l)),
      [
        "done    Dependabot alerts on",
        "done    Dependabot security updates on",
        'error   GitHub API 422 on /repos/malinfossum/x: {"message":"nope"}',
      ],
    );
    assert.equal(stub.writes().length, 3);
  } finally {
    stub.restore();
  }
});

test("settings: a refused write (403) is an error, not done, and stops the rest", async () => {
  const stub = stubFetch(
    bareRoutes([[/\/automated-security-fixes$/, 403, { message: "no" }, "PUT"]]),
  );
  try {
    const { lines, exitCode } = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(exitCode, 1);
    assert.deepEqual(
      lines.filter((l) => /^(set|done|error)/.test(l)),
      [
        "set     Dependabot alerts on",
        "set     Dependabot security updates on",
        "set     secret scanning and push protection on",
        "done    Dependabot alerts on",
        "error   Dependabot security updates on 403",
      ],
    );
    assert.equal(stub.writes().length, 2);
  } finally {
    stub.restore();
  }
});

test("request returns the status of a write, and null for an empty body", async () => {
  const stub = stubFetch([[/./, 204]]);
  try {
    assert.deepEqual(await request("/repos/a/b/x", "t", { method: "PUT" }), {
      status: 204,
      body: null,
    });
  } finally {
    stub.restore();
  }
  const accepted = stubFetch([[/./, 202]]);
  try {
    assert.deepEqual(await request("/repos/a/b/x", "t", { method: "PATCH", body: {} }), {
      status: 202,
      body: null,
    });
  } finally {
    accepted.restore();
  }
});

test("settings and status without a token or with a bad repo name are a stop", async () => {
  const noToken = await runApply(["settings", "malinfossum/x"], {});
  assert.equal(noToken.exitCode, 1);
  assert.ok(noToken.lines.some((l) => /GITHUB_TOKEN is not set/.test(l)));
  const badName = await runApply(["status", "x"], ENV);
  assert.equal(badName.exitCode, 1);
  assert.ok(badName.lines[0].startsWith("usage"));
});

// Everything but CodeQL already on, so the CodeQL line is the only decision left.
const SET_ON = {
  ...META,
  security_and_analysis: { secret_scanning: ON, secret_scanning_push_protection: ON },
};
const settled = (overrides) =>
  bareRoutes([
    ...overrides,
    [/^\/repos\/malinfossum\/x$/, 200, SET_ON, "GET"],
    [/\/automated-security-fixes$/, 200, { enabled: true, paused: false }, "GET"],
    [/\/vulnerability-alerts$/, 204, undefined, "GET"],
  ]);
const defaultSetupOn = (languages) => [
  /\/code-scanning\/default-setup$/,
  200,
  { state: "configured", languages },
  "GET",
];
const treeOf = (paths) => [
  /\/git\/trees\/main/,
  200,
  { truncated: false, tree: paths.map((path) => ({ type: "blob", path })) },
  "GET",
];
const onBranch = (text) => [
  /\/contents\/\.github\/workflows\/ward\.yml$/,
  200,
  { content: b64(text) },
  "GET",
];
const WITH_JOB = caller({ node: "." });
const WITHOUT_JOB = WITH_JOB.replace(CODEQL_BLOCK, "");

// A checkout of a repo with its files staged, as files --apply leaves it.
function checkout(files, origin) {
  const dir = repo(files);
  const git = (...args) => spawnSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  if (origin) git("remote", "add", "origin", origin);
  git("add", ".");
  return dir;
}

test("settings: default setup goes off when the default branch's caller has the codeql job", async () => {
  const stub = stubFetch(
    settled([
      defaultSetupOn(["actions", "javascript", "typescript"]),
      treeOf([CALLER, "src/app.ts"]),
      onBranch(WITH_JOB),
    ]),
  );
  try {
    const dry = await runApply(["settings", "malinfossum/x"], ENV);
    assert.equal(dry.exitCode, 0);
    assert.deepEqual(
      dry.lines.filter((l) => /^(set|stop)/.test(l)),
      ["set     CodeQL default setup off"],
    );
    assert.ok(
      dry.lines.includes(
        "note    GitHub turns default setup off in the background: push only once status reads default-setup=not-configured.",
      ),
    );
    assert.deepEqual(stub.writes(), []);
    const wet = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(wet.exitCode, 0);
    assert.deepEqual(stub.writes(), [
      ["PATCH", "/repos/malinfossum/x/code-scanning/default-setup"],
    ]);
    assert.deepEqual(stub.calls.at(-1).body, { state: "not-configured" });
    assert.ok(wet.lines.includes("done    CodeQL default setup off"));
  } finally {
    stub.restore();
  }
});

test("settings: default setup stays on, with a note, while no caller has the codeql job", async () => {
  const stub = stubFetch(
    settled([defaultSetupOn(["actions"]), treeOf([CALLER]), onBranch(WITHOUT_JOB)]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(out.exitCode, 0);
    assert.ok(
      out.lines.includes(
        "note    CodeQL default setup stays on until the caller has the codeql job; run files --apply, then settings --dir <checkout>.",
      ),
    );
    assert.ok(!out.lines.some((l) => l.startsWith("set")));
    assert.ok(!out.lines.some((l) => l.startsWith("keep")));
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
});

// The codeql job's ref is the part that decides whether Ward's scan will run.
const withRef = (ref) =>
  WITH_JOB.replace(/uses: malinfossum\/ward\/\.github\/workflows\/codeql\.yml@\S+/, `uses: ${ref}`);

for (const [what, ref] of [
  ["a local path on a repo that is not Ward", "./.github/workflows/codeql.yml"],
  ["a foreign workflow", `other/repo/.github/workflows/codeql.yml@${"a".repeat(40)}`],
]) {
  test(`settings: default setup stays on when the codeql job is ${what}`, async () => {
    const stub = stubFetch(
      settled([defaultSetupOn(["actions"]), treeOf([CALLER]), onBranch(withRef(ref))]),
    );
    try {
      const out = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
      assert.equal(out.exitCode, 0);
      assert.ok(
        out.lines.includes(
          "note    CodeQL default setup stays on until the caller has the codeql job; run files --apply, then settings --dir <checkout>.",
        ),
      );
      assert.ok(!out.lines.some((l) => l.startsWith("set")));
      assert.deepEqual(stub.writes(), []);
    } finally {
      stub.restore();
    }
  });
}

test("settings: on Ward itself the local codeql path counts as the job", async () => {
  const stub = stubFetch(
    settled([
      [/^\/repos\/malinfossum\/ward$/, 200, { ...SET_ON, full_name: "malinfossum/ward" }, "GET"],
      defaultSetupOn(["actions", "javascript"]),
      treeOf([CALLER, "src/app.js"]),
      onBranch(withRef("./.github/workflows/codeql.yml")),
    ]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/ward"], ENV);
    assert.equal(out.exitCode, 0);
    assert.ok(out.lines.includes("set     CodeQL default setup off"));
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
});

test("settings: --dir shows the job from a checkout of the same repo before it is merged", async () => {
  const dir = checkout(
    { [CALLER]: WITH_JOB, "src/app.ts": "" },
    "https://github.com/MalinFossum/X.git",
  );
  const stub = stubFetch(
    settled([defaultSetupOn(["actions", "typescript"]), treeOf([CALLER]), onBranch(WITHOUT_JOB)]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/x", "--dir", dir, "--apply"], ENV);
    assert.equal(out.exitCode, 0);
    assert.ok(out.lines.includes("set     CodeQL default setup off"));
    assert.deepEqual(stub.writes(), [
      ["PATCH", "/repos/malinfossum/x/code-scanning/default-setup"],
    ]);
  } finally {
    stub.restore();
  }
});

test("settings: a --dir that is not a checkout of the repo is a stop, and nothing is written", async () => {
  const other = checkout({ [CALLER]: WITH_JOB }, "git@github.com:malinfossum/ward.git");
  const none = checkout({ [CALLER]: WITH_JOB }, "");
  const stub = stubFetch(
    settled([defaultSetupOn(["actions"]), treeOf([CALLER]), onBranch(WITHOUT_JOB)]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/x", "--dir", other, "--apply"], ENV);
    assert.equal(out.exitCode, 1);
    assert.deepEqual(out.lines, [
      `stop    ${other} is a checkout of malinfossum/ward, not malinfossum/x.`,
    ]);
    const bare = await runApply(["settings", "malinfossum/x", "--dir", none, "--apply"], ENV);
    assert.equal(bare.exitCode, 1);
    assert.match(
      bare.lines[0],
      /^stop {4}.* is a checkout of no GitHub repo, not malinfossum\/x\.$/,
    );
    const missing = await runApply(["settings", "malinfossum/x", "--dir"], ENV);
    assert.equal(missing.exitCode, 1);
    assert.deepEqual(missing.lines, ["stop    --dir is not a directory I can read."]);
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
});

test("settings: a language default setup scans and the codeql job would not is a stop", async () => {
  const stub = stubFetch(
    settled([
      defaultSetupOn(["actions", "c-cpp"]),
      treeOf([CALLER, "include/lib.h", "vendor/x.min.js"]),
      onBranch(WITH_JOB),
    ]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(out.exitCode, 1);
    assert.ok(
      out.lines.includes(
        "stop    CodeQL default setup scans c-cpp, which the codeql job would not; add it to tools/codeql-languages.mjs first.",
      ),
    );
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
});

const SETTLED = {
  alerts: true,
  securityUpdates: { enabled: true, paused: false },
  analysis: { secret_scanning: ON, secret_scanning_push_protection: ON },
};

test("planSettings: javascript and typescript fold into one; a language outside the table stops", () => {
  const on = (languages) => ({ ...SETTLED, codeScanning: { state: "configured", languages } });
  const folded = planSettings(on(["javascript", "typescript", "actions"]), {
    job: true,
    languages: ["actions", "javascript-typescript"],
  });
  assert.deepEqual(folded.stops, []);
  assert.deepEqual(folded.actions, [
    {
      what: "CodeQL default setup off",
      method: "PATCH",
      path: "/code-scanning/default-setup",
      body: { state: "not-configured" },
    },
  ]);
  const go = planSettings(on(["actions", "go"]), { job: true, languages: ["actions"] });
  assert.deepEqual(go.actions, []);
  assert.deepEqual(go.stops, [
    "CodeQL default setup scans go, which the codeql job would not; add it to tools/codeql-languages.mjs first.",
  ]);
  const off = { ...SETTLED, codeScanning: { state: "not-configured", languages: [] } };
  assert.deepEqual(planSettings(off, { job: false, languages: ["actions"] }), {
    stops: [],
    actions: [],
    notes: [],
  });
});

test("planSettings: default setup that does not list its languages is a stop, never a blind off", () => {
  const plan = planSettings(
    { ...SETTLED, codeScanning: { state: "configured" } },
    { job: true, languages: ["actions"] },
  );
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.stops, [
    "CodeQL default setup does not say which languages it scans, so I cannot check the codeql job covers them.",
  ]);
});

test("planSettings: a private repo gets a note to leave the codeql job out", () => {
  const plan = planSettings(
    { ...SETTLED, codeScanning: { state: "not-configured", languages: [] } },
    { isPrivate: true },
  );
  assert.deepEqual(plan.notes, [
    "This repo is private: CodeQL here needs GitHub Advanced Security, so leave the codeql job out of its caller.",
  ]);
});

test("status prints one line with the state, and readState sees classic protection and open Dependabot PRs", async () => {
  const stub = stubFetch(
    bareRoutes([
      [/\/branches\/main\/protection$/, 200, { enabled: true }],
      [
        /\/pulls\?/,
        200,
        [
          { number: 7, user: { login: "dependabot[bot]" } },
          { number: 8, user: { login: "me" } },
        ],
      ],
      [/\/rules\/branches\/main$/, 200, [{ type: "deletion" }, GATE]],
    ]),
  );
  try {
    const state = await readState("malinfossum/x", "t");
    assert.equal(state.classic, true);
    assert.deepEqual(state.dependabotPulls, [7]);
    assert.equal(state.analysed, false);
    assert.equal(
      statusLine(state),
      "malinfossum/x: auto-merge=false secret-scanning=disabled push-protection=disabled default-setup=not-configured analysed=false rulesets=0+classic rules=deletion,required_status_checks",
    );
    const { lines } = await runApply(["status", "malinfossum/x"], ENV);
    assert.equal(lines[0], `status  ${statusLine(state)}`);
  } finally {
    stub.restore();
  }
});

test("status says unread, not none, when the ruleset list or the branch rules cannot be read", async () => {
  const stub = stubFetch(
    bareRoutes([
      [/\/rulesets$/, 403],
      [/\/rules\/branches\/main$/, 403],
    ]),
  );
  try {
    const state = await readState("malinfossum/x", "t");
    assert.equal(state.rulesetsRead, false);
    assert.deepEqual(state.rulesets, []);
    assert.equal(state.existing, null);
    const { lines } = await runApply(["status", "malinfossum/x"], ENV);
    assert.match(lines[0], / rulesets=unread rules=unread$/);
  } finally {
    stub.restore();
  }
});

const RULESET = JSON.parse(readFileSync("templates/ruleset.json", "utf8"));
const ADMIN = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
// What the API hands back for a ruleset apply created: ids, extra parameters, same rules.
const asExisting = (body, id = 42) => {
  const copy = structuredClone(body);
  const rules = copy.rules.map((rule) =>
    rule.type === "pull_request"
      ? { ...rule, parameters: { ...rule.parameters, allowed_merge_methods: ["squash"] } }
      : rule,
  );
  return { id, ...copy, rules };
};
const types = (body) => body.rules.map((rule) => rule.type);
const checks = (body) =>
  body.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks;

test("mergeRuleset keeps a repo's own required checks and foreign rule types beside the template", () => {
  const existing = {
    id: 1,
    rules: [
      { type: "required_linear_history" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "api-tests", integration_id: 15368 }],
        },
      },
    ],
  };
  const body = mergeRuleset(RULESET, existing);
  assert.deepEqual(types(body), [...types(RULESET), "required_linear_history"]);
  assert.deepEqual(checks(body), [
    { context: "ward / gate" },
    { context: "api-tests", integration_id: 15368 },
  ]);
  assert.equal(
    body.rules.find((r) => r.type === "required_status_checks").parameters
      .strict_required_status_checks_policy,
    false,
  );
  assert.deepEqual(body.bypass_actors, []);
  assert.deepEqual(
    types(mergeRuleset(RULESET, null, { noCodeql: true })),
    types(RULESET).filter((t) => t !== "code_scanning"),
  );
  assert.deepEqual(mergeRuleset(RULESET, null, { bypassAdmin: true }).bypass_actors, ADMIN);
  assert.deepEqual(RULESET.bypass_actors, [], "the template was mutated");
});

test("sameRuleset ignores what the API adds and notices what I would change", () => {
  const body = mergeRuleset(RULESET, null);
  assert.equal(sameRuleset(asExisting(body), body), true);
  const withAdmin = mergeRuleset(RULESET, null, { bypassAdmin: true });
  assert.equal(sameRuleset(asExisting(body), withAdmin), false);
  const fewerChecks = asExisting(body);
  checks(fewerChecks).length = 0;
  assert.equal(sameRuleset(fewerChecks, body), false);
  const extraRule = asExisting(body);
  extraRule.rules.push({ type: "required_linear_history" });
  assert.equal(sameRuleset(extraRule, body), false);
  assert.equal(sameRuleset(extraRule, mergeRuleset(RULESET, extraRule)), true);
});

const state = (over = {}) => ({
  repo: "malinfossum/x",
  branch: "main",
  meta: { allow_auto_merge: false },
  baseline: { rules: [] },
  classic: false,
  rulesetsRead: true,
  rulesets: [],
  existing: null,
  analysed: true,
  dependabotPulls: [],
  ...over,
});

test("planRuleset: classic protection or two rulesets stop; no CodeQL analysis waits unless --no-codeql", () => {
  assert.match(
    planRuleset(state({ classic: true }), RULESET).stops[0],
    /Classic branch protection/,
  );
  assert.match(
    planRuleset(state({ rulesetsRead: false }), RULESET).stops[0],
    /cannot list this repo's rulesets/,
  );
  const two = planRuleset(state({ rulesets: [{ id: 1 }, { id: 2 }] }), RULESET);
  assert.match(two.stops[0], /More than one branch ruleset \(1, 2\)/);
  const waiting = planRuleset(state({ analysed: false }), RULESET);
  assert.match(waiting.wait, /CodeQL has not analysed main yet/);
  assert.equal(waiting.action, "");
  const noLanguage = state({
    analysed: false,
    baseline: { rules: [], codeScanning: { languages: [] } },
  });
  assert.match(planRuleset(noLanguage, RULESET).wait, /never analyse it; rerun with --no-codeql/);
  const skipped = planRuleset(state({ analysed: false }), RULESET, { noCodeql: true });
  assert.equal(skipped.action, "create");
  assert.ok(!types(skipped.body).includes("code_scanning"));
});

test("planRuleset: create when none, keep when equal, update when it differs", () => {
  assert.equal(planRuleset(state(), RULESET).action, "create");
  const body = mergeRuleset(RULESET, null);
  const same = state({ rulesets: [{ id: 42 }], existing: asExisting(body) });
  assert.equal(planRuleset(same, RULESET).action, "keep");
  assert.equal(planRuleset(same, RULESET, { bypassAdmin: true }).action, "update");
});

test("ruleset command: POST when none, PUT by id when one, nothing without --apply or on wait", async () => {
  const stub = stubFetch(
    bareRoutes([
      [/\/code-scanning\/analyses/, 200, [{ id: 1 }], "GET"],
      [/\/rulesets$/, 201, { id: 42 }, "POST"],
    ]),
  );
  try {
    const dry = await runApply(["ruleset", "malinfossum/x"], ENV);
    assert.ok(
      dry.lines[0].startsWith(
        'create  ruleset "main" with deletion, non_fast_forward, pull_request, required_status_checks, code_scanning',
      ),
    );
    assert.deepEqual(stub.writes(), []);
    const applied = await runApply(["ruleset", "malinfossum/x", "--apply", "--bypass-admin"], ENV);
    assert.deepEqual(stub.writes(), [["POST", "/repos/malinfossum/x/rulesets"]]);
    assert.deepEqual(stub.calls.at(-1).body.bypass_actors, ADMIN);
    assert.equal(applied.exitCode, 0);
    assert.equal(applied.lines.at(-1), "done    ruleset created");
  } finally {
    stub.restore();
  }
  const body = mergeRuleset(RULESET, null);
  const one = stubFetch(
    bareRoutes([
      [/\/code-scanning\/analyses/, 200, [{ id: 1 }], "GET"],
      [
        /\/rulesets$/,
        200,
        [
          { id: 42, target: "branch" },
          { id: 43, target: "tag" },
        ],
        "GET",
      ],
      [/\/rulesets\/42$/, 200, asExisting(body), "GET"],
      [/\/rulesets\/42$/, 200, { id: 42 }, "PUT"],
    ]),
  );
  try {
    const kept = await runApply(["ruleset", "malinfossum/x", "--apply"], ENV);
    assert.ok(kept.lines[0].startsWith("keep    ruleset"));
    assert.deepEqual(one.writes(), []);
    await runApply(["ruleset", "malinfossum/x", "--apply", "--no-codeql"], ENV);
    assert.deepEqual(one.writes(), [["PUT", "/repos/malinfossum/x/rulesets/42"]]);
  } finally {
    one.restore();
  }
  const waiting = stubFetch(bareRoutes());
  try {
    const wait = await runApply(["ruleset", "malinfossum/x", "--apply"], ENV);
    assert.equal(wait.exitCode, 1);
    assert.ok(wait.lines[0].startsWith("wait    CodeQL has not analysed main yet"));
    assert.deepEqual(waiting.writes(), []);
  } finally {
    waiting.restore();
  }
});

test("ruleset command: a refused write is an error line, and an unreadable protection is a stop", async () => {
  const refused = stubFetch(
    bareRoutes([
      [/\/code-scanning\/analyses/, 200, [{ id: 1 }], "GET"],
      [/\/rulesets$/, 403, { message: "no" }, "POST"],
    ]),
  );
  try {
    const result = await runApply(["ruleset", "malinfossum/x", "--apply"], ENV);
    assert.equal(result.exitCode, 1);
    assert.equal(result.lines.at(-1), "error   ruleset created 403");
  } finally {
    refused.restore();
  }
  // Classic protection reads 403 without admin, which must not pass for "no protection".
  const blind = stubFetch(
    bareRoutes([
      [/\/code-scanning\/analyses/, 200, [{ id: 1 }], "GET"],
      [/\/branches\/main\/protection$/, 403, { message: "admin" }, "GET"],
    ]),
  );
  try {
    const result = await runApply(["ruleset", "malinfossum/x", "--apply"], ENV);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines[0], /^stop {4}The token cannot list this repo's rulesets/);
    assert.deepEqual(blind.writes(), []);
  } finally {
    blind.restore();
  }
});

test("planAutomerge refuses until main requires ward / gate, then enables and rebases open Dependabot PRs", () => {
  const refused = planAutomerge(state());
  assert.match(refused.stops[0], /does not require "ward \/ gate"/);
  assert.equal(refused.enable, false);
  const ready = planAutomerge(state({ baseline: { rules: [GATE] }, dependabotPulls: [7, 9] }));
  assert.deepEqual(ready, { stops: [], enable: true, rebase: [7, 9] });
  const on = planAutomerge(
    state({ baseline: { rules: [GATE] }, meta: { allow_auto_merge: true }, dependabotPulls: [3] }),
  );
  assert.deepEqual(on, { stops: [], enable: false, rebase: [] });
});

test("automerge command: PATCH allow_auto_merge and one rebase comment per Dependabot PR, only with --apply", async () => {
  const stub = stubFetch(
    bareRoutes([
      [/\/rules\/branches\/main$/, 200, [GATE], "GET"],
      [/\/pulls\?/, 200, [{ number: 7, user: { login: "dependabot[bot]" } }], "GET"],
      [/\/issues\/7\/comments$/, 201, { id: 1 }, "POST"],
    ]),
  );
  try {
    const dry = await runApply(["automerge", "malinfossum/x"], ENV);
    assert.ok(dry.lines.includes("set     allow auto-merge"));
    assert.ok(dry.lines.includes("rebase  #7"));
    assert.deepEqual(stub.writes(), []);
    await runApply(["automerge", "malinfossum/x", "--apply"], ENV);
    assert.deepEqual(stub.writes(), [
      ["PATCH", "/repos/malinfossum/x"],
      ["POST", "/repos/malinfossum/x/issues/7/comments"],
    ]);
    assert.deepEqual(stub.calls.at(-2).body, { allow_auto_merge: true });
    assert.deepEqual(stub.calls.at(-1).body, { body: "@dependabot rebase" });
  } finally {
    stub.restore();
  }
  const unguarded = stubFetch(bareRoutes());
  try {
    const stop = await runApply(["automerge", "malinfossum/x", "--apply"], ENV);
    assert.equal(stop.exitCode, 1);
    assert.ok(stop.lines[0].startsWith("stop    main does not require"));
    assert.deepEqual(unguarded.writes(), []);
  } finally {
    unguarded.restore();
  }
});

test("docs/apply.md documents every command and every output word", () => {
  const doc = readFileSync("docs/apply.md", "utf8");
  for (const command of ["files", "settings", "ruleset", "automerge", "status"]) {
    assert.match(doc, new RegExp(`^\\| \`${command}[ \`]`, "m"), `${command} has no row`);
  }
  const words = [
    "inputs",
    "create",
    "edit",
    "keep",
    "drift",
    "ask",
    "note",
    "warn",
    "stop",
    "wait",
    "set",
    "update",
    "rebase",
    "done",
    "wrote",
    "status",
    "usage",
    "error",
  ];
  for (const word of words)
    assert.match(doc, new RegExp(`^\\| \`${word}\``, "m"), `${word} has no row`);
  assert.match(doc, /^\| `settings <owner\/repo> \[--dir <checkout>\]`/m);
  assert.match(doc, /default-setup=not-configured/);
  assert.match(doc, /`codeql` job/);
  assert.match(doc, /--apply/);
  assert.match(doc, /gh auth token/);
});
