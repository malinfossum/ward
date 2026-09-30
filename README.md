# Ward

Shared CI, security and accessibility checks for all my repos.

Every repo of mine calls one workflow here. It runs the checks that fit the repo's stack and reports a
single required check, `ward / gate`, so a red check always blocks a merge.

## Stack

GitHub Actions reusable workflows, Node 24 scripts with no dependencies, `node:test`, Biome.

## Use it

Copy [`templates/ward.yml`](templates/ward.yml) to `.github/workflows/ward.yml` and set the inputs:

```yaml
jobs:
  ward:
    uses: malinfossum/ward/.github/workflows/ci.yml@v1
    with:
      node: "."
      dotnet: ""
```

| Module | Runs | Input |
|---|---|---|
| identity | Every commit is mine or Dependabot's and carries no AI attribution | always on |
| node | `lint`, `typecheck`, `test`, `build`, `deploy:check`, `test:e2e`, `test:a11y` from `package.json` | `node`, `a11y` |
| dotnet | Restore, build with warnings as errors, `dotnet format`, test (a test project is required), EF pending-model check | `dotnet` (folder or solution file), `dotnet-ef-project` |

The baseline also covers Dependabot with auto-merge for patch and minor updates (GitHub's own actions
only; third-party actions wait for review), secret scanning with push protection, CodeQL, and a
ruleset on `main`. The full standard is in
[the design spec](docs/specs/2026-09-25-ci-standard-design.md).

Two more checks live outside `ci.yml`. [`repo-hygiene.yml`](.github/workflows/repo-hygiene.yml) is a
reusable workflow that checks a repo's public face against its README ([docs](docs/repo-hygiene.md)).
[`repo-audit.yml`](.github/workflows/repo-audit.yml) sweeps every repo I own each Monday: baseline
settings, caller on `@v1`, caller inputs against the repo's stacks, dated NuGet audit suppressions,
runtimes near end of life, and the canary ([docs](docs/repo-audit.md)).

## Develop

```bash
npm install
npm test               # unit tests
npm run test:fixtures  # scripts against good and broken fixtures (needs the .NET 10 SDK)
npm run lint
```

## Layout

| Path | What |
|---|---|
| `.github/workflows/` | `ci.yml` (entry point), `dependabot-automerge.yml`, `repo-hygiene.yml`, the weekly `repo-audit.yml`, Ward's own `ward.yml` |
| `stacks.json` | Which files mean which module, read by the audit and by the `ward` skill |
| `docs/` | The spec, the plans, `repo-hygiene.md` and `repo-audit.md` |
| `tools/` | The scripts each job runs, with their unit tests |
| `templates/` | What a repo copies: caller, Dependabot config, rulesets, `Directory.Build.props` |
| `fixtures/`, `tests/` | Known-good and known-broken projects (the C# ones are xUnit) and the tests that run them |
