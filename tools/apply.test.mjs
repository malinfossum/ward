import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { planInputs, renderCaller, renderDependabot } from "./apply.mjs";
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
  assert.equal(tie.inputs.node, "");
  assert.match(
    tie.stops[0],
    /More than one package\.json at the same depth \(web\/package\.json, api\/package\.json\)/,
  );
});

test("dotnet is the solution file, or the only project when there is none", () => {
  assert.equal(plan(["App.slnx", "src/App/App.csproj"]).inputs.dotnet, "App.slnx");
  assert.equal(plan(["api/App.sln", "api/src/App/App.csproj"]).inputs.dotnet, "api/App.sln");
  assert.equal(plan(["Tool/Tool.csproj"]).inputs.dotnet, "Tool/Tool.csproj");
  const two = plan(["A/A.csproj", "B/B.csproj"]);
  assert.equal(two.inputs.dotnet, "");
  assert.match(two.stops[0], /More than one project file with no solution above it/);
  assert.equal(plan(["Legacy.sln", "App.slnx"]).stops.length, 1);
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
  assert.match(twoEf.stops[0], /More than one project referencing Microsoft\.EntityFrameworkCore/);
  assert.equal(twoEf.inputs["dotnet-ef-project"], "");
  const twoDesign = plan(paths, { "src/A/A.csproj": DESIGN, "src/B/B.csproj": DESIGN });
  assert.match(twoDesign.stops[0], /More than one project referencing/);
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
