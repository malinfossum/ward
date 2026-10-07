import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  fromRoot,
  hasTestProject,
  planDotnet,
  resolveTarget,
  toolManifestNear,
} from "./dotnet-check.mjs";

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

test("a tool manifest adds a tool restore step before restore", () => {
  const steps = planDotnet({ toolRestore: true });
  assert.deepEqual(steps[0], { name: "tool restore", args: ["tool", "restore"] });
  assert.equal(steps[1].name, "restore");
  assert.equal(
    planDotnet().some((s) => s.name === "tool restore"),
    false,
  );
});

// A throwaway checkout: root/api is the module directory.
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "ward-dotnet-"));
  mkdirSync(join(root, "api", "src"), { recursive: true });
  return root;
}

function manifestAt(dir) {
  mkdirSync(join(dir, ".config"), { recursive: true });
  writeFileSync(join(dir, ".config", "dotnet-tools.json"), "{}");
}

test("a tool manifest is found in the module directory or any parent up to the root", () => {
  const root = checkout();
  try {
    assert.equal(toolManifestNear(join(root, "api"), root), "");
    manifestAt(root);
    assert.equal(
      toolManifestNear(join(root, "api", "src"), root),
      join(root, ".config", "dotnet-tools.json"),
    );
    manifestAt(join(root, "api"));
    assert.equal(
      toolManifestNear(join(root, "api"), root),
      join(root, "api", ".config", "dotnet-tools.json"),
    );
    // varde's shape: the input is a solution file next to the manifest.
    const { cwd } = resolveTarget(join(root, "api", "Varde.slnx"), true);
    assert.equal(toolManifestNear(cwd, root), join(root, "api", ".config", "dotnet-tools.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the manifest lookup never climbs above the checkout root", () => {
  const root = checkout();
  try {
    manifestAt(root);
    assert.equal(toolManifestNear(join(root, "api"), join(root, "api")), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an EF path is resolved from the checkout root, not the module directory", () => {
  assert.equal(fromRoot("/repo", "api/Varde.Data"), resolve("/repo", "api/Varde.Data"));
  assert.equal(fromRoot("/repo", ""), "");
  const absolute = resolve("/elsewhere/App.Data");
  assert.equal(fromRoot("/repo", absolute), absolute);
});

test("a resolved EF path with shell characters is still one argument", () => {
  const hostile = fromRoot("/repo", 'src/App"; rm -rf ~; "');
  const steps = planDotnet({ efProject: hostile });
  assert.equal(steps[4].args.filter((arg) => arg === hostile).length, 2);
});
