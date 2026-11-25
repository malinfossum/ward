# Project note: Ward

A summary of what Ward is, how it works, how it is built and where it stands.

**Last updated:** 25.11.2026 · **Version:** v1.11.0 · **Status:** finished and in daily use

---

## In short

Ward is the shared CI, security and accessibility standard for all my GitHub repos. Each repo calls one reusable workflow, and Ward runs the checks that fit the repo's stack. The result is a single required check, `ward / gate`, so a red check always blocks a merge. The name is the English word for guarding something.

## Background

By September 2026 I had many repos, and their coverage was uneven. Some had CI, most of the C# repos had none, Dependabot ran in three, and nothing made a red check block a merge.

The idea was one public repo that holds the whole standard. Every repo, scaffolded from my workbench or not, calls the same checks and gets improvements by moving one tag. Two rules guided it: nothing goes in unless it catches a real class of defect, and only safe fixes happen on their own.

## How a pull request goes through Ward

I open a pull request in one of my repos. Its caller, `.github/workflows/ward.yml`, calls `ci.yml@v1` in Ward with the folders that hold each stack. Ward starts one job per module. The identity module checks that every commit is mine or Dependabot's and carries no AI attribution. The node module runs the `lint`, `typecheck`, `test` and `build` scripts the repo defines, and fails if lint changes a tracked file. The dotnet module builds with warnings as errors, checks formatting, runs the tests and looks for pending EF Core migrations. The PowerShell module runs Pester 5. CodeQL runs beside them through the caller's own `codeql` job.

At the end, the `gate` job reads every module's result. A failed or cancelled module fails the gate, and a module the repo doesn't use is skipped. The ruleset on `main` requires `ward / gate`, so the merge button stays locked until it is green.

If the pull request is a Dependabot bump, a second workflow decides whether it may merge on its own. Patch and minor updates, majors of development dependencies and Ward bumps to a release tag merge when every check is green. Third-party actions and runtime-bound .NET packages wait for me.

Two more workflows run on a schedule. Each Monday, `repo-audit.yml` sweeps every repo I own and reports drift: missing settings, a caller off `@v1`, a stack the caller doesn't cover, an exception past its reason. `canary.yml` runs the published `@v1` as a consumer would, every Monday and after every release, so a broken release shows up before a real repo finds it.

## Stack

GitHub Actions reusable workflows. Node 26 scripts with no runtime dependencies, tested with `node:test`. Biome for lint and format. Pester 5 under PowerShell 7 for the PowerShell module. Fixture projects in Node, C# (xUnit) and PowerShell (Pester) that the checks must accept or reject. Releases are `vX.Y.Z` tags, with a moving `v1` tag that callers follow.

## Architecture

- **`.github/workflows/`**: `ci.yml` is the entry point, with one job per module and the final `gate`. Beside it sit `codeql.yml`, `dependabot-automerge.yml`, `repo-hygiene.yml`, `repo-audit.yml`, `canary.yml` and Ward's own caller.
- **`tools/`**: the scripts each job runs. Workflows stay thin and call these, so the logic has unit tests.
- **`stacks.json`**: which files mean which module, plus dated exceptions for repos that keep a module off on purpose. The audit and the apply script both read it.
- **`templates/`**: what a repo copies: the caller, the Dependabot config, the rulesets and `Directory.Build.props`.
- **`tools/apply.mjs`**: puts a repo on the standard. It detects the stacks, writes the files and applies the GitHub settings, showing each change before it makes it.
- **`fixtures/` and `tests/`**: known-good and known-broken projects, and the tests that run the real scripts against them.

## Decisions worth explaining

**Fix only the safe classes on their own.** Dependency bumps, formatting and CodeQL suggestions are safe to automate. A bot that edits code until CI is green is not, because it can pass by weakening a test. So Ward merges a narrow set of Dependabot updates and nothing else. I left out bots that push fixes and AI reviewers on every pull request: both commit or comment as a bot identity, and the reviewer duplicates the review I already run locally.

**One required check, whatever the stack.** A repo with Node and C# still has one required check. Without that, every new stack would mean a ruleset change in every repo, and a missing required check fails silently: the merge just goes through.

**Callers pin Ward's privileged jobs to a release commit.** The `codeql` and `automerge` jobs need write permissions, so they never follow the moving `v1` tag. They are pinned to the commit of a `vX.Y.Z` tag, and a test checks every pin against the tags. A pin on any other commit makes Dependabot track `main` instead of moving from release to release. That happened once, and the test came from it.

## Install

Ward is meant for my own repos, but it is public and MIT licensed, so anyone can call it. Copy `templates/ward.yml` to `.github/workflows/ward.yml` and set the inputs for the folders that hold each stack. The README lists the modules and their inputs. To get the ruleset, Dependabot and settings as well, `tools/apply.mjs` does the whole setup and shows each change before it makes it.

## Status

Version v1.11.0, released 25.11.2026. It is the 15th release; the first, v1.0.0, came on 29.09.2026. `main` has 226 commits from 25.09.2026 to 25.11.2026, across 66 pull requests. The unit tests run 340 tests: 339 pass and 1 is skipped, because it needs a GitHub token. The 19 fixture tests run the real scripts against good and broken projects, and all 19 pass. The scripts in `tools/` are 3 892 lines and the workflows 631. The tests are 6 131 lines.

18 repos call Ward today, Ward included: 17 on my own account and one in an organization. One joint repo is not on it yet, because the co-owner has not agreed to the caller and the ruleset.

Ward was for catching problems before they reach `main` without me checking each repo by hand. In daily use it does that: a red check blocks the merge, safe bumps merge on their own, and the Monday audit tells me where a repo has drifted.

## Common questions

| Question | Answer |
|---|---|
| Why a separate repo and not part of the workbench? | Repos that don't come from the workbench must be able to call it too. A public repo can only call a public reusable workflow, so Ward is public. |
| Why not Renovate, SonarCloud or Snyk? | SonarCloud and Snyk overlap CodeQL and the .NET analyzers, and add noise and another account. Grouped Dependabot updates cover what Renovate would do for one person's repos. |
| What happens when a repo needs a module off? | It gets a dated exception in `stacks.json` with a reason. The audit reports every exception each week, so none outlives its reason. |
| Does Ward ever commit to my repos? | No. Only Dependabot authors commits, through its own pull requests. The identity module fails any other author. |
| How does a repo get a fix in Ward? | Callers follow `v1`, so a new release reaches every repo when the tag moves. Pinned jobs move through Dependabot bumps that merge on their own. |

## Feedback and contributions

1. **Accessibility is the weakest part.** The design planned a shared package with Playwright helpers and a live-region audit. It hasn't shipped. Today Ward only runs a repo's own `test:a11y` script if it has one.
2. **Python and Docker are detected but not covered.** `stacks.json` lists both as planned, so the audit reports them as uncovered stacks rather than checking them.
3. **The pin rule is easy to get wrong.** A release cannot pin its own merge commit, so the template lags one release behind. The test catches mistakes, but the rule itself needs a careful read of the README.
4. **One live test needs a token.** The test that checks Ward against its own baseline is skipped offline, so it only runs where a GitHub token is set.

Ward is MIT licensed and pull requests are welcome. I hope the tool can be useful to more people than me.

**Links:** [code and releases](https://github.com/malinfossum/ward) · specifications under `docs/specs/` · plans under `docs/plans/`
