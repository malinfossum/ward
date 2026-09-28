import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTestProject, planDotnet, resolveTarget } from "./dotnet-check.mjs";

test("the default plan restores, builds, formats and tests", () => {
  assert.deepEqual(
    planDotnet().map((s) => s.args),
    [
      ["restore"],
      ["build", "--no-restore", "-warnaserror"],
      ["format", "--verify-no-changes", "--no-restore"],
      ["test", "--no-build"],
    ],
  );
});

test("a solution or project file is named on every command", () => {
  for (const step of planDotnet({ project: "Pick.slnx" })) {
    assert.equal(step.args[1], "Pick.slnx", step.name);
  }
});

test("a directory runs in place; a file runs in its folder", () => {
  assert.deepEqual(resolveTarget("api", false), { cwd: "api", project: "" });
  assert.deepEqual(resolveTarget("fixtures/dotnet-pick/Pick.slnx", true), {
    cwd: "fixtures/dotnet-pick",
    project: "Pick.slnx",
  });
});

test("an EF project adds the pending-migrations check", () => {
  const steps = planDotnet({ efProject: "src/Data", efStartupProject: "src/Api" });
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[4].args, [
    "ef",
    "migrations",
    "has-pending-model-changes",
    "--no-build",
    "--project",
    "src/Data",
    "--startup-project",
    "src/Api",
  ]);
});

test("the startup project defaults to the EF project", () => {
  const steps = planDotnet({ efProject: "src/App" });
  assert.deepEqual(steps[4].args.slice(-2), ["--startup-project", "src/App"]);
});

test("an input with shell characters stays one argument", () => {
  const hostile = 'src/App"; rm -rf ~; "';
  const steps = planDotnet({ efProject: hostile });
  assert.equal(steps[4].args.filter((arg) => arg === hostile).length, 2);
});

test("a test project is recognised by its test SDK", () => {
  assert.equal(hasTestProject(['<PackageReference Include="Microsoft.NET.Test.Sdk" />']), true);
  assert.equal(hasTestProject(['<Project Sdk="MSTest.Sdk/3.9.0">']), true);
  assert.equal(hasTestProject(['<Project Sdk="Microsoft.NET.Sdk">']), false);
});
