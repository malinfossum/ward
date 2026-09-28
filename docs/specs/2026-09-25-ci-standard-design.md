# Ward — CI and security standard

**Status:** design, stress-tested 2026-09-28, awaiting merge · **Date:** 2026-09-25

## Why

Every repo of mine should catch bugs, security risks and accessibility regressions before they reach
`main`, and fix the safe classes of problem on its own. Today that coverage is uneven: some repos have
CI, most C# repos have none, Dependabot is configured in three, and nothing enforces that a red check
blocks a merge. Ward is one public repo that holds the whole standard, so every repo — scaffolded from
workbench or not — calls the same checks and gets improvements by moving one tag.

Nothing goes in unless it catches a real class of defect. Each check below names what it catches.

## Principles

1. **Find everything automatically, fix only the safe classes automatically.** Dependency bumps,
   formatting and CodeQL fix suggestions are safe. A bot that edits code until CI is green is not — it
   can pass by weakening a test. Everything else arrives as a PR or suggestion I accept.
2. **Advisory checks are worthless.** A ruleset on `main` makes the checks required.
3. **One entry point per repo.** A repo has one caller workflow and one required check, whatever mix of
   stacks it holds.
4. **The stack list is data, not memory.** Detection rules live in `stacks.json`; an uncovered stack is
   reported, never guessed at.
5. **No bot commits in my name, no AI commits at all.** Only Dependabot may author commits, and only
   through its own PRs.

## Architecture

```
malinfossum/ward (public)
├── .github/workflows/
│   ├── ci.yml              reusable entry point: one job per module, final `gate` job
│   ├── dependabot-automerge.yml   reusable: patch/minor auto-merge
│   ├── repo-hygiene.yml    reusable (moved from workbench)
│   ├── repo-audit.yml      weekly sweep over every repo (moved from workbench)
│   └── canary.yml          weekly and post-tag run of the published @v1, as a consumer (Plan 5)
├── templates/              dependabot.yml per ecosystem mix, ward.yml caller, ruleset.json
├── packages/a11y/          @malinfossum/ward-a11y — Playwright helpers + live-region audit
├── tools/                  identity.mjs, drift.mjs, node-contract.mjs, dotnet-check.mjs, automerge.mjs,
│                           repo-hygiene.mjs, repo-audit additions, apply.mjs
├── stacks.json             detection rules → module + required scripts
└── docs/
```

**Why public:** Wend and Rookdex live in other organisations. A public caller can only reach a public
reusable workflow, and cross-owner calls cannot use `secrets: inherit` — no module takes secrets, so
that limit does not bite.

**Versioning:** Ward follows SemVer from 0.1.0; the first release callers pin is `v1.0.0`, with a moving
`v1` major tag. Callers use `@v1`, so a minor release reaches every repo without a PR per repo; a breaking
change ships as `v2` and Dependabot proposes the bump. Third-party actions *inside* Ward are pinned to a
full commit SHA with a version comment, which Dependabot keeps current.

**Deviations recorded 2026-09-25 (Plan 1):** modules are jobs inside `ci.yml` rather than nested
reusable workflows, because GitHub does not document how `./` resolves in nested cross-repo calls; the
EF input is a project path; `stacks.json` arrives with the skill in Plan 3. `node-contract.mjs` runs
`npm` through a shell (`spawnSync(..., { shell: true })`), unlike the other tools' argument-array calls,
because `npm` needs a shell on Windows. The `fixtures` job in `ward.yml`, which runs the module tests
against the fixture repos, carries a 30-minute timeout even though it is neither a `node` nor a `dotnet`
job.

## The caller

The only CI file a repo carries:

```yaml
# .github/workflows/ward.yml
name: Ward
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 5 * * 1" # weekly re-check of main, see Auto-merge
  workflow_dispatch:
permissions:
  contents: read
jobs:
  ward:
    uses: malinfossum/ward/.github/workflows/ci.yml@v1
    with:
      node: web          # working directory, empty = module off
      dotnet: api        # directory, or a .sln/.slnx/.csproj file
      dotnet-ef-project: src/App.Data
      a11y: strict       # off | warn | strict
  automerge:
    if: github.event_name == 'pull_request' && github.event.pull_request.user.login == 'dependabot[bot]'
    permissions:
      contents: write
      pull-requests: write
    uses: malinfossum/ward/.github/workflows/dependabot-automerge.yml@<full SHA> # v1.x.y
```

`ci.yml` calls each enabled module as a job with `if:` on its input, then a `gate` job that `needs` all
of them, runs with `if: always()` and fails when any needed job ended in `failure` or `cancelled`
(skipped is fine). The ruleset requires exactly one check: **`ward / gate`** (format
`<caller job> / <reusable job>`). Adding a stack to a repo never touches the ruleset.

Every job has a timeout: 30 minutes for `node` and `dotnet`, 10 for the rest, so a hung step fails
instead of burning runner time. Every module runs with .NET, Astro and Wrangler telemetry turned off
(`DOTNET_CLI_TELEMETRY_OPTOUT`, `ASTRO_TELEMETRY_DISABLED`, `WRANGLER_SEND_METRICS=false`).

## Baseline — every public repo I own

| Control | Catches | Where |
|---|---|---|
| Dependabot security updates | Known-vulnerable dependencies | Repo setting |
| Dependabot version updates, weekly, grouped | Drift that turns into a painful major jump; stale pinned actions | `dependabot.yml` from `templates/` |
| Secret scanning + push protection | A credential pushed by mistake — blocked before it lands | Repo setting |
| CodeQL default setup + Copilot Autofix | Injection, XSS, unsafe deserialisation, workflow script injection (the `actions` language); Autofix proposes the patch on the PR | Repo setting |
| Ruleset on `main` | Merging red, force-pushing, deleting `main` | `templates/ruleset.json` via API |
| `identity` job | Commits authored as anyone but me or Dependabot; `Co-Authored-By` / `Claude-Session` / "Generated with" trailers; a PR that changes the files deciding what Ward checks (warning) | `identity` job in `ci.yml`, always on |
| `repo-hygiene` job | README drift against the repo | Existing checker, `warn` by default |

**Identity rules:** the attribution check matches only lines that start with the trailer or the
"Generated with" footer, so prose that mentions them passes, and it skips the title and body of a
Dependabot PR, which quote upstream release notes I do not control. A `Co-authored-by` line for my own
address or Dependabot's passes, because GitHub adds one when a squash merge combines authors; an AI
co-author always fails. Errors show a redacted address (first character and domain), because CI logs
on a public repo are public. The job also warns, without failing, when a PR changes a workflow,
`Directory.Build.props`, `biome.json`, `global.json` or the `scripts` in a `package.json`, since a PR
can turn its own checks off; I read those changes before merging.

The identity check is a guard against misconfiguration, not authentication: author and committer
fields are whatever the pusher's git config says, so it catches my own mistakes and AI tools, not
someone with push access who sets a false address. A repo that wants more can additionally require
GitHub's verified signature on Dependabot's commits.

A joint repo lists the co-owner in `allowed-emails` only with their consent, and only by their GitHub
noreply address, because the caller file is public.

**Ruleset contents:** target the default branch; require a pull request (0 approvals — I am the only
reviewer); require status check `ward / gate` without the strict up-to-date rule; require code
scanning results (CodeQL, errors only); block force pushes and deletion; no bypass actors. Strict mode
is off because Dependabot does not rebase a PR that is only behind `main`, so every auto-merge would
stall. The backstop is the caller's weekly scheduled run, which checks `main` as it stands after the
week's merges.

**Dependabot template:** one group per ecosystem for `minor` + `patch` version updates, majors ungrouped
so each gets its own PR. For GitHub Actions the group holds only actions owned by `actions/`, `github/`
and `dependabot/`, so every third-party action, and Ward's own SHA-pinned reference, arrives as a PR
of its own. The `dotnet-runtime` group covers `minor` + `patch` only, so a runtime major is never
bundled with anything. The default 3-day cooldown stays — a freshly published malicious version has
three days to get caught before it reaches me. Security updates skip the cooldown.

## Auto-merge

`dependabot-automerge.yml`, called from the `automerge` job in the same caller, runs on `pull_request`
only when the author is `dependabot[bot]`. It uses `dependabot/fetch-metadata` and runs
`gh pr merge --auto --squash` when **all** of these hold:

- every commit on the PR is authored by Dependabot. When I push a commit of my own onto a Dependabot PR,
  the next run refuses, and every refusal also turns off auto-merge that an earlier run enabled, so the
  PR becomes mine to merge;
- `update-type` is `version-update:semver-patch` or `version-update:semver-minor`;
- no dependency in the PR matches the runtime-bound list: `Microsoft.AspNetCore.*`,
  `Microsoft.EntityFrameworkCore.*`, `Microsoft.Extensions.*`, `Microsoft.NET.*`, `System.*`; and the
  PR's package ecosystem is not `dotnet-sdk`, so an SDK bump in `global.json` is refused by its
  ecosystem, whatever the dependency is called; a .NET container image (`mcr.microsoft.com/dotnet/*`,
  Docker ecosystem, with or without the registry prefix) is refused too, because the image is the
  runtime, and CI never runs inside it;
- for GitHub Actions, every action is owned by `actions/`, `github/` or `dependabot/`. A third-party
  action waits for my review whatever the update type, because it runs inside workflows that can hold
  deploy secrets. This amends the "patch + minor" rule I locked on 2026-09-25 (decided 2026-09-28);
- the PR does not bump Ward itself (`malinfossum/ward`). The auto-merge job is SHA-pinned so that I read
  every change to the code holding write access; merging that bump automatically would undo the pin;
- the PR's base branch requires the check. **Auto-merge on a repo without required checks merges
  instantly**, so `apply.mjs` only enables "Allow auto-merge" after the ruleset is in place, and the
  workflow reads the rules of the PR's base branch through the API and refuses if `ward / gate` is
  missing.

The merge itself waits for `ward / gate` and CodeQL. Majors, runtime-bound packages, third-party actions
and Ward's own bumps stay as open PRs for me. Squash is the method because a Dependabot PR is one commit.

**Merges by `GITHUB_TOKEN` start no workflows.** An auto-merge made with the workflow's token triggers no
`push` run on `main`, so neither Ward's push check nor a deploy workflow runs for it. The caller
therefore also runs weekly on `schedule`, and on demand through `workflow_dispatch`, which re-checks
`main` after the week's merges. Repos that deploy on push to `main` ship an auto-merged bump with the
next merge I make. A personal access token or GitHub App token would start those runs, but it would put
a long-lived write credential in every repo, so I rejected it.

Joint repos (org-owned with a co-owner) get auto-merge only after the co-owner agrees; until then they
get everything else.

## Security of Ward itself

Every repo runs Ward's code, so Ward is the most trusted repo I own and gets the strictest protection.

- **Threat:** someone with push access to Ward changes what every repo runs. The CI modules get a
  read-only token and no secrets, so a bad module can at worst report a false green. The auto-merge job
  holds `contents: write` and `pull-requests: write`, so it is the one that matters.
- **Pinning:** callers use `@v1` for the read-only CI entry point, so improvements propagate. The
  `automerge` job is pinned to a full commit SHA with a version comment; Dependabot proposes each bump as
  a PR I read, so the write-holding code never changes under a repo silently, and auto-merge never
  merges that bump.
- **Ward's own auto-merge job** calls `dependabot-automerge.yml` at a released SHA, never by `./` path:
  a `./` reference runs the PR head's version of the workflow, with write access, before I have
  reviewed it. Ward gets the job with `v1.0.0` (Plan 5), and a test bans `./` references to
  `dependabot-automerge.yml`.
- **Ward's own rulesets:** the branch ruleset from the baseline, plus a tag ruleset on `v*` that blocks
  creation, updates and deletion, with repository admin as the only bypass (moving `v1` is part of every
  release). It stops accidents and any future collaborator; it does not stop someone holding my own
  admin token — that is what 2FA and a minimal-scope `gh` token are for.
- **Triggers:** Ward uses `pull_request`, never `pull_request_target`, so fork PRs run with a read-only
  token and no secrets. Scripts run commands as argument arrays, never shell strings, and no workflow
  puts an input, an event field or `github.head_ref` inline in a `run:` script.
- **Supply chain:** the 3-day Dependabot cooldown keeps a freshly published malicious patch out long
  enough for it to be caught upstream. Auto-merged changes still pass tests and CodeQL, and third-party
  actions never auto-merge. Repos that deploy on merge to `main` (Ignite, Kenaz, Rookdex) are the ones
  where this matters most, and they ship an auto-merged bump only with my next merge.
- **Account:** 2FA stays on; Ward holds no secrets except the audit token, which is read-only. My
  account's commit email for web commits (Settings → Emails) is `malinfossum.dev@proton.me`, so squash
  merges and web edits pass `identity` and never publish my private address, and "Block command line
  pushes that expose my email" is on. By the time `identity` sees a commit, it is already public, so the
  guard against a private address sits before the push: a pre-push hook in loadout refuses commits
  authored with any address but my dev address (Plan 3).

## Stack modules

`stacks.json` maps detection globs to a module and the npm scripts or settings the module expects. The
versions below were verified against their registries on 2026-09-25.

### node — vanilla JS, React + TS, Astro, Cloudflare Workers

The module runs a script contract, so framework-specific commands live in the repo's `package.json`,
where I can read and run them locally:

| Step | Command | Required |
|---|---|---|
| Install | `npm ci` | always |
| Lint + format | `npm run lint` (Biome `biome ci`) | always |
| Types | `npm run typecheck` | when `tsconfig.json` or `astro.config.*` exists |
| Unit | `npm test` | always |
| Build | `npm run build` | when present |
| Worker dry run | `npm run deploy:check` (`wrangler deploy --dry-run`) | when `wrangler.*` exists |
| E2E | `npm run test:e2e` (Playwright, functional) | when present; always fails the gate |
| Accessibility | `npm run test:a11y` (Playwright + `@malinfossum/ward-a11y`) | when `a11y` ≠ `off`; in `warn` its failures are annotations |

Functional e2e and accessibility are separate scripts so that `warn` softens only the accessibility
checks: a broken user flow fails the gate in every mode.

Per stack, `typecheck` is `tsc --noEmit` (React/Workers) or `astro check` (Astro). Workers unit tests
use `@cloudflare/vitest-pool-workers`. Node version input defaults to **24** (Active LTS today).

### dotnet — console, layered, WPF, ASP.NET Core + EF

`dotnet restore` → `dotnet build -warnaserror` → `dotnet format --verify-no-changes` → `dotnet test`.
Repos carry a `Directory.Build.props` from `templates/` with `AnalysisLevel=latest-recommended`,
`TreatWarningsAsErrors=true`, `NuGetAudit=true`, `NuGetAuditMode=all`, so a vulnerable package
(NU1901–NU1904) fails the build. When I have to live with a vulnerable package for a while, I suppress
that one advisory with `<NuGetAuditSuppress Include="<advisory URL>" />` and a dated comment saying why,
never by turning `NuGetAudit` off; the weekly audit lists every suppression. `dotnet-ef-project` adds
`dotnet ef migrations has-pending-model-changes` (exit 1 when I changed the model and forgot the
migration). `os` input: `ubuntu-latest` by default, `windows-latest` for WPF. SDK from `global.json` in
the module's directory, else at the repo root, else .NET 10.

The `dotnet` input is a directory, or a solution or project file when the directory holds more than one
(`dotnet format` refuses a folder with a solution and a project side by side). A C# repo without a test
project fails: `dotnet test` on a solution with no test project passes silently, which would make an
untested repo green.

### python · powershell · docker

- **python** — `ruff check`, `ruff format --check`, `pytest`.
- **powershell** — PSScriptAnalyzer (errors and warnings fail), Pester.
- **docker** — hadolint on every `Dockerfile`; Dependabot `docker` ecosystem bumps base images.

### Out of scope

Private repos (brain, claude-harness, respawn, loadout) keep Actions disabled and the local secret gate,
as already decided. Other private repos and forks are not covered. Deploy workflows stay per repo.

## Accessibility module

Runs inside the `node` module's `test:a11y` step, through `@malinfossum/ward-a11y`. Automated checks catch
a minority of accessibility defects; a manual NVDA pass with workbench's live-region sandbox stays part
of every release checklist.

**Page audit** (`auditPage(page)`), run for every route in both themes and both languages:

- axe with WCAG 2.2 AA tags;
- reflow: no horizontal scroll at 320 CSS px;
- target size: standalone controls ≥ 44 × 44 px, my design system's size. Links inside running text are
  exempt, as WCAG 2.5.8 allows. The report names a target under the 24 × 24 px AA minimum as a WCAG
  failure and one between 24 and 44 px as a house-rule failure;
- visible focus: every focusable element's computed style differs in some property between focused
  and unfocused, not only `outline` or `box-shadow`; and the focused element is not hidden behind
  sticky or fixed content (WCAG 2.4.11), checked with `document.elementFromPoint` at the element's
  centre;
- failure messages: each form or async action under test surfaces its error in a live region, in the
  current language;
- language: after the language switch, `<html lang>` matches the language switched to (Plan 4 scope);
- forced colors: the visible-focus check runs a second time with `forced-colors: active` emulated
  (Plan 4 scope);
- reduced motion: with `prefers-reduced-motion: reduce` emulated, `document.getAnimations()` returns no
  running animation (Plan 4 scope).

**Live regions** — the audit plus two helpers:

| Practice | Check | Result |
|---|---|---|
| Valid `aria-live`, `aria-atomic`, `aria-busy`, `aria-relevant`, live roles | axe | fail |
| Insert regions into the DOM early | Regions recorded at load; a MutationObserver flags any added afterwards | fail |
| Limit the number of regions | More than 2 per view (one `status`, one `alert`); `<output>` has an implicit `status` role, so it counts as the view's `status` region (Plan 4 scope) | fail |
| Avoid rich and interactive content | Focusable or interactive descendant inside a region | fail |
| Clear between updates; insert updates at once | `expectAnnouncement(page, action, text)` records spoken output with `@guidepup/virtual-screen-reader`: the same action twice announces twice, one action announces once | fail |
| Keep content clear and succinct | Announcement over 150 characters | warn |
| Prefer robust solutions | Bare `aria-live` where `role="status"`, `role="alert"` or `<output>` fits | warn |

**Modes:** `strict` fails the gate, `warn` reports as annotations. The mode applies to `test:a11y`
only; functional `test:e2e` fails the gate in every mode. New repos start `strict`; existing repos start
`warn` and move to `strict` one by one as they come clean.

**WPF:** spike first — Axe.Windows (last release 2024-11) scanning a WPF window on `windows-latest`. If
it works, it joins the `dotnet` module; if not, the fallback is UI Automation tests asserting
`AutomationProperties.Name` and `LiveSetting` on the controls that matter.

## Capturing new stacks

1. **The skill.** A `ward` skill in loadout fetches `stacks.json` from the tagged release, detects the
   repo's stacks, writes the caller files, `dependabot.yml` and any `Directory.Build.props`, adds missing
   npm scripts, then applies the repo settings through `tools/apply.mjs` — each settings change shown and
   confirmed first. It fires on "apply ward", from `project-init` after scaffolding, and when a new
   framework lands in a repo.
2. **Unknown stack.** When a detection finds files no rule covers, the skill stops and drafts a new
   module as a PR to Ward — it never applies a guessed config. Capacitor Android is the first expected
   case.
3. **The audit.** The weekly `repo-audit` adds three checks per repo: baseline settings on (Dependabot,
   secret scanning, CodeQL, ruleset), caller present on `@v1`, and no uncovered stack. It compares the
   caller's inputs on `main` with what the repo's stacks need, so a merged PR that turned a module off
   shows up, and it lists every `NuGetAuditSuppress` with its dated reason. It also reports runtimes near
   end of life — .NET 8 and 9 end on 2026-11-10.

## Migration from workbench

`repo-hygiene.mjs`, its tests, `docs/repo-hygiene.md`, and both workflows move to Ward. Workbench keeps
its `repo-hygiene.yml` for one release as a forwarder that calls Ward, so nothing breaks mid-move. Then
the five consumer repos (hugin, malinfossum, profile-dashboard, spindle, varde) and the six scaffolds
switch to the Ward caller, and the forwarder is removed. The weekly audit needs the
`PROFILE_README_TOKEN` secret set on Ward — I set that by hand. Spindle's `commit-identity.yml` is
retired in favour of the `identity` module, which allows `dependabot[bot]`.

## Testing Ward itself

Can every part of the circle be tested? Yes, with one link that sits outside GitHub.

- **Dogfood and fixtures.** Ward calls its own `ci.yml` by local path, once on `ubuntu-latest` and once
  with `dotnet-os: windows-latest`, so every change runs through the entry point, and the Windows path
  WPF repos use, before it merges. Every script runs against good and broken fixtures in the `fixtures`
  job.
- **Mutation rule.** Every module has at least one fixture it rejects, because a check that never fails
  is untested. A test reads the module list from `ci.yml` and fails when a module has no rejecting case.
- **Red gate end to end.** Before Plan 1 ships, a throwaway PR points Ward at the broken dotnet and node
  fixtures and adds a commit by a foreign author with a `Co-authored-by` trailer; `ward / dotnet`,
  `ward / node`, `ward / identity` and `ward / gate` must all go red.
- **Auto-merge, observed.** Before the rollout to other repos (Plan 5), I watch auto-merge on Ward itself
  do both of its jobs once: merge a first-party patch bump, and refuse one it must refuse.
- **Canary on the published tag.** Dogfooding tests Ward at the PR head, not the `@v1` other repos run.
  A canary workflow in Ward (Plan 5, after `v1.0.0`) calls `malinfossum/ward/.github/workflows/ci.yml@v1`
  exactly as a consumer does, against a good and a broken fixture, weekly and after every tag.
- **Mutual watchdogs.** `repo-audit` (Plan 2) and the canary (Plan 5) watch each other: once both exist,
  each fails when the other's last run is red or older than 8 days.
- **Their shared blind spot.** GitHub disables scheduled workflows after 60 days without repository
  activity, and then both watchdogs stop together, silently. The watchdog outside GitHub's schedule is
  my Monday `/morning` briefing: it runs `gh run list` for the canary and the audit and flags either
  one when it is red or older than 8 days. It lands with Plan 2.
- **Last link.** A failed scheduled run emails me from GitHub.

## Rollout

1. Ward core: `ci.yml`, `gate`, `identity`, `node`, `dotnet`, templates, self-test. Exit: a fixture repo
   per stack passes, every module has a broken fixture it rejects, and a throwaway PR proves `ward / gate`
   red end to end for dotnet, node and identity.
2. Hygiene and audit migration, with the audit's caller-input comparison, suppression list and canary
   watchdog, and the `/morning` outside watchdog. Exit: audit runs from Ward and reports every repo.
3. `ward` skill + `apply.mjs`, and the loadout pre-push hook. Exit: applied to one web repo and one C#
   repo end to end.
4. `ward-a11y` package and live-region checks; Guidepup spike in Playwright without a CDN script tag.
   Exit: each live-region rule has a failing fixture that fails and a clean one that passes.
5. `v1.0.0`, then Ward's own auto-merge job on the released SHA and the canary on `@v1`; then roll out to
   every public repo in `warn`, then scaffolds. Gate: one observed auto-merge and one observed refusal on
   Ward before any other repo gets auto-merge. Exit: audit shows zero repos missing the baseline.
6. python, powershell, docker modules; WPF spike.

**Dated follow-up:** raise the Node default to 26 after it becomes Active LTS on 2026-10-28.

## Versions (verified 2026-09-25)

| Tool | Version |
|---|---|
| actions/checkout · setup-node · setup-python | v7 |
| actions/setup-dotnet | v6 |
| github/codeql-action | v4.38.2 |
| dependabot/fetch-metadata | v3.1.0 |
| hadolint/hadolint-action | v3.5.0 (no `v3` major tag — pin SHA) |
| Node.js | 24 LTS (26 LTS from 2026-10-28) |
| .NET SDK | 10.0.401 (.NET 10 LTS) · dotnet-ef 10.0.12 |
| @biomejs/biome | 2.5.14 |
| vitest | 5.0.2 |
| @playwright/test | 1.63.0 |
| axe-core · @axe-core/playwright | 4.13.0 |
| @guidepup/virtual-screen-reader | 0.33.0 |
| typescript | 7.0.2 |
| astro · @astrojs/check | 7.3.5 · 0.9.10 |
| wrangler · @cloudflare/vitest-pool-workers | 4.140.0 · 0.22.0 |
| ruff · pytest | 0.16.9 · 9.1.1 |
| PSScriptAnalyzer · Pester | 1.25.0 · 6.2.0 |
| Axe.Windows | 2.4.2 |

## Not included, and why

- **SonarCloud, Snyk, DeepSource** — overlap CodeQL and the .NET analyzers, add noise and an account.
- **AI reviewer on every PR** — duplicates my local `/code-review`, costs money, and commits or comments
  as a bot identity.
- **Agentic autofix / bots that push fixes** — billed, and commits as a bot identity; Copilot Autofix
  suggestions I accept cover the useful part.
- **`npm audit` in CI** — duplicates Dependabot alerts with more noise.
- **Renovate** — grouped Dependabot covers a solo workflow.
- **OpenSSF Scorecard** — a badge more than a control at this scale.
- **Pa11y** — superseded by the Playwright page audit, which also drops Puppeteer and its install-script
  trap.

## Open risks

- Guidepup in Playwright is documented only via a CDN script tag; the spike must load it from
  `node_modules`.
- Axe.Windows activity is low; the WPF path may end on the UI Automation fallback.
- The ruleset's "require code scanning results" rule was not in the 2026-09-25 verification pass;
  confirm it is free on public repos before step 1 relies on it.
- Publishing `@malinfossum/ward-a11y` to npm is a gated step I do or approve at the time.

> Stress-tested 2026-09-28 (skill 2120355) — 28 applied, 2 adapted, 3 decided by me.
