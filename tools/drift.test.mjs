import assert from "node:assert/strict";
import { test } from "node:test";
import { guardedChanges, scriptsChanged } from "./drift.mjs";
import { BOM } from "./json.mjs";

test("files that decide what Ward checks are found at any depth", () => {
  const files = [
    ".github/workflows/ward.yml",
    "api/Directory.Build.props",
    "biome.json",
    "web/biome.jsonc",
    "global.json",
    "api/.config/dotnet-tools.json",
    "dotnet-tools.json",
    "src/app.js",
    "README.md",
  ];
  assert.deepEqual(guardedChanges(files), files.slice(0, 7));
});

test("a changed npm script counts as a change to the checks", () => {
  const before = JSON.stringify({ scripts: { test: "node --test" } });
  const after = JSON.stringify({ scripts: { test: "exit 0" } });
  assert.equal(scriptsChanged(before, after), true);
});

test("a dependency bump alone does not", () => {
  const before = JSON.stringify({ scripts: { test: "x" }, devDependencies: { a: "1.0.0" } });
  const after = JSON.stringify({ scripts: { test: "x" }, devDependencies: { a: "1.1.0" } });
  assert.equal(scriptsChanged(before, after), false);
});

test("a package.json with a UTF-8 BOM is read like npm reads it", () => {
  const before = `${BOM}{"scripts":{"test":"node --test"}}`;
  assert.equal(scriptsChanged(before, `${BOM}{"scripts":{"test":"exit 0"}}`), true);
  assert.equal(scriptsChanged(before, '{"scripts":{"test":"node --test"}}'), false);
});
