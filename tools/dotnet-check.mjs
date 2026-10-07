// Restore, build with warnings as errors, verify formatting, test, and
// optionally check for EF Core model changes without a migration. Every command
// runs as an argument array, never through a shell.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A directory runs in place. A solution or project file runs in its folder and
// is named on every command, for folders where MSBuild would find more than one.
export function resolveTarget(path, isFile) {
  return isFile ? { cwd: dirname(path), project: basename(path) } : { cwd: path, project: "" };
}

export function planDotnet({
  project = "",
  efProject = "",
  efStartupProject = "",
  toolRestore = false,
} = {}) {
  const target = project ? [project] : [];
  const steps = [
    ...(toolRestore ? [{ name: "tool restore", args: ["tool", "restore"] }] : []),
    { name: "restore", args: ["restore", ...target] },
    { name: "build", args: ["build", ...target, "--no-restore", "-warnaserror"] },
    { name: "format", args: ["format", ...target, "--verify-no-changes", "--no-restore"] },
    { name: "test", args: ["test", ...target, "--no-build"] },
  ];
  if (efProject) {
    steps.push({
      name: "pending migrations",
      args: [
        "ef",
        "migrations",
        "has-pending-model-changes",
        "--no-build",
        "--project",
        efProject,
        "--startup-project",
        efStartupProject || efProject,
      ],
    });
  }
  return steps;
}

// `dotnet test` passes silently when no project is a test project.
export function hasTestProject(csprojTexts) {
  return csprojTexts.some((text) =>
    /Microsoft\.NET\.Test\.Sdk|MSTest\.Sdk|<IsTestProject>\s*true/i.test(text),
  );
}

// `dotnet` looks for .config/dotnet-tools.json from the working directory
// upwards. A repo that pins dotnet-ef there must get that version, not the
// one Ward installs globally, so the same walk decides whether to restore.
// It stops at the checkout root: nothing on the runner outside the repo may
// change what a repo's check does.
export function toolManifestNear(cwd, root) {
  let dir = resolve(cwd);
  const top = resolve(root);
  for (;;) {
    const manifest = join(dir, ".config", "dotnet-tools.json");
    if (existsSync(manifest)) return manifest;
    if (dir === top || dirname(dir) === dir) return "";
    dir = dirname(dir);
  }
}

function csprojTexts(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((file) => file.endsWith(".csproj") && !/(^|[\\/])(bin|obj)[\\/]/.test(file))
    .map((file) => readFileSync(join(dir, file), "utf8"));
}

function main() {
  const path = process.argv[2] ?? ".";
  const { cwd, project } = resolveTarget(path, statSync(path).isFile());
  const steps = planDotnet({
    project,
    efProject: process.env.EF_PROJECT ?? "",
    efStartupProject: process.env.EF_STARTUP_PROJECT ?? "",
    toolRestore: toolManifestNear(cwd, process.cwd()) !== "",
  });
  for (const step of steps) {
    if (step.name === "test" && !hasTestProject(csprojTexts(cwd))) {
      console.log("::error::No test project found. Every C# repo needs at least one.");
      process.exitCode = 1;
      return;
    }
    console.log(`::group::${step.name}`);
    const { status } = spawnSync("dotnet", step.args, { cwd, stdio: "inherit" });
    console.log("::endgroup::");
    if (status !== 0) {
      console.log(`::error::${step.name} failed`);
      process.exitCode = 1;
      return;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
