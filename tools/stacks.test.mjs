import assert from "node:assert/strict";
import { test } from "node:test";
import { detectStacks, loadStacks } from "./stacks.mjs";

const stacks = loadStacks();
const names = (paths) => detectStacks(paths, stacks).map((s) => s.name);

test("stacks.json lists node and dotnet as shipped, with the caller input each needs", () => {
  const shipped = stacks.modules.filter((m) => m.status === "shipped");
  assert.deepEqual(
    shipped.map((m) => [m.name, m.input]),
    [
      ["node", "node"],
      ["dotnet", "dotnet"],
    ],
  );
  for (const module of stacks.modules) {
    assert.ok(["shipped", "planned"].includes(module.status), module.name);
    assert.ok(module.files.length > 0, `${module.name} has no detection files`);
  }
});

test("a package.json at the root or in a folder means node", () => {
  assert.deepEqual(names(["package.json", "src/app.js"]), ["node"]);
  assert.deepEqual(names(["web/package.json"]), ["node"]);
  assert.deepEqual(detectStacks(["web/package.json"], stacks)[0].files, ["web/package.json"]);
});

test("a solution or project file means dotnet", () => {
  assert.deepEqual(names(["App.slnx", "src/App/App.csproj"]), ["dotnet"]);
  assert.deepEqual(names(["Legacy.sln"]), ["dotnet"]);
});

test("files under node_modules, bin and obj are ignored, but a folder named cabin is not", () => {
  assert.deepEqual(names(["node_modules/x/package.json", "src/bin/Debug/App.csproj"]), []);
  assert.deepEqual(names(["cabin/package.json"]), ["node"]);
});

test("a stack no module covers is reported as planned", () => {
  const [python] = detectStacks(["pyproject.toml"], stacks);
  assert.equal(python.name, "python");
  assert.equal(python.status, "planned");
  assert.equal(python.input, "");
});

test("a repo with only docs has no stacks", () => {
  assert.deepEqual(names(["README.md", "docs/a.md"]), []);
});
