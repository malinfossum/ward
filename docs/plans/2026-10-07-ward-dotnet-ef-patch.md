# Ward 1.2.1: local tools and repo-root EF paths in dotnet-check (Plan 5 patch)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the EF pending-migrations check work on a real repo (varde) by restoring a repo's own tool manifest before any `dotnet` command and by resolving `dotnet-ef-project` and `dotnet-ef-startup-project` from the repository root, prove both with a new `dotnet-ef` fixture that passes and rejects, release `v1.2.1`, and then turn varde's EF input back on.

**Architecture:** `tools/dotnet-check.mjs` gains two pure helpers: `toolManifestNear(cwd, root)` walks from the module directory up to the checkout root looking for `.config/dotnet-tools.json` (the same lookup `dotnet` itself does), and `fromRoot(root, path)` makes an EF path absolute from the checkout root so it survives the `cwd` change into the module directory. `planDotnet` prepends a `tool restore` step when a manifest exists. A fourth dotnet fixture, `fixtures/dotnet-ef`, carries a tool manifest pinning `dotnet-ef`, a Sqlite `DbContext` with one committed migration, and an environment switch that adds a column the snapshot lacks, so one fixture gives the fixture suite both the passing and the rejecting case. `ward.yml` gains a `ward-ef` dogfood job so the `ci.yml` wiring (Ward's global `dotnet-ef` install next to a repo's local one) runs on every PR. Nothing in `ci.yml`'s inputs changes, so the patch is a point release.

**Tech Stack:** Node 24 ESM scripts with no dependencies, `node:test`, .NET 10 SDK, EF Core 10.0.12 (Sqlite provider, Design package, `dotnet-ef` tool), xunit 2.9.3, GitHub Actions.

**Spec:** `docs/specs/2026-09-25-ci-standard-design.md`, section "dotnet" (lines 280 to 295) and "Testing Ward itself". The spec says `dotnet-ef-project` adds `dotnet ef migrations has-pending-model-changes`; the rollout plan (`docs/plans/2026-10-02-ward-rollout.md`, line 92) and the caller template both give the input as a path from the repository root (`api/Varde.Data`), while the script ran it from the module directory, so the path doubled to `api/api/Varde.Data`. The ledger entry for the varde round 1 fix (`.superpowers/sdd/2026-10-02-ward-rollout/progress.md`, "WARD FOLLOW-UP") lists the three causes this plan closes.

## Global Constraints

- English, first person, short direct sentences. No em dashes anywhere: not in code comments, docs, commit messages, PR bodies or this plan. Never a `Co-Authored-By` trailer or AI attribution in commits. Commit author `malinfossum.dev@proton.me`.
- Node **24** everywhere; scripts use the Node standard library only. Biome **2.5.15**: `npm run lint` is `biome ci .` and must exit 0. Unit tests: `npm test` (`node --test "tools/*.test.mjs"`), baseline 166 tests (165 pass, 1 skipped). Fixture tests: `npm run test:fixtures` (needs the .NET 10 SDK), baseline 10 tests. Both stay green; new totals are stated as "baseline + N", read off the output.
- Local tools win over global ones: when a manifest in scope lists a command, `dotnet <command>` runs the local tool (learn.microsoft.com, ".NET tools", section "Invoke a global tool", read 2026-10-07). The same page warns that a manifest "modified by an untrusted party" makes the CLI run that party's code, which is why the manifest joins the drift guard in Task 1.
- Scripts start processes as argument arrays, never shell strings. No input, event field or `github.head_ref` inline in a `run:`; values reach a script through `env:`.
- Every `uses:` is pinned to a full 40-character commit SHA with a `# vX.Y.Z` comment. This plan adds no new action.
- Every fixture with a `Directory.Build.props` carries `templates/Directory.Build.props` byte for byte (`tools/templates.test.mjs` enforces it).
- `.NET SDK 10.0.401`, `dotnet-ef 10.0.12`, `Microsoft.EntityFrameworkCore.Sqlite 10.0.12`, `Microsoft.EntityFrameworkCore.Design 10.0.12` (verified against nuget.org 2026-10-07). The test project reuses dotnet-ok's versions: `Microsoft.NET.Test.Sdk 17.14.1`, `xunit 2.9.3`, `xunit.runner.visualstudio 3.1.4`, `coverlet.collector 6.0.4`.
- Branch `fix/dotnet-ef-paths` off `main` (`559e47f`). Commit after every task. Merging, tagging and releasing are Malin's calls (Task 5). The varde PR (Task 6) is opened only after `v1.2.1` is published and only on her go; the agent never merges it.
- The canary (`canary.yml`) is not changed: its `rejects` job already runs the tag's whole fixture suite, which after the release includes the new fixture both ways, and adding the EF input to its `published` job would go red on the first Monday between merge and release.

## Review Focus

Each line names an input the spec implies but no existing test covers, and the task whose tests now pin it.

1. A tool manifest in a parent of the module directory (varde's sits in `api/`, the module directory, but a repo could keep one at the root while `dotnet` points at `api/Varde.slnx`) is found and restored, exactly as `dotnet` would find it when run from the module directory. Pinned in Task 1 (`toolManifestNear` tests: module dir, parent dir, none).
2. The lookup never walks above the checkout root: a manifest in `$RUNNER_TEMP` or the runner's home must not change what a repo's check does. Pinned in Task 1 (`toolManifestNear` stops at `root`).
3. An EF path that is already absolute, or empty, is passed through unchanged, so a caller that gives a full path keeps working and an unset startup project still defaults to the EF project. Pinned in Task 2 (`fromRoot` tests).
4. A model change without a migration fails the check with `::error::pending migrations failed`, and nothing else in the run hides it: the fixture passes with the same inputs when the switch is off. Pinned in Task 3 (fixture pass case and the `dotnet` rejecting case).
5. The `tool restore` step runs before `restore`, never after, so `dotnet ef` finds the repo's pinned version and not Ward's global one; and it does not run at all when there is no manifest, so the three existing dotnet fixtures and every consumer without a manifest see no new step. Pinned in Task 1 (`planDotnet` order test) and Task 3 (the dotnet-ok pass output has no `tool restore` group).

---

### Task 1: Restore a tool manifest before the first dotnet command

**Files:**
- Modify: `tools/dotnet-check.mjs` (imports, `planDotnet`, new `toolManifestNear`, `main`)
- Modify: `tools/drift.mjs:7-12` (`GUARDED` gains the tool manifest)
- Test: `tools/dotnet-check.test.mjs`, `tools/drift.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `toolManifestNear(cwd: string, root: string): string` (the manifest path, or `""`); `planDotnet({ project, efProject, efStartupProject, toolRestore: boolean })` where `toolRestore: true` prepends `{ name: "tool restore", args: ["tool", "restore"] }`. Task 3's fixture test looks for the `::group::tool restore` line that `main` prints.

- [ ] **Step 1: Write the failing tests**

Append to `tools/dotnet-check.test.mjs`. Add the imports at the top of the file:

```js
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
```

and extend the existing import line to `import { fromRoot, hasTestProject, planDotnet, resolveTarget, toolManifestNear } from "./dotnet-check.mjs";` (`fromRoot` arrives in Task 2; until then leave it out of the import and add it there).

```js
test("a tool manifest adds a tool restore step before restore", () => {
  const steps = planDotnet({ toolRestore: true });
  assert.deepEqual(steps[0], { name: "tool restore", args: ["tool", "restore"] });
  assert.equal(steps[1].name, "restore");
  assert.equal(planDotnet().some((s) => s.name === "tool restore"), false);
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
```

A tool manifest now decides which `dotnet-ef` runs, so a PR that edits one gets the same `::warning::` as a PR that edits `global.json`. In `tools/drift.test.mjs`, change the first test's list to:

```js
  const files = [
    ".github/workflows/ward.yml",
    "api/Directory.Build.props",
    "biome.json",
    "web/biome.jsonc",
    "global.json",
    "api/.config/dotnet-tools.json",
    "src/app.js",
    "README.md",
  ];
  assert.deepEqual(guardedChanges(files), files.slice(0, 6));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/dotnet-check.test.mjs tools/drift.test.mjs`
Expected: FAIL. The first new test fails because `planDotnet` ignores `toolRestore` (`steps[0].name` is `restore`); the next two fail with `toolManifestNear is not a function` (or the import itself throws); the drift test fails because the manifest is not in the guarded list. The other existing tests pass.

- [ ] **Step 3: Implement the lookup and the step**

In `tools/dotnet-check.mjs`, change the imports to:

```js
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
```

Replace the `planDotnet` signature and the first lines of its body with:

```js
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
```

(the EF block below it is unchanged). Add, after `hasTestProject`:

```js
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
```

In `main`, pass the flag:

```js
  const steps = planDotnet({
    project,
    efProject: process.env.EF_PROJECT ?? "",
    efStartupProject: process.env.EF_STARTUP_PROJECT ?? "",
    toolRestore: toolManifestNear(cwd, process.cwd()) !== "",
  });
```

In `tools/drift.mjs`, add the manifest to `GUARDED`:

```js
export const GUARDED = [
  /^\.github\/workflows\//,
  /(^|\/)Directory\.Build\.props$/,
  /(^|\/)biome\.jsonc?$/,
  /(^|\/)global\.json$/,
  /(^|\/)\.config\/dotnet-tools\.json$/,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tools/dotnet-check.test.mjs tools/drift.test.mjs && npm run lint`
Expected: 13 tests pass (7 + 3 new in dotnet-check, 3 in drift); Biome exits 0.

- [ ] **Step 5: Commit**

```bash
git add tools/dotnet-check.mjs tools/dotnet-check.test.mjs tools/drift.mjs tools/drift.test.mjs
git commit -m "Restore a repo's tool manifest before the first dotnet command"
```

---

### Task 2: Resolve the EF paths from the checkout root

**Files:**
- Modify: `tools/dotnet-check.mjs` (new `fromRoot`, `main`)
- Test: `tools/dotnet-check.test.mjs`

**Interfaces:**
- Consumes: `planDotnet` from Task 1 (unchanged here: it still receives strings and passes them through as single arguments).
- Produces: `fromRoot(root: string, path: string): string`, which returns `""` for `""`, an absolute path unchanged, and `resolve(root, path)` otherwise. `main` calls it on `EF_PROJECT` and `EF_STARTUP_PROJECT` before `planDotnet`, so `--project` and `--startup-project` are absolute and the `cwd` change into the module directory no longer doubles them.

- [ ] **Step 1: Write the failing tests**

Add `fromRoot` to the import line of `tools/dotnet-check.test.mjs` and append:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/dotnet-check.test.mjs`
Expected: FAIL with `fromRoot is not a function` on both new tests; the 10 others pass.

- [ ] **Step 3: Implement `fromRoot` and use it in `main`**

Add after `toolManifestNear` in `tools/dotnet-check.mjs`:

```js
// The caller gives EF paths from the repository root, like every other input,
// but the commands run in the module directory. Absolute paths survive the
// change of directory; an empty one stays empty so the startup default holds.
export function fromRoot(root, path) {
  return path ? resolve(root, path) : "";
}
```

and change the two EF lines in `main` to:

```js
    efProject: fromRoot(process.cwd(), process.env.EF_PROJECT ?? ""),
    efStartupProject: fromRoot(process.cwd(), process.env.EF_STARTUP_PROJECT ?? ""),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: baseline + 5 unit tests pass (171, 1 skipped), Biome exits 0.

- [ ] **Step 5: Commit**

```bash
git add tools/dotnet-check.mjs tools/dotnet-check.test.mjs
git commit -m "Resolve the EF project paths from the repository root"
```

---

### Task 3: The dotnet-ef fixture, passing and rejecting

**Files:**
- Create: `fixtures/dotnet-ef/.config/dotnet-tools.json`
- Create: `fixtures/dotnet-ef/.editorconfig`
- Create: `fixtures/dotnet-ef/Directory.Build.props` (byte copy of `templates/Directory.Build.props`)
- Create: `fixtures/dotnet-ef/Fixture.slnx`
- Create: `fixtures/dotnet-ef/src/Fixture.Data/Fixture.Data.csproj`
- Create: `fixtures/dotnet-ef/src/Fixture.Data/FixtureContext.cs`
- Create: `fixtures/dotnet-ef/src/Fixture.Data/Migrations/` (two files generated by `dotnet ef migrations add Initial`, committed as generated)
- Create: `fixtures/dotnet-ef/tests/Fixture.Tests/Fixture.Tests.csproj`
- Create: `fixtures/dotnet-ef/tests/Fixture.Tests/UnitTest1.cs`
- Modify: `.gitignore` (one line, `*.db`, so a stray `fixture.db` from a local `dotnet ef database update` is never committed)
- Test: `tests/fixtures.test.mjs`

**Interfaces:**
- Consumes: `tool restore` step and `::group::tool restore` output from Task 1; root-relative `EF_PROJECT` from Task 2.
- Produces: a fixture that `node tools/dotnet-check.mjs fixtures/dotnet-ef` with `EF_PROJECT=fixtures/dotnet-ef/src/Fixture.Data` passes, and with `FIXTURE_PENDING=1` added fails at the `pending migrations` step. Task 4's `ward-ef` job uses the same two inputs.

- [ ] **Step 1: Write the failing fixture tests**

In `tests/fixtures.test.mjs`, after the `dotnet-pick passes` test add:

```js
const EF = { EF_PROJECT: "fixtures/dotnet-ef/src/Fixture.Data" };

test("dotnet-ef passes with a tool manifest and an EF path from the repo root", () => {
  const { status, out } = run("dotnet-check.mjs", ["fixtures/dotnet-ef"], { env: EF });
  assert.equal(status, 0, out);
  assert.match(out, /::group::tool restore/, out);
  assert.match(out, /::group::pending migrations/, out);
});

test("dotnet-ok runs no tool restore when there is no manifest", () => {
  const { out } = run("dotnet-check.mjs", ["fixtures/dotnet-ok"]);
  assert.doesNotMatch(out, /tool restore/, out);
});
```

and in `REJECTS.dotnet` add a third case:

```js
    {
      name: "dotnet-ef: a model change without a migration",
      run: () =>
        run("dotnet-check.mjs", ["fixtures/dotnet-ef"], { env: { ...EF, FIXTURE_PENDING: "1" } }),
      expect: /::error::pending migrations failed/,
    },
```

- [ ] **Step 2: Run the fixture tests to verify the new ones fail**

Run: `node --test tests/fixtures.test.mjs`
Expected: `dotnet-ef passes` and `dotnet rejects dotnet-ef` FAIL (`statSync` throws `ENOENT` for `fixtures/dotnet-ef`); `dotnet-ok runs no tool restore` passes already (that is fine: it pins Review Focus 5 against regressions); everything else passes as before.

- [ ] **Step 3: Create the fixture files**

`fixtures/dotnet-ef/.config/dotnet-tools.json`:

```json
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "dotnet-ef": {
      "version": "10.0.12",
      "commands": [
        "dotnet-ef"
      ],
      "rollForward": false
    }
  }
}
```

`fixtures/dotnet-ef/.editorconfig`:

```ini
root = true

# EF Core writes these, with a BOM and block-scoped namespaces. Marking them
# as generated keeps the format check on the code I write.
[**/Migrations/*.cs]
generated_code = true
```

`fixtures/dotnet-ef/Directory.Build.props`: run `cp templates/Directory.Build.props fixtures/dotnet-ef/Directory.Build.props` (a byte copy; the templates test checks it).

`.gitignore` at the repo root, append one line:

```
*.db
```

`fixtures/dotnet-ef/Fixture.slnx`:

```xml
<Solution>
  <Folder Name="/src/">
    <Project Path="src/Fixture.Data/Fixture.Data.csproj" />
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests/Fixture.Tests/Fixture.Tests.csproj" />
  </Folder>
</Solution>
```

`fixtures/dotnet-ef/src/Fixture.Data/Fixture.Data.csproj` (a class library is enough: the Design package makes it a valid startup project for `dotnet ef`):

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.12" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.12">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
  </ItemGroup>

</Project>
```

`fixtures/dotnet-ef/src/Fixture.Data/FixtureContext.cs`:

```csharp
using Microsoft.EntityFrameworkCore;

namespace Fixture.Data;

public class Note
{
    public int Id { get; set; }

    public string Title { get; set; } = "";
}

public class FixtureContext : DbContext
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite("Data Source=fixture.db");

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // FIXTURE_PENDING=1 adds a column the committed snapshot does not have,
        // so the pending-migrations check has a case it must reject.
        if (Environment.GetEnvironmentVariable("FIXTURE_PENDING") == "1")
        {
            modelBuilder.Entity<Note>().Property<string>("Extra");
        }
    }
}
```

`fixtures/dotnet-ef/tests/Fixture.Tests/Fixture.Tests.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="coverlet.collector" Version="6.0.4" />
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\..\src\Fixture.Data\Fixture.Data.csproj" />
  </ItemGroup>

</Project>
```

`fixtures/dotnet-ef/tests/Fixture.Tests/UnitTest1.cs`:

```csharp
using Fixture.Data;

namespace Fixture.Tests;

public class UnitTest1
{
    [Fact]
    public void TheContextExposesNotes()
    {
        using var context = new FixtureContext();
        Assert.NotNull(context.Notes);
    }
}
```

- [ ] **Step 4: Generate the migration with the fixture's own pinned tool**

```bash
cd fixtures/dotnet-ef
dotnet tool restore
dotnet build Fixture.slnx -warnaserror
dotnet ef migrations add Initial --project src/Fixture.Data
dotnet format Fixture.slnx --verify-no-changes
cd ../..
git status --short fixtures/dotnet-ef
```

Expected: `dotnet tool restore` prints `Tool 'dotnet-ef' (version '10.0.12') was restored`; the build has 0 warnings; `migrations add` writes `src/Fixture.Data/Migrations/<timestamp>_Initial.cs`, `<timestamp>_Initial.Designer.cs` and `FixtureContextModelSnapshot.cs`; the format check exits 0 (the `generated_code` section covers the three files); `git status` lists only the files above and nothing under `bin/` or `obj/`. If `dotnet ef` reports that it cannot find a `runtimeconfig.json` for the startup project, add `<GenerateRuntimeConfigurationFiles>true</GenerateRuntimeConfigurationFiles>` to the `PropertyGroup` of `Fixture.Data.csproj` and rerun the four commands. If the build reports an analyzer warning inside `Migrations/`, do not suppress it in code: check that `.editorconfig` sits at `fixtures/dotnet-ef/.editorconfig` with `root = true` on its first line and rerun.

- [ ] **Step 5: Run the script both ways by hand**

```bash
EF_PROJECT=fixtures/dotnet-ef/src/Fixture.Data node tools/dotnet-check.mjs fixtures/dotnet-ef; echo "exit $?"
FIXTURE_PENDING=1 EF_PROJECT=fixtures/dotnet-ef/src/Fixture.Data node tools/dotnet-check.mjs fixtures/dotnet-ef; echo "exit $?"
```

Expected: the first run prints the groups `tool restore`, `restore`, `build`, `format`, `test`, `pending migrations` and `exit 0`. The second prints the same groups, then `::error::pending migrations failed` and `exit 1`. If the second run exits 0, the switch did not reach the model: check that the `FIXTURE_PENDING` read sits inside `OnModelCreating` and that the snapshot has no `Extra` column.

- [ ] **Step 6: Run the fixture suite and the unit tests**

Run: `npm run test:fixtures && npm test && npm run lint`
Expected: the fixture suite passes with 13 tests (baseline 10 + 3); `every module in ci.yml has a fixture it rejects` still passes; unit tests at 171 (`fixtures carry the template Directory.Build.props unchanged` now checks four copies); Biome exits 0.

- [ ] **Step 7: Commit**

```bash
git add fixtures/dotnet-ef tests/fixtures.test.mjs .gitignore
git commit -m "Add the dotnet-ef fixture: a tool manifest, a migration, and a switch that makes it pending"
```

---

### Task 4: Dogfood the wiring, say so in the docs, bump to 1.2.1

**Files:**
- Modify: `.github/workflows/ward.yml` (new `ward-ef` job after `ward-windows`)
- Modify: `.github/workflows/ci.yml:24-29` (the two EF input descriptions)
- Modify: `templates/ward.yml:24` (the EF comment)
- Modify: `README.md:29` (the dotnet row)
- Modify: `docs/specs/2026-09-25-ci-standard-design.md` (dotnet section after line 290; a deviations paragraph after line 93)
- Modify: `package.json`, `package-lock.json` (version 1.2.1)
- Test: `tools/workflows.test.mjs` (existing tests must stay green; no new test, the job is covered by the mutation rule in `tests/fixtures.test.mjs` and by running on the PR)

**Interfaces:**
- Consumes: the fixture and its two inputs from Task 3.
- Produces: the PR. Task 5 tags the merge commit.

- [ ] **Step 1: Add the dogfood job**

In `.github/workflows/ward.yml`, after the `ward-windows` job and before `fixtures`, insert:

```yaml
  # The EF path comes from the repository root and the fixture pins its own
  # dotnet-ef in a tool manifest, next to the one ci.yml installs globally.
  ward-ef:
    uses: ./.github/workflows/ci.yml
    with:
      dotnet: fixtures/dotnet-ef
      dotnet-ef-project: fixtures/dotnet-ef/src/Fixture.Data
```

- [ ] **Step 2: Say where the EF paths start, in the inputs, the template and the README**

`.github/workflows/ci.yml`, the two EF inputs:

```yaml
      dotnet-ef-project:
        description: >-
          EF Core project to check for model changes without a migration, as a path from the
          repository root. Empty skips it. A .config/dotnet-tools.json in or above the dotnet
          directory is restored first, so the repo's pinned dotnet-ef wins over the global one.
        type: string
        default: ""
      dotnet-ef-startup-project:
        description: Startup project for dotnet ef, as a path from the repository root. Defaults to the EF project.
        type: string
        default: ""
```

`templates/ward.yml`, line 24:

```yaml
      dotnet-ef-project: ""    # EF Core project, path from the repo root, e.g. "api/App.Data"
```

`README.md`, the dotnet row in the modules table:

```markdown
| dotnet | Restore (a repo's tool manifest first), build with warnings as errors, `dotnet format`, test (a test project is required), EF pending-model check with paths from the repo root | `dotnet` (folder or solution file), `dotnet-ef-project` |
```

- [ ] **Step 3: Record it in the spec**

In `docs/specs/2026-09-25-ci-standard-design.md`, after the sentence ending `else at the repo root, else .NET 10.` (line 290), add:

```markdown
`dotnet-ef-project` and `dotnet-ef-startup-project` are paths from the repository root, like every
other input, and the script makes them absolute before it changes into the `dotnet` directory. When a
tool manifest (`.config/dotnet-tools.json`) sits in that directory or above it, `dotnet tool restore`
runs before anything else, so the repo's pinned `dotnet-ef` is the one that runs; the global install
in `ci.yml` is the fallback for repos without a manifest.
```

In the identity section (line 153), the list of files a PR can change to turn its own checks off gains the manifest. Replace `Directory.Build.props`, `biome.json`, `global.json` or the `scripts` in a `package.json` with:

```markdown
`Directory.Build.props`, `biome.json`, `global.json`, `.config/dotnet-tools.json` or the `scripts` in a
`package.json`
```

After the Plan 5 deviations paragraph (ends `until Plan 4 ships \`test:a11y\`.`, line 93), add:

```markdown
**Deviations recorded 2026-10-07 (Plan 5 patch, v1.2.1):** the rollout's first EF consumer (varde)
showed that the EF paths were taken from the `dotnet` directory while the caller template and the
rollout table gave them from the repository root, and that a repo's own tool manifest was never
restored. Both are fixed in `dotnet-check.mjs` and pinned by the `dotnet-ef` fixture, which passes
with its committed migration and is rejected when `FIXTURE_PENDING=1` adds a column the snapshot
lacks. A tool manifest now decides which `dotnet-ef` runs, so the identity job's drift warning
covers `.config/dotnet-tools.json` too. The canary is unchanged: its `rejects` job runs the tag's
whole fixture suite, and the EF input in its `published` job would have gone red on the first
Monday between merge and release.
```

- [ ] **Step 4: Bump the version**

```bash
npm version 1.2.1 --no-git-tag-version
git diff --stat
```

Expected: `package.json` and `package-lock.json` each change their `version` lines only.

- [ ] **Step 5: Run every check**

Run: `npm test && npm run lint && npm run test:fixtures`
Expected: unit tests 171 (1 skipped), Biome exits 0, fixture suite green at 13. In particular `every action is pinned`, `every job that runs steps has a 10 or 30 minute timeout` (the new job runs no steps of its own) and `no template carries an em dash` pass.

- [ ] **Step 6: Commit and open the PR**

```bash
git add .github/workflows/ward.yml .github/workflows/ci.yml templates/ward.yml README.md docs/specs/2026-09-25-ci-standard-design.md package.json package-lock.json
git commit -m "Dogfood the EF fixture, document the repo-root paths and bump Ward to 1.2.1"
git push -u origin fix/dotnet-ef-paths
gh pr create --title "Restore local tools and resolve EF paths from the repo root (1.2.1)" --body-file - <<'EOF'
The EF pending-migrations check never ran on a real repo before the rollout. Varde showed two defects in `dotnet-check.mjs`: it did not restore a repo's tool manifest, so the pinned `dotnet-ef` was never installed, and it passed `dotnet-ef-project` relative to the `dotnet` directory, so `api/Varde.Data` became `api/api/Varde.Data`.

- `dotnet tool restore` runs first when a `.config/dotnet-tools.json` sits in or above the `dotnet` directory. The lookup mirrors `dotnet`'s own and stops at the checkout root.
- `dotnet-ef-project` and `dotnet-ef-startup-project` are made absolute from the repository root, as the caller template says.
- New `fixtures/dotnet-ef`: a tool manifest pinning `dotnet-ef 10.0.12`, a Sqlite context with one committed migration, and `FIXTURE_PENDING=1` adds a column the snapshot lacks, so the fixture suite has a rejecting case for the EF step.
- `ward.yml` gains a `ward-ef` job that runs the fixture through `ci.yml`, so the global install and a local manifest are proven side by side on every PR.
- Inputs, template, README and spec say where the EF paths start. Version 1.2.1; no input changes.

After the release, varde adds a design-time context factory and turns its EF input back on.
EOF
```

Expected: the PR shows `ward / gate`, `ward-windows / gate`, `ward-ef / gate`, `fixtures`, `hygiene` and CodeQL green. The `ward-ef` dotnet job log shows `::group::tool restore` before `::group::restore`, and `::group::pending migrations` last.

---

### Task 5: Release v1.2.1 (Malin's gate)

**Files:** none in the tree; tags and the release.

**Interfaces:**
- Consumes: the merged PR from Task 4.
- Produces: tag `v1.2.1`, `v1` moved to the same commit, release published; Task 6 waits for the canary's release run.

- [ ] **Step 1: Merge the PR** (Malin, in the GitHub UI, merge commit as before).

- [ ] **Step 2: Tag, move v1, release** (on her go; the pin is the commit SHA, never the tag object)

```bash
git switch main && git pull --ff-only
git tag -a v1.2.1 -m "Ward 1.2.1: restore local tools, EF paths from the repo root, dotnet-ef fixture" \
  && git tag -fa v1 -m "Ward v1: currently v1.2.1" v1.2.1^{commit} \
  && git push origin v1.2.1 \
  && git push --force origin v1 \
  && git rev-parse v1.2.1^{commit} \
  && gh release create v1.2.1 --verify-tag --title "v1.2.1" --latest --notes "dotnet-check restores a repo's tool manifest before the first command, so a pinned dotnet-ef wins over the global install, and resolves dotnet-ef-project and dotnet-ef-startup-project from the repository root as the caller template says. New dotnet-ef fixture with a passing and a rejecting case. No change to ci.yml's inputs."
gh api repos/malinfossum/ward/git/ref/tags/v1 --jq '.object.sha' | xargs -I{} gh api repos/malinfossum/ward/git/tags/{} --jq '.object.sha'
```

Expected: the last command prints the same commit SHA as `git rev-parse v1.2.1^{commit}`.

- [ ] **Step 3: Watch the release-triggered canary**

```bash
sleep 300 && gh run list --repo malinfossum/ward --workflow canary.yml --limit 1 --json conclusion,event,databaseId
```

Expected: `event: release`, `conclusion: success`. The `rejects` job ran the tag's fixture suite, which now includes `dotnet-ef passes` and `dotnet rejects dotnet-ef`. Dependabot proposes the `dependabot-automerge.yml` bump to the `v1.2.1` commit on Ward and on each of the 16 consumers within a week; auto-merge refuses Ward's own bumps by design (Plan 5, finding 1), so those PRs are Malin's to merge by hand or close. `dependabot-automerge.yml` is unchanged in this release, so a consumer that stays pinned at the `v1.2.0` commit runs the same auto-merge code; only Ward's own `ward.yml` pin should move, as with `#11`.

---

### Task 6: Varde turns the EF check back on (after the release, on Malin's go)

**Files (in `malinfossum/varde`, a shallow clone in a temp dir, branch `feat/ward-ef`):**
- Create: `api/Varde.Api/DesignTimeDbContextFactory.cs`
- Modify: `.github/workflows/ward.yml:23-24` (the EF input and its dated comment)

**Interfaces:**
- Consumes: `ci.yml@v1` at `v1.2.1`.
- Produces: varde's `ward / dotnet` job runs `tool restore` (its manifest pins `dotnet-ef 10.0.10`, matching its EF packages) and the pending-migrations step, green.

- [ ] **Step 1: Clone and branch**

```bash
tmp="$(mktemp -d)" && git clone --quiet --depth 1 https://github.com/malinfossum/varde "$tmp/varde" && cd "$tmp/varde" && git switch -c feat/ward-ef
```

- [ ] **Step 2: Add the design-time factory**

`api/Varde.Api/DesignTimeDbContextFactory.cs` (the startup project is where `dotnet ef` looks first; `Microsoft.Extensions.Configuration.UserSecrets` ships in the ASP.NET Core shared framework, so no package is added):

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Varde.Data;

namespace Varde.Api;

// dotnet ef needs a context without starting the web host, which throws when
// ConnectionStrings:VardeDb is missing. User secrets and the environment come
// first, as at runtime; the placeholder only serves commands that never open
// a connection, such as has-pending-model-changes in CI.
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<VardeDbContext>
{
    public VardeDbContext CreateDbContext(string[] args)
    {
        var configuration = new ConfigurationBuilder()
            .AddUserSecrets<DesignTimeDbContextFactory>(optional: true)
            .AddEnvironmentVariables()
            .Build();
        var connectionString = configuration.GetConnectionString("VardeDb")
            ?? "Host=localhost;Database=varde_design";
        var options = new DbContextOptionsBuilder<VardeDbContext>()
            .UseNpgsql(connectionString)
            .Options;
        return new VardeDbContext(options);
    }
}
```

- [ ] **Step 3: Prove it locally, both ways**

```bash
cd api
dotnet tool restore
dotnet build Varde.slnx -warnaserror
dotnet format Varde.slnx --verify-no-changes
dotnet ef migrations has-pending-model-changes --no-build --project Varde.Data --startup-project Varde.Api; echo "exit $?"
cd ..
EF_PROJECT=api/Varde.Data EF_STARTUP_PROJECT=api/Varde.Api node "$WARD/tools/dotnet-check.mjs" api/Varde.slnx; echo "exit $?"
```

where `WARD` is the Ward checkout on `main` after the release. Expected: build with 0 warnings, format clean, `has-pending-model-changes` prints `No changes have been made to the model since the last migration.` and `exit 0`; the Ward script prints `tool restore` first, every group, and `exit 0`. If the build warns `CA1812` or similar on the factory, the class is `public sealed` and used by reflection, so the warning does not apply; re-read the message before changing anything.

- [ ] **Step 4: Turn the input back on**

In `.github/workflows/ward.yml`, replace the two lines

```yaml
      # EF check off until Ward restores local tools and resolves paths from the repo root, and the API has a design-time connection string (2026-10-07).
      dotnet-ef-project: ""                  # EF Core project path, e.g. "src/App.Data"
```

with

```yaml
      dotnet-ef-project: "api/Varde.Data"    # EF Core project, path from the repo root
      dotnet-ef-startup-project: "api/Varde.Api"
```

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add api/Varde.Api/DesignTimeDbContextFactory.cs .github/workflows/ward.yml
git commit -m "Turn Ward's EF pending-migrations check on with a design-time context factory"
git push -u origin feat/ward-ef
gh pr create --title "Turn Ward's EF pending-migrations check on" --body-file - <<'EOF'
Ward 1.2.1 restores the tool manifest in `api/` and resolves the EF paths from the repository root, so the check that was turned off on 2026-10-07 can run again.

- `DesignTimeDbContextFactory` in `Varde.Api` gives `dotnet ef` a context without starting the web host. User secrets and the environment come first, as at runtime; a placeholder connection string serves `has-pending-model-changes` in CI, which never opens a connection.
- `dotnet-ef-project: api/Varde.Data` and `dotnet-ef-startup-project: api/Varde.Api` in the Ward caller.

Local run: build clean, format clean, no pending model changes, Ward's `dotnet-check.mjs` green end to end.
EOF
```

Expected: `ward / dotnet` green with the `tool restore` and `pending migrations` groups in its log; `ward / gate` and varde's own `api-tests` green. Malin merges. The ledger records the run id.

---

## Self-review (2026-10-07)

- **Spec coverage.** "dotnet-ef-project adds has-pending-model-changes": Tasks 1 to 3 make it run where the rollout put it; Task 4 writes the root-relative rule into the spec. "Every module has a fixture it rejects": Task 3 adds the EF rejecting case to the existing dotnet list. "Dogfood": Task 4's `ward-ef` job. "Canary on the published tag": unchanged by decision, stated in Global Constraints and the deviations paragraph. Versions table in the spec already lists `dotnet-ef 10.0.12`.
- **Placeholders.** None: every file has its full content, every command its expected output. The two "if it fails" lines in Task 3 Step 4 and Task 6 Step 3 give the exact fix.
- **Type consistency.** `toolManifestNear(cwd, root)` and `fromRoot(root, path)` are named the same in Tasks 1, 2 and the Architecture paragraph; `planDotnet`'s `toolRestore` flag is a boolean in Task 1 and in `main`; the fixture inputs `fixtures/dotnet-ef` and `fixtures/dotnet-ef/src/Fixture.Data` match between Task 3's tests, Task 3's manual run and Task 4's job.
- **Review Focus.** All five lines name their task; line 5's "no new step for repos without a manifest" is pinned by the `dotnet-ok runs no tool restore` fixture test in Task 3.

## Stress test (2026-10-07)

Five passes over this plan: security, privacy, accessibility, legal, loopholes. Every finding is folded in above.

- 🟡 **Security: a tool manifest is a file that decides what Ward runs.** A PR could point `dotnet-ef` at another package, and nothing warned. Folded into Task 1: `.config/dotnet-tools.json` joins `GUARDED` in `drift.mjs` with its test, the spec's identity section lists it. Proof: the drift unit test; the identity job's `::warning::` on any PR that edits a manifest.
- 🟡 **Loophole: varde's exact shape (a solution file beside the manifest) was not pinned.** The unit tests used a directory input only. Folded into Task 1: one assertion through `resolveTarget("api/Varde.slnx", true).cwd`. Proof: the unit test.
- 🟡 **Loophole: a stray `fixture.db`.** `OnConfiguring` names a file; a local `dotnet ef database update` would create it next to the fixture. Folded into Task 3: `*.db` in the root `.gitignore`. Proof: `git status` after Task 3 Step 4 lists no `.db`.
- 🟡 **Loophole: the release makes 17 Dependabot PRs that auto-merge refuses.** Expected by design, but the plan did not say so, and the consumers do not need the bump. Folded into Task 5 Step 3. Proof: manual, Malin, the week after the release.
- ✅ **Privacy.** No new data; `dotnet tool restore` talks to nuget.org as `dotnet restore` already does, under the same telemetry opt-out, and the design-time factory's placeholder holds no credentials.
- ✅ **Accessibility.** No user interface in this plan.
- ✅ **Legal.** The three new packages are Microsoft's EF Core (MIT, `dotnet/efcore` LICENSE.txt) and their Sqlite binding (SQLitePCLRaw, Apache-2.0), both compatible with Ward's MIT; they ship only inside a fixture.

**Considered and rejected**
- **A fixture whose manifest is broken.** The `tool restore` step fails through the same loop as the four existing steps (`::error::tool restore failed`, exit 1); a fifth dotnet fixture would prove the loop again, not the step.
- **Proving that the local tool beats the global one with mismatched versions.** It is documented CLI behaviour (Global Constraints cite the page); a wrong guess would only produce EF's version warning, never a wrong verdict. Not worth a second fixture.
- **The EF input in the canary's `published` job.** Red on the first Monday between merge and release (Global Constraints); the `rejects` job covers the fixture at the tag.
- **Dependabot for the fixture's NuGet packages.** Ward's `dependabot.yml` has no `nuget` entry on purpose; fixtures pin by hand, as the three existing ones do.

> Stress-tested 2026-10-07 (skill a06dd56): 4 applied, 0 adapted, 0 decided by me.
