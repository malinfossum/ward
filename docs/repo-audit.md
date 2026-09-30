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
| `ruleset` | The default branch has no pull-request rule, or does not require the `ward / gate` check |
| `caller` | No `.github/workflows/ward.yml`, or it does not call `malinfossum/ward/.github/workflows/ci.yml@v1` |
| `inputs` | Files of a stack are on `main` but the caller leaves that module off, or an input points at a path that is not there |
| `suppression` | A `<NuGetAuditSuppress>` without a `YYYY-MM-DD` dated comment beside or above it |
| `runtime` | A `<TargetFramework>` or the caller's `node-version` within 90 days of end of life, or past it |
| `canary` | Ward's `canary.yml` last completed run is not `success` or is older than 8 days |
| `error` | The audit could not read the repo (a GitHub API error); the other repos still report |

Warnings, which never fail the run: `uncovered` (files of a stack no module covers yet, see
`stacks.json`), `canary-missing` (no `canary.yml` until Plan 5), `token` (the token cannot read a
repo's settings; on my own repos, and on an org with its own token, this fails the run instead), and
whatever `--warn-kinds` names for a run: the workflow passes `--warn-kinds caller` until Plan 5 rolls
the caller out, so a red run means new drift, not the rollout.
Private repos never enter the sweep: it lists public repos only, since they keep Actions off and sit
outside the standard.
Archived repos are listed in a collapsed section and never fail the run. Every suppression found is
listed in a table in the run summary, dated or not.

Stack detection reads [`stacks.json`](../stacks.json): a `package.json` means `node`, a `.sln`,
`.slnx` or `.csproj` means `dotnet`, paths under `node_modules/`, `bin/` and `obj/` are ignored.
End-of-life dates live in `EOL` at the top of the checks and were verified on endoflife.date.

## Running it

```bash
GITHUB_TOKEN=$(gh auth token) node tools/repo-audit.mjs --owner malinfossum,rookdex,wendhq --include-archived
GITHUB_TOKEN=$(gh auth token) node tools/repo-audit.mjs --owner malinfossum --mode strict --warn-kinds caller
```

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
fine-grained token covers one owner, so an org can carry its own in `AUDIT_TOKEN_ROOKDEX` or
`AUDIT_TOKEN_WENDHQ`. Without one, that org's repos get a `token` warning for the settings reads and
every other check still runs. On my own repos, and on an org that has its own token, a `token`
finding fails the run instead: a missing or expired token must not turn the settings checks into a
silent pass. The token expires after a year; the Monday after, the audit goes red with a `token`
finding on every repo of mine, which is the reminder to make a new one.

## The watchdogs

The audit fails when the canary's last run is red or stale, and the canary (Plan 5) does the same
for the audit. GitHub turns scheduled workflows off after 60 days without activity, which would
stop both at once, so my Monday `/morning` briefing runs `gh run list` for both and flags either
one that is red or older than 8 days.
