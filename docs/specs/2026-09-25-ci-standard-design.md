# Ward — CI and security standard

**Status:** design, awaiting review · **Date:** 2026-09-25

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
│   ├── ci.yml              reusable entry point: inputs per stack, final `gate` job
│   ├── node.yml            reusable module: npm scripts contract
│   ├── dotnet.yml          reusable module: build, format, test, EF check
│   ├── python.yml          reusable module
│   ├── powershell.yml      reusable module
│   ├── docker.yml          reusable module
│   ├── identity.yml        reusable module: commit author + trailer guard
│   ├── dependabot-automerge.yml   reusable: patch/minor auto-merge
│   ├── repo-hygiene.yml    reusable (moved from workbench)
│   ├── repo-audit.yml      weekly sweep over every repo (moved from workbench)
│   └── self-test.yml       Ward's own CI
├── templates/              dependabot.yml per ecosystem mix, caller ci.yml, ruleset.json
├── packages/a11y/          @malinfossum/ward-a11y — Playwright helpers + live-region audit
├── tools/                  repo-hygiene.mjs, repo-audit additions, apply.mjs
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

## The caller

The only CI file a repo carries:

```yaml
# .github/workflows/ward.yml
name: Ward
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  ward:
    uses: malinfossum/ward/.github/workflows/ci.yml@v1
    with:
      node: web          # working directory, empty = module off
      dotnet: api
      dotnet-ef: true
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

## Baseline — every public repo I own

| Control | Catches | Where |
|---|---|---|
| Dependabot security updates | Known-vulnerable dependencies | Repo setting |
| Dependabot version updates, weekly, grouped | Drift that turns into a painful major jump; stale pinned actions | `dependabot.yml` from `templates/` |
| Secret scanning + push protection | A credential pushed by mistake — blocked before it lands | Repo setting |
| CodeQL default setup + Copilot Autofix | Injection, XSS, unsafe deserialisation, workflow script injection (the `actions` language); Autofix proposes the patch on the PR | Repo setting |
| Ruleset on `main` | Merging red, force-pushing, deleting `main` | `templates/ruleset.json` via API |
| `identity` job | Commits authored as anyone but me or Dependabot; `Co-Authored-By` / `Claude-Session` / "Generated with" trailers | `identity.yml` in `ci.yml`, always on |
| `repo-hygiene` job | README drift against the repo | Existing checker, `warn` by default |

**Ruleset contents:** target the default branch; require a pull request (0 approvals — I am the only
reviewer); require status check `ward / gate` and a strict up-to-date branch; require code scanning
results (CodeQL, errors only); block force pushes and deletion; no bypass actors.

**Dependabot template:** one group per ecosystem for `minor` + `patch` version updates, majors ungrouped
so each gets its own PR. The default 3-day cooldown stays — a freshly published malicious version has
three days to get caught before it reaches me. Security updates skip the cooldown.

## Auto-merge

`dependabot-automerge.yml`, called from the `automerge` job in the same caller, runs on `pull_request`
only when the author is `dependabot[bot]`. It uses `dependabot/fetch-metadata` and runs
`gh pr merge --auto --squash` when **all** of these hold:

- `update-type` is `version-update:semver-patch` or `version-update:semver-minor`;
- no dependency in the PR matches the runtime-bound list: `Microsoft.AspNetCore.*`,
  `Microsoft.EntityFrameworkCore.*`, `Microsoft.Extensions.*`, `Microsoft.NET.*`, `System.*`, or the SDK
  in `global.json`;
- the repo has the ruleset. **Auto-merge on a repo without required checks merges instantly**, so
  `apply.mjs` only enables "Allow auto-merge" after the ruleset is in place, and the workflow checks for
  the required check via the API and refuses if it is missing.

The merge itself waits for `ward / gate` and CodeQL. Majors and runtime-bound packages stay as open PRs
for me. Squash is the method because a Dependabot PR is one commit.

Joint repos (org-owned with a co-owner) get auto-merge only after the co-owner agrees; until then they
get everything else.

## Security of Ward itself

Every repo runs Ward's code, so Ward is the most trusted repo I own and gets the strictest protection.

- **Threat:** someone with push access to Ward changes what every repo runs. The CI modules get a
  read-only token and no secrets, so a bad module can at worst report a false green. The auto-merge job
  holds `contents: write` and `pull-requests: write`, so it is the one that matters.
- **Pinning:** callers use `@v1` for the read-only CI entry point, so improvements propagate. The
  `automerge` job is pinned to a full commit SHA with a version comment; Dependabot proposes each bump as
  a PR I read, so the write-holding code never changes under a repo silently.
- **Ward's own rulesets:** the branch ruleset from the baseline, plus a tag ruleset on `v*` that blocks
  updates and deletion, with repository admin as the only bypass (moving `v1` is part of every release).
  It stops accidents and any future collaborator; it does not stop someone holding my own admin token —
  that is what 2FA and a minimal-scope `gh` token are for.
- **Triggers:** Ward uses `pull_request`, never `pull_request_target`, so fork PRs run with a read-only
  token and no secrets.
- **Supply chain:** the 3-day Dependabot cooldown keeps a freshly published malicious patch out long
  enough for it to be caught upstream. Auto-merged changes still pass tests and CodeQL, and repos that
  deploy on merge to `main` (Ignite, Kenaz, Rookdex) are the ones where this matters most.
- **Account:** 2FA stays on; Ward holds no secrets except the audit token, which is read-only.

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
| E2E + a11y | `npm run test:e2e` (Playwright) | when `a11y` ≠ `off` |
| Worker dry run | `npm run deploy:check` (`wrangler deploy --dry-run`) | when `wrangler.*` exists |

Per stack, `typecheck` is `tsc --noEmit` (React/Workers) or `astro check` (Astro). Workers unit tests
use `@cloudflare/vitest-pool-workers`. Node version input defaults to **24** (Active LTS today).

### dotnet — console, layered, WPF, ASP.NET Core + EF

`dotnet restore` → `dotnet build -warnaserror` → `dotnet format --verify-no-changes` → `dotnet test`.
Repos carry a `Directory.Build.props` from `templates/` with `AnalysisLevel=latest-recommended`,
`TreatWarningsAsErrors=true`, `NuGetAudit=true`, `NuGetAuditMode=all`, so a vulnerable package
(NU1901–NU1904) fails the build. `dotnet-ef: true` adds
`dotnet ef migrations has-pending-model-changes` (exit 1 when I changed the model and forgot the
migration). `os` input: `ubuntu-latest` by default, `windows-latest` for WPF. SDK from `global.json`.

### python · powershell · docker

- **python** — `ruff check`, `ruff format --check`, `pytest`.
- **powershell** — PSScriptAnalyzer (errors and warnings fail), Pester.
- **docker** — hadolint on every `Dockerfile`; Dependabot `docker` ecosystem bumps base images.

### Out of scope

Private repos (brain, claude-harness, respawn, loadout) keep Actions disabled and the local secret gate,
as already decided. Other private repos and forks are not covered. Deploy workflows stay per repo.

## Accessibility module

Runs inside the `node` module's `test:e2e` step, through `@malinfossum/ward-a11y`. Automated checks catch
a minority of accessibility defects; a manual NVDA pass with workbench's live-region sandbox stays part
of every release checklist.

**Page audit** (`auditPage(page)`), run for every route in both themes and both languages:

- axe with WCAG 2.2 AA tags;
- reflow: no horizontal scroll at 320 CSS px;
- target size: interactive controls ≥ 44 × 44 px;
- visible focus: every focusable element changes outline or box-shadow on focus;
- failure messages: each form or async action under test surfaces its error in a live region, in the
  current language.

**Live regions** — the audit plus two helpers:

| Practice | Check | Result |
|---|---|---|
| Valid `aria-live`, `aria-atomic`, `aria-busy`, `aria-relevant`, live roles | axe | fail |
| Insert regions into the DOM early | Regions recorded at load; a MutationObserver flags any added afterwards | fail |
| Limit the number of regions | More than 2 per view (one `status`, one `alert`) | fail |
| Avoid rich and interactive content | Focusable or interactive descendant inside a region | fail |
| Clear between updates; insert updates at once | `expectAnnouncement(page, action, text)` records spoken output with `@guidepup/virtual-screen-reader`: the same action twice announces twice, one action announces once | fail |
| Keep content clear and succinct | Announcement over 150 characters | warn |
| Prefer robust solutions | Bare `aria-live` where `role="status"`, `role="alert"` or `<output>` fits | warn |

**Modes:** `strict` fails the gate, `warn` reports as annotations. New repos start `strict`; existing
repos start `warn` and move to `strict` one by one as they come clean.

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
   secret scanning, CodeQL, ruleset), caller present on `@v1`, and no uncovered stack. It also reports
   runtimes near end of life — .NET 8 and 9 end on 2026-11-10.

## Migration from workbench

`repo-hygiene.mjs`, its tests, `docs/repo-hygiene.md`, and both workflows move to Ward. Workbench keeps
its `repo-hygiene.yml` for one release as a forwarder that calls Ward, so nothing breaks mid-move. Then
the five consumer repos (hugin, malinfossum, profile-dashboard, spindle, varde) and the six scaffolds
switch to the Ward caller, and the forwarder is removed. The weekly audit needs the
`PROFILE_README_TOKEN` secret set on Ward — I set that by hand. Spindle's `commit-identity.yml` is
retired in favour of the `identity` module, which allows `dependabot[bot]`.

## Rollout

1. Ward core: `ci.yml`, `gate`, `identity`, `node`, `dotnet`, templates, self-test. Exit: a fixture repo
   per stack passes, and a deliberately broken fixture fails `ward / gate`.
2. Hygiene and audit migration. Exit: audit runs from Ward and reports every repo.
3. `ward` skill + `apply.mjs`. Exit: applied to one web repo and one C# repo end to end.
4. `ward-a11y` package and live-region checks; Guidepup spike in Playwright without a CDN script tag.
   Exit: each live-region rule has a failing fixture that fails and a clean one that passes.
5. Roll out to every public repo in `warn`, then scaffolds. Exit: audit shows zero repos missing the
   baseline.
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
