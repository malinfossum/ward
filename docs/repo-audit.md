# Repo audit

Once a week Ward walks every repo I own and reports what has drifted from the standard. The README
checks are [`tools/repo-hygiene.mjs`](../tools/repo-hygiene.mjs); everything else is
[`tools/repo-audit.mjs`](../tools/repo-audit.mjs). Both run from
[`.github/workflows/repo-audit.yml`](../.github/workflows/repo-audit.yml) on Monday mornings and
on demand, in strict mode: a finding on a non-archived repo fails the run, and a failed scheduled
run emails me.

## What the audit checks, per repo

| Kind | Finding |
|---|---|
| `baseline` | Dependabot alerts, Dependabot security updates, secret scanning, push protection or CodeQL default setup is off |
| `ruleset` | The default branch has no pull-request rule, does not block force pushes (non-fast-forward) or deletion, does not require code scanning results, or does not require the `ward / gate` check |
| `caller` | No `.github/workflows/ward.yml`, or it does not call `malinfossum/ward/.github/workflows/ci.yml@v1`, or its automerge job does not pin `dependabot-automerge.yml` to a full Ward commit SHA |
| `inputs` | Files of a stack are on `main` but the caller leaves that module off, or an input points at a path that is not there |
| `suppression` | A `<NuGetAuditSuppress>` without a `YYYY-MM-DD` dated comment beside or above it |
| `runtime` | A `<TargetFramework>` or the caller's `node-version` within 90 days of end of life, or past it |
| `canary` | Ward's `canary.yml` last completed run is not `success`, is older than 8 days, or is missing (a 404) |
| `exception` | Warning: a module the repo keeps off on purpose, listed in `stacks.json` under `exceptions` with a dated reason; also a stale exception (no files for that module, or the input is set), and a `caller`, `ruleset` or `baseline` finding deferred on a joint repo |
| `error` | The audit could not read the repo (a GitHub API error); the other repos still report |

Warnings, which never fail the run: `uncovered` (files of a stack no module covers yet, see
`stacks.json`), `exception` (a module kept off on purpose, listed with its reason), `token` (the token cannot read a repo's settings; on my own repos, and on an org
with its own token, this fails the run instead), and whatever `--warn-kinds` names for a run.
Private repos never enter the sweep: it lists public repos only, since they keep Actions off and sit
outside the standard.
Archived repos are listed in a collapsed section and never fail the run. Every suppression found is
listed in a table in the run summary, dated or not.

Stack detection reads [`stacks.json`](../stacks.json): a `package.json` means `node`, a `.sln`,
`.slnx` or `.csproj` means `dotnet`, paths under `node_modules/`, `bin/`, `obj/` and `.git/` are
ignored.
End-of-life dates live in `EOL` at the top of the checks and were verified on endoflife.date.

## Running it

```bash
GITHUB_TOKEN=$(gh auth token) WARD_AUDIT_TOKEN=$(gh auth token) node tools/repo-audit.mjs --owner malinfossum,rookdex,wendhq --include-archived
GITHUB_TOKEN=$(gh auth token) WARD_AUDIT_TOKEN=$(gh auth token) node tools/repo-audit.mjs --owner malinfossum --mode strict --warn-kinds caller
```

My user token from `gh auth token` has admin read on my own repos, so locally it stands in for both.
`--mode strict` exits 1 on findings; the default `warn` exits 0. `--warn-kinds` names kinds that
stay warnings for that run. The live unit test runs with the
same variable: `GITHUB_TOKEN=$(gh auth token) npm test`.

## The tokens

Everything the audit reads is public, except the four settings endpoints, which need admin read.
So two tokens do the work. The Actions token (`GITHUB_TOKEN`) lists the repos and reads trees,
callers, project files and branch rules; its limit of 1,000 requests per hour per repository covers
about 90 repos at the sweep's ten calls per repo. `WARD_AUDIT_TOKEN` is a fine-grained token
with **Administration (read)** on all my repositories and nothing else, not even Contents: it
touches only the settings endpoints, and if it leaks it can read settings, never code. A
fine-grained token covers one owner, so `WARD_AUDIT_TOKEN` covers my own repos only, and an org
gets its settings read only through its own `AUDIT_TOKEN_ROOKDEX` or `AUDIT_TOKEN_WENDHQ`. Without
one, the audit does not read that org's settings at all: each of its repos gets one `token` warning
that names the missing secret, and every other check still runs. On my own repos, and on an org that
has its own token, a `token` finding fails the run instead: a missing or expired token must not turn
the settings checks into a silent pass. The token expires after a year; the Monday after, the audit goes red with a `token`
finding on every repo of mine, which is the reminder to make a new one.

Setting it up:

1. I create a fine-grained token with resource owner `malinfossum`, "All repositories", the
   permission Administration (read) and nothing else, and an expiry of one year.
2. I add it on Ward under Settings, Secrets and variables, Actions, as `WARD_AUDIT_TOKEN`.
3. I run `repo-audit.yml` once by hand and read the log before the first Monday run.

## The watchdogs

The audit fails when the canary's last completed run is red, older than 8 days, or missing
altogether (a 404 for `canary.yml` is a deleted or renamed canary, not "not yet"). The canary runs
`tools/watchdog.mjs repo-audit.yml`, which fails when the audit has not completed a run in 8 days
or has never run; it does not look at the audit's conclusion, because a red audit already fails
and emails me on its own, and because a conclusion check in both directions would deadlock on the
first run. GitHub turns scheduled workflows off after 60 days without activity, which would stop
both at once, so my Monday `/morning` briefing runs `gh run list` for both and flags either one
that is red or older than 8 days.

```bash
GITHUB_TOKEN=$(gh auth token) node tools/watchdog.mjs repo-audit.yml
```
