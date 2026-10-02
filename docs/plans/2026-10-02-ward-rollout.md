# Ward rollout: canary, watchdogs, auto-merge and the baseline on every repo (Plan 5 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the testing circle around the published `@v1` (a canary that runs it as a consumer, and watchdogs in both directions), give Ward its own auto-merge job on a released SHA, prove auto-merge once each way on Ward, and then put the caller, the Dependabot config, the settings and the ruleset on every public repo I own and on the six scaffolds, so that the weekly audit can run strict with no `--warn-kinds` and report zero repos missing the baseline.

**Architecture:** Ward-side first, as one PR: `canary.yml` (weekly and after every release) calls `malinfossum/ward/.github/workflows/ci.yml@v1` against the good fixtures, runs the published tag's own fixture suite for the broken ones, and runs a new `tools/watchdog.mjs` against the audit; the audit's canary check loses its "not yet" warning; `stacks.json` gains a dated exception list for repos where a detected module stays off on purpose; `ward.yml` gains the `automerge` job at the `v1.1.0` commit. Then `v1.2.0`, the two observed auto-merge outcomes on Ward, and the rollout in two waves of PRs (identity-only callers, then module callers), followed by Malin's settings and ruleset pass per repo, a cleanup wave that retires the old CI, the scaffolds, and finally the flag removal. Settings, rulesets and "Allow auto-merge" are changed only by Malin, with the exact commands given here; Plan 3 turns those commands into `apply.mjs`.

**Tech Stack:** GitHub Actions (reusable and scheduled workflows), Node 24 ESM scripts with no dependencies, `node:test`, Biome 2.5.14, GitHub REST API via `fetch` and `gh`.

**Spec:** `docs/specs/2026-09-25-ci-standard-design.md` (rollout item 5; sections The caller, Baseline, Auto-merge, Security of Ward itself, Testing Ward itself, Rollout). Stress-test findings 9, 24 and 25 (2026-09-28) are folded in: the rollout is gated on one observed auto-merge and one observed refusal, `./` calls to the auto-merge workflow are banned by test (already in `tools/workflows.test.mjs`), and the tag ruleset blocks creation (already live as ruleset 24164641).

## Global Constraints

- English, first person, short direct sentences. No em dashes anywhere: not in code comments, docs, commit messages, PR bodies or this plan. Never a `Co-Authored-By` trailer or AI attribution in commits.
- Node **24** in every workflow and as the local floor (`engines: >=24`); scripts use the Node standard library only. Biome **2.5.14**: `npm run lint` is `biome ci .` and must exit 0 with clean output. Unit tests: `node --test "tools/*.test.mjs"` (`npm test`). Fixture tests: `npm run test:fixtures`. Both stay green; new totals are stated as "previous count + N", never invented.
- Every `uses:` of an action is pinned to a full 40-character commit SHA with a `# vX.Y.Z` comment. The three actions this plan needs already appear in `ward.yml`; reuse their SHAs:
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
  - `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`
  - `actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6.0.0`
- `pull_request`, never `pull_request_target`. No input, event field, `github.head_ref` or `secrets.*` inline in `run:`; values reach a script through `env:`. Scripts start processes as argument arrays, never shell strings.
- Every workflow sets `permissions: contents: read` at the top level; a job that needs more declares it at job level. Every job that runs steps has `timeout-minutes`: 30 for `node`, `dotnet` and fixture jobs, 10 for everything else. Every workflow that runs steps sets `DOTNET_CLI_TELEMETRY_OPTOUT: "1"`, `ASTRO_TELEMETRY_DISABLED: "1"` and `WRANGLER_SEND_METRICS: "false"`.
- The auto-merge workflow is called at a full commit SHA of a released tag, never `@v1` and never `./` (test in `tools/workflows.test.mjs`). The pin is the **commit** SHA (`git rev-parse <tag>^{commit}`), never the tag object's SHA.
- Findings are `[kind, message]` pairs. Annotations are `::error::` (strict, fails) and `::warning::` (never fails). A script that fails sets `process.exitCode = 1`; nothing calls `process.exit`. Public CI logs never print an email address unredacted.
- Branch `feat/rollout` off `main` for the Ward-side work (Tasks 1 to 5); `chore/warn-kinds` for Task 12. Commit after every task. Commit author `malinfossum.dev@proton.me`. Merging, tagging, releasing, and any change to `.claude/` are Malin's calls.
- Outside Ward (seventeen consumer repos, workbench, the morning skill) the agent only opens PRs, and only after the go that comes with Task 7. The agent never merges, never changes a repo setting, never creates or edits a ruleset, never turns on "Allow auto-merge": those are Malin's commands in Task 10. The `wendhq/wend` PR and settings wait for the co-owner's agreement; the agent asks Malin before opening that one.
- `a11y` stays `"off"` in every caller this plan writes: `warn` requires a `test:a11y` script, which arrives with Plan 4.

## Review Focus

Each line names an input the spec implies but no existing test covers, and the task whose tests now pin it.

1. The canary's watchdog ignores the audit's conclusion and fails only when the audit's last completed run is older than 8 days or has never happened: a red audit already fails and emails on its own, and a conclusion check in both directions deadlocks on the first run (the audit is red because the canary never ran, the canary is red because the audit is red). Pinned in Task 1 (`watch` tests: red but fresh passes, 9 days old fails).
2. After this plan a 404 for `canary.yml` is a hard `canary` finding on every run, never a warning, while 401 and 403 stay `token`: a renamed or deleted canary must not read as "not yet" for ever. Pinned in Task 1 (`checkCanary(null)` and `canaryFindings(404)` tests).
3. An `updated_at` or `now` that does not parse reads as stale, never as fresh. Pinned in Task 1 (`lastRunProblem` test with `"x"`).
4. An exception in `stacks.json` whose module has no files on the default branch, or whose caller input is set anyway, is reported as a stale exception so I remove it; a live exception is a warning naming its reason, never silence. Pinned in Task 3 (`checkInputs` tests).
5. Exception keys match the repo name case-insensitively, because GitHub repo names are. Pinned in Task 3 (`exceptionsFor` test).

## Decisions (all as recommended, Malin 2026-10-02)

Each one was written with my recommendation first; I took every recommendation on 2026-10-02, so the alternatives below are history, not open questions.

- **D1, the canary's broken half.** A reusable-workflow job cannot be marked expected-to-fail, and a canary that is red by design every Monday would email me into ignoring it. Recommendation: the broken fixtures run through the published tag's scripts and fixture suite (`actions/checkout` at `ref: v1`, then `npm run test:fixtures`) instead of through `ci.yml@v1`'s gate; the good fixtures go through `ci.yml@v1` exactly as a consumer. The gate's red path is pinned by a unit test on `ci.yml` and was proven end to end by the Plan 1 red-gate PR. Recorded as a Plan 5 deviation in the spec.
- **D2, watchdog direction.** Recommendation: the audit fails when the canary is red or stale (as today); the canary fails when the audit is stale or has never run, but not when it is merely red. Review Focus 1 explains why. Recorded as a deviation.
- **D3, exceptions.** Four repos keep a detected module off on purpose: `backend-course` (dotnet: one solution per week, no single entry point), `devops-course` (dotnet: one project, no tests), `workbench` (node and dotnet: scaffold copies, tested by workbench's own `ci.yml`), `ember-black` (node: a VS Code theme with a `build` script and no lock file, nothing to lint or test). Recommendation: a dated `exceptions` map in `stacks.json`, reported weekly as an `exception` warning so none of them outlives its reason. Alternative for `ember-black`: give it a lock file, Biome and a smoke test, which is a small PR but new tooling in that repo.
- **D4, hygiene stays its own caller.** Recommendation: `repo-hygiene.yml` keeps its own caller file and is not folded into `ward.yml`; the five repos that want it already have it, and folding it would make a README nit block every merge through `ward / gate`.
- **D5, course repos get the ruleset.** `backend-course` and `devops-course` are public coursework. Recommendation: they get the full baseline including the pull-request rule, like every other public repo; if the course needs direct pushes to `main`, say so and they get the ruleset without the pull-request rule, recorded in the plan.
- **D6, script fixes in consumer repos.** Three repos fail the node contract as they stand: `hugin` (`hugin-web` has a `tsconfig.json`, so `typecheck` is required; add `"typecheck": "tsc -b"`), `rookdex` (`tsconfig.json` and `wrangler.jsonc`, so `typecheck` and `deploy:check` are required; add `"typecheck": "astro check"` and `"deploy:check": "wrangler deploy --dry-run"`), `munin` (no `lint` script; needs Biome as a devDependency, a `biome.json`, and `"lint": "biome ci ."`). Recommendation: the first two go into their caller PRs; `munin` gets Biome too, since installing a package in a repo of yours is yours to approve.
- **D7, the org repos.** `rookdex/rookdex` gets the full rollout like your own repos (its two branch rulesets, 23300025 and 23444906, merge into one). `wendhq/wend` is joint, and the co-owner's recent commits carry a personal address that `identity` would reject and that must never appear in the public caller: the caller PR waits for their agreement and lists their GitHub noreply address, which they set as their commit email first; the ruleset and auto-merge wait too. Until then Ward carries dated `caller` and `ruleset` exceptions for wend (Task 9 Step 3), so the strict audit stays honest for the other sixteen repos. The audit cannot read either org's settings without `AUDIT_TOKEN_ROOKDEX` and `AUDIT_TOKEN_WENDHQ`; without them the exit criterion "zero repos missing the baseline" holds for `malinfossum/*` and the orgs stay a `token` warning. Recommendation: create the rookdex token now (same recipe as Plan 2 Task 9), leave wendhq to the co-owner conversation.
- **D9, the profile repo's bot push (stress test 2026-10-02).** `profile-dashboard` pushes a README refresh straight to `malinfossum/malinfossum`'s `main` twice a day as `github-actions[bot]` with `PROFILE_README_TOKEN`, a token of yours. The template ruleset would reject that push (pull-request and status-check rules apply to pushes too) and the weekly `identity` run would fail on the bot's address. Recommendation: that one repo's ruleset gets the repository-admin bypass (your token acts as you; Ward's tag ruleset uses the same pattern), and its caller lists `41898282+github-actions[bot]@users.noreply.github.com` in `allowed-emails` with a comment. Alternative: change the dashboard to open a PR instead of pushing, which means a PR to merge twice a day.
- **D8, old CI that stays.** `varde/build-test.yml` is a course deliverable and stays; `profile-dashboard/test.yml` is Python and stays until Plan 6; `workbench/ci.yml` tests workbench's own tools and stays; every deploy workflow stays. Everything else that only builds and tests is retired once the ruleset requires `ward / gate` (Task 10).

## Reference facts (verified 2026-10-02)

- Ward unit tests today: 150 (149 pass, 1 skipped live test). Fixture tests: 10. `npm run lint` clean (27 files). `main` is at `ed73ccc`.
- `v1` and `v1.1.0` both dereference to commit `fb2ea870674fa102cf0e0a8b8d8d97a7ba26a521`. `dependabot-automerge.yml` and `tools/automerge.mjs` did not change between `v1.0.0` and `v1.1.0` (`git log v1.0.0..v1.1.0 -- <both>` is empty), so `templates/ward.yml` still pins `2939fee7aac178f0fdbc4ee9505a3e0464314e0c # v1.0.0`.
- Ward's rulesets: branch `main` 24164640 (requires `ward / gate`, `ward-windows / gate`, `fixtures`, code scanning, pull request, no bypass actors); tags `release tags` 24164641 (creation, update, deletion; repository admin bypass). `allow_auto_merge` and `delete_branch_on_merge` are both on for Ward.
- Dependabot has run on Ward (the `Dependabot Updates` workflow, last 2026-09-29 08:08 UTC, Monday) and has never opened a PR there. `@biomejs/biome` 2.5.15 was published 2026-09-30T15:23Z; with the default 3-day cooldown it becomes eligible on 2026-10-03, so the Monday 2026-10-05 run should propose the 2.5.14 to 2.5.15 patch as the `npm-minor-patch` group PR. Dependabot also runs immediately when `.github/dependabot.yml` changes on the default branch, and on demand from Insights, Dependency graph, Dependabot, "Check for updates".
- The audit's last run is a `failure` from 2026-10-01 (workflow_dispatch; the Wend suppression, since fixed by wend #72). Nobody has re-run it. A local warn-mode sweep today shows only `caller`, `ruleset`, `baseline`, `uncovered`, `token` (orgs) and `canary-missing` findings.
- `listRepos` skips forks, private repos and the org `.github` repos, so the sweep covers the 17 repos in the rollout table plus Ward.
- `identity.mjs` treats an all-zero `BASE` (a tag push) as "check the head commit only", so `ci.yml` can run on a `push: tags` event.
- `node-contract.mjs` requires `lint` and `test`; `typecheck` when `tsconfig.json` or `astro.config.*` exists in the node dir; `deploy:check` when `wrangler.toml|json|jsonc` exists; `test:a11y` when `a11y` is not `off`. `npm ci` needs a `package-lock.json`. `dotnet-check.mjs` fails when no project references a test SDK, builds with `-warnaserror`, and runs `dotnet format --verify-no-changes`; what each C# repo does under that is unknown until its PR runs.
- A `pull_request` run uses the workflow files of the PR's merge ref. A PR that deletes the workflow behind a required check never produces that check and cannot merge, which is why the old CI is retired only after the ruleset switches to `ward / gate`.
- Job-level `permissions` in a workflow triggered by a Dependabot PR grant what they say (`contents: write`, `pull-requests: write`), which is what every caller's `automerge` job relies on; Task 7 is the observation that proves it on Ward.
- `/morning` (`~/.claude/skills/morning/SKILL.md`, lines 42 to 44 and 71 to 74) already checks both workflows on Mondays and reads a canary 404 as `canary: not yet (Plan 5)`.
- Stress-test facts (2026-10-02): `fixtures/node-ok` has no `package-lock.json` (only `node-broken` has one), and `ci.yml`'s node job runs `npm ci` with the lock file as the cache key. `malinfossum/malinfossum`'s last 30 commits are mostly `chore(dashboard): refresh [skip ci]` by `github-actions[bot]`, pushed straight to `main` by `profile-dashboard/update-dashboard.yml` at 02:23 and 14:47 UTC daily. `wendhq/wend`'s last 50 commits include the co-owner under a personal address. The current `v1` is an annotated tag object (`git cat-file -t v1` prints `tag`), so a forced tag move hands `github.event.before` an object the checkout cannot fetch. `rookdex/rookdex`'s rulesets endpoint lists 23300025 before 23444906. `devops-course`'s only workflow is `hei.yml`, a `workflow_dispatch` demo. Both orgs allow all actions and I am admin of both. Squash is allowed on every rollout repo; `delete_branch_on_merge` is off on all seventeen. `@biomejs/biome` is in the hygiene checker's notable-tools list, so a repo that adds it must name it in its README.

## The rollout table

Every public, non-fork, non-archived repo of mine except Ward. "Inputs" are the caller's `with:` values; an empty input turns the module off. "Ruleset today" is what the branch rules API answers for `main`. "Settings gaps" are from today's audit (re-run it in Task 10 for the current list).

| Repo | Inputs | Dependabot blocks | Ruleset today | Settings gaps | Old CI to retire (Task 10) | Notes |
|---|---|---|---|---|---|---|
| `malinfossum/backend-course` | none; dotnet by exception | github-actions | 21286170 (deletion, non_fast_forward) | not in today's top of the list; re-run | none | D3, D5 |
| `malinfossum/devops-course` | none; dotnet by exception | github-actions | no rules at all | security updates off; re-run for the rest | `ci.yml` (read it first; it may be empty) | D3, D5; docker is `uncovered` |
| `malinfossum/ember-black` | none; node by exception | github-actions | 21286167 (deletion, non_fast_forward) | none seen | none | D3 |
| `malinfossum/getacademy` | none | github-actions | deletion, non_fast_forward | alerts off, security updates off | none | docs only |
| `malinfossum/hugin` | `node: hugin-web`, `dotnet: Hugin.slnx` | github-actions, npm (`/hugin-web`), nuget | deletion, non_fast_forward | alerts, security updates, CodeQL off | none | add `typecheck` (D6); powershell `uncovered`; has `repo-hygiene.yml` |
| `malinfossum/ignite` | `node: .` | github-actions, npm | 20658923 `protect-main` requires `verify` | none seen | `ci.yml` | `deploy.yml` stays |
| `malinfossum/kenaz` | `node: Kenaz.Web`, `dotnet: Kenaz.slnx` | github-actions, npm (`/Kenaz.Web`), nuget | 21013431 `protect-main` requires `verify` | none seen | `verify.yml` | `deploy.yml` stays |
| `malinfossum/malinfossum` | none | github-actions | deletion, non_fast_forward | alerts, security updates, CodeQL off | none | profile README; has `repo-hygiene.yml` |
| `malinfossum/munin` | `node: .` | github-actions, npm | deletion, non_fast_forward | none seen | none | add Biome + `lint` (D6) |
| `malinfossum/portfolio` | none | github-actions | deletion, non_fast_forward | none seen | none | no package.json |
| `malinfossum/profile-dashboard` | none | already has one | deletion, non_fast_forward | none seen | none (`test.yml` stays, D8) | python `uncovered`; has `repo-hygiene.yml` |
| `malinfossum/spindle` | `node: .` | github-actions, npm | 21286177 `Protect main`: linear history, requires `Commit identity`, no pull-request rule | none seen | `commit-identity.yml` | squash merges only; has `repo-hygiene.yml` |
| `malinfossum/tidsro` | `dotnet: Tidsro.slnx`, `dotnet-os: windows-latest` | github-actions, nuget | deletion, non_fast_forward | none seen | none | WPF; powershell `uncovered` |
| `malinfossum/varde` | `node: web`, `dotnet: api/Varde.slnx` | github-actions, npm (`/web`), nuget (`/api`) | 21061956 `protect-main` requires `api-tests`, `web-tests` | none seen | `ci.yml` | `build-test.yml` and `deploy-web.yml` stay (D8); docker `uncovered`; has `repo-hygiene.yml` |
| `malinfossum/workbench` | none; node and dotnet by exception | github-actions | deletion, non_fast_forward | none seen | none (`ci.yml` stays, D8) | scaffolds get their own callers in Task 11 |
| `rookdex/rookdex` | `node: .` | already has one | 23300025 `Protect main` and 23444906 `protect-main`, requires `web-tests` | unreadable without `AUDIT_TOKEN_ROOKDEX` | `ci.yml` (`web-tests` job; keep `preview` if it deploys) | add `typecheck`, `deploy:check` (D6, D7) |
| `wendhq/wend` | `dotnet: Wend.slnx` | already has one | deletion, non_fast_forward | unreadable without `AUDIT_TOKEN_WENDHQ` | `ci.yml` | joint repo (D7); powershell `uncovered` |

EF inputs: none of the C# repos lists a separate data project in the inventory except varde (`api/Varde.Data`) and the `csharp-api` scaffold (`App.Data`). Varde's caller gets `dotnet-ef-project: api/Varde.Data` and `dotnet-ef-startup-project: api/Varde.Api`; if the pending-migrations step fails for a reason other than a real pending model change, the implementer reports it and the input comes out again.

## File map

| File | Responsibility |
|---|---|
| `tools/watchdog.mjs` + `.test.mjs` | `watch(workflow, token, now)`: the latest completed run of one of Ward's workflows is fresh; CLI fails the job otherwise |
| `tools/repo-audit.mjs` + `.test.mjs` | `lastRunProblem` (shared by audit and watchdog), `checkCanary` without the "not yet" warning, `exceptionsFor` + `checkInputs` with exceptions, `exception` warning kind |
| `stacks.json` + `tools/stacks.test.mjs` | `exceptions` map, dated reasons |
| `.github/workflows/canary.yml` | Weekly and post-release run of the published `@v1` plus the audit watchdog |
| `.github/workflows/ward.yml` | Ward's own `automerge` job at the `v1.1.0` commit |
| `templates/ward.yml` | Auto-merge pin moves to `v1.1.0`, then to `v1.2.0` in Task 12 |
| `tools/workflows.test.mjs`, `tools/templates.test.mjs` | Canary shape, gate red path, Ward's auto-merge job |
| `.github/workflows/repo-audit.yml` | Loses `--warn-kinds` (Task 12) |
| `docs/repo-audit.md`, `README.md`, `package.json`, spec | Watchdogs, `exception` kind, canary, version 1.2.0, Plan 5 deviations |
| 17 consumer repos: `.github/workflows/ward.yml`, `.github/dependabot.yml`, script fixes | One PR each, Malin merges |
| workbench: 6 scaffold callers | One PR |
| `~/.claude/skills/morning/SKILL.md` | The canary 404 becomes a `**Fix**` line (gated) |

---

### Task 1: The watchdog script, and the canary becomes a hard finding

**Files:**
- Create: `tools/watchdog.mjs`, `tools/watchdog.test.mjs`
- Modify: `tools/repo-audit.mjs` (lines 22 to 25 `WARN_KINDS`, lines 354 to 373 `checkCanary`), `tools/repo-audit.test.mjs` (lines 440 to 458, 514 to 531, and the two `runAudit` tests that stub `/canary.yml/runs` with 404 at lines 821 and 861)
- Docs: `docs/repo-audit.md` (the "Warnings" paragraph and "The watchdogs" section)

**Interfaces:**
- Consumes: `request(path, token)` and `WARD` from `tools/repo-audit.mjs` (existing; `request` returns `{ status, body }`, body `null` on 401/403/404, throws on other 4xx/5xx).
- Produces: `lastRunProblem(workflow: string, runs: object | null, now: ISO string, { requireSuccess = true }) → string | null` exported from `repo-audit.mjs`; `watch(workflow, token, now = new Date().toISOString()) → Promise<string | null>` exported from `watchdog.mjs`; CLI `node tools/watchdog.mjs <workflow file>` with env `GITHUB_TOKEN`, exit 1 on a problem. `WARN_KINDS` becomes `new Set(["uncovered", "token"])` (Task 3 adds `exception`). Task 2's canary runs the CLI.

- [ ] **Step 1: Branch**

```bash
git switch main && git pull --ff-only && git switch -c feat/rollout
```

- [ ] **Step 2: Write the failing tests for `lastRunProblem` and the hard canary finding**

In `tools/repo-audit.test.mjs`, add `lastRunProblem` to the import list from `./repo-audit.mjs`, then replace the test `"a red, stale or never-run canary is a finding; a missing canary is only a warning"` (lines 440 to 458) with:

```js
test("a red, stale, never-run or missing canary is a hard finding", () => {
  const red = {
    workflow_runs: [{ conclusion: "failure", updated_at: "2026-09-29T06:00:00Z", html_url: "u" }],
  };
  assert.match(checkCanary(red, "2026-09-30T08:00:00Z")[0][1], /ended failure: u/);
  const stale = {
    workflow_runs: [{ conclusion: "success", updated_at: "2026-09-20T06:00:00Z", html_url: "u" }],
  };
  assert.match(checkCanary(stale, "2026-09-30T08:00:00Z")[0][1], /10 days old/);
  assert.match(
    checkCanary({ total_count: 0, workflow_runs: [] }, "2026-09-30T08:00:00Z")[0][1],
    /never completed/,
  );
  // Since Plan 5 the canary exists: a 404 is a deleted or renamed canary.
  const missing = checkCanary(null, "2026-09-30T08:00:00Z");
  assert.deepEqual(kinds(missing), ["canary"]);
  assert.match(missing[0][1], /No canary\.yml in malinfossum\/ward/);
  assert.ok(!WARN_KINDS.has("canary-missing"));
  for (const findings of [missing, checkCanary(red, "x"), checkCanary(stale, "2026-09-30T08:00:00Z")]) {
    assert.ok(!WARN_KINDS.has(findings[0][0]));
  }
});

test("lastRunProblem: liveness only when requireSuccess is off; a bad date is never fresh", () => {
  const fresh = { conclusion: "failure", updated_at: "2026-09-29T06:00:00Z", html_url: "u" };
  const runs = { workflow_runs: [fresh] };
  assert.match(lastRunProblem("repo-audit.yml", runs, "2026-09-30T08:00:00Z"), /ended failure/);
  assert.equal(
    lastRunProblem("repo-audit.yml", runs, "2026-09-30T08:00:00Z", { requireSuccess: false }),
    null,
  );
  const old = { workflow_runs: [{ ...fresh, conclusion: "success", updated_at: "2026-09-21T06:00:00Z" }] };
  assert.match(
    lastRunProblem("repo-audit.yml", old, "2026-09-30T08:00:00Z", { requireSuccess: false }),
    /repo-audit\.yml run is 9 days old/,
  );
  assert.match(lastRunProblem("x.yml", null, "2026-09-30T08:00:00Z"), /never completed/);
  assert.match(
    lastRunProblem("x.yml", { workflow_runs: [{ ...fresh, conclusion: "success" }] }, "x"),
    /days old/,
  );
});
```

In the test `"canaryFindings: only a 404 means no canary; 401 and 403 are a token finding"` (line 514) change the first assertion to `assert.deepEqual(kinds(canaryFindings(404, null, NOW)), ["canary"]);` and in `"a canary that cannot be read fails the run on my own repo"` change the last line to `assert.equal(hardCount(canaryFindings(404, null, NOW), own), 1);`.

In the two `runAudit` tests that stub `[/\/canary\.yml\/runs/, 404]` (the archived-500 test near line 821 and the org-without-token test near line 861), replace the stub line with a healthy run so the assertions on `result.failures` and the token lines keep their meaning:

```js
    [
      /\/canary\.yml\/runs/,
      200,
      {
        workflow_runs: [
          { conclusion: "success", updated_at: new Date().toISOString(), html_url: "u" },
        ],
      },
    ],
```

`runAudit` reads the clock with `new Date()`, so the stub must too: a fixed date here would turn into a stale-canary failure eight days later and make every Ward PR red (stress test 2026-10-02).

- [ ] **Step 3: Run the audit tests to see them fail**

Run: `node --test tools/repo-audit.test.mjs`
Expected: FAIL. `lastRunProblem` is not exported; `checkCanary(null)` still returns `canary-missing`.

- [ ] **Step 4: Implement `lastRunProblem` and the new `checkCanary`**

In `tools/repo-audit.mjs`, change `WARN_KINDS` and its comment (lines 22 to 25) to:

```js
// Findings of these kinds are reported but never fail the run. canary-missing
// left this set with Plan 5: a 404 for canary.yml is a deleted or renamed
// canary now, and fails like a red one.
export const WARN_KINDS = new Set(["uncovered", "token"]);
```

Replace `checkCanary` (lines 354 to 373) with:

```js
// What is wrong with the latest completed run of one of Ward's own workflows:
// never ran, ended red, or older than MAX_AGE_DAYS, which is what a schedule
// GitHub turned off looks like. runs is the workflow-runs response for
// per_page=1&status=completed. requireSuccess false checks liveness only: the
// canary asks this about the audit, and a red audit has already failed and
// emailed on its own, so reporting it twice would only add a red canary. A
// date that does not parse reads as stale, never as fresh.
export function lastRunProblem(workflow, runs, now, { requireSuccess = true } = {}) {
  const run = runs?.workflow_runs?.[0];
  if (!run) return `${workflow} has never completed a run.`;
  if (requireSuccess && run.conclusion !== "success") {
    return `The latest ${workflow} run ended ${run.conclusion}: ${run.html_url}`;
  }
  const days = Math.floor((Date.parse(now) - Date.parse(run.updated_at)) / DAY);
  if (!(days <= MAX_AGE_DAYS)) {
    return `The latest ${workflow} run is ${days} days old (${run.updated_at}); GitHub may have disabled the schedule.`;
  }
  return null;
}

// runs: null when the API answers 404 for canary.yml, else the workflow-runs
// response for the latest completed run. A missing canary fails like a red
// one: it exists since Plan 5, so a 404 means it was deleted or renamed.
export function checkCanary(runs, now) {
  if (runs === null) return [["canary", `No ${CANARY} in ${WARD}.`]];
  const problem = lastRunProblem(CANARY, runs, now);
  return problem ? [["canary", problem]] : [];
}
```

`DAY`, `MAX_AGE_DAYS`, `CANARY` and `WARD` already exist in the file. Update the comment above `canaryFindings` (line 505) to drop "when canary.yml does not exist yet": `// The canary runs endpoint answers 404 when canary.yml is gone, and 401 or 403 when the token cannot read it. Only the 404 means "no canary": a token that cannot read must never look like a missing workflow.`

- [ ] **Step 5: Run the audit tests**

Run: `node --test tools/repo-audit.test.mjs`
Expected: PASS (previous count in this file + 1).

- [ ] **Step 6: Write the failing watchdog tests**

Create `tools/watchdog.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { watch } from "./watchdog.mjs";

const NOW = "2026-10-05T07:00:00Z";

// Replaces fetch for one test; node:test restores it when the test ends.
function answer(t, status, body) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? "" });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const run = (conclusion, updated_at) => ({
  workflow_runs: [{ conclusion, updated_at, html_url: "https://github.com/x/runs/1" }],
});

test("a fresh run passes, whatever its conclusion: the watchdog checks liveness, not results", async (t) => {
  const calls = answer(t, 200, run("failure", "2026-10-04T06:20:00Z"));
  assert.equal(await watch("repo-audit.yml", "tok", NOW), null);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].url,
    /\/repos\/malinfossum\/ward\/actions\/workflows\/repo-audit\.yml\/runs\?per_page=1&status=completed$/,
  );
  assert.equal(calls[0].auth, "Bearer tok");
});

test("a run older than 8 days, or none ever, is a problem", async (t) => {
  answer(t, 200, run("success", "2026-09-26T06:20:00Z"));
  assert.match(await watch("repo-audit.yml", "", NOW), /repo-audit\.yml run is 9 days old/);
  answer(t, 200, { total_count: 0, workflow_runs: [] });
  assert.match(await watch("repo-audit.yml", "", NOW), /never completed/);
});

test("a missing workflow and an unreadable one are problems, and a 5xx throws", async (t) => {
  answer(t, 404);
  assert.match(await watch("repo-audit.yml", "", NOW), /does not exist in malinfossum\/ward/);
  answer(t, 403);
  assert.match(await watch("repo-audit.yml", "", NOW), /Cannot read repo-audit\.yml runs .*HTTP 403/);
  answer(t, 503);
  await assert.rejects(() => watch("repo-audit.yml", "", NOW), /GitHub API 503/);
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `node --test tools/watchdog.test.mjs`
Expected: FAIL with "Cannot find module './watchdog.mjs'".

- [ ] **Step 8: Write `tools/watchdog.mjs`**

```js
// Fails when one of Ward's own scheduled workflows has gone quiet: no
// completed run within MAX_AGE_DAYS, or none ever. GitHub turns a schedule
// off after 60 days without activity, silently. The canary runs this against
// the audit, the audit checks the canary through checkCanary, and my Monday
// briefing checks both from outside GitHub. Liveness only: a red run has
// already failed and emailed on its own.
import { pathToFileURL } from "node:url";
import { lastRunProblem, request, WARD } from "./repo-audit.mjs";

// The problem with the latest completed run of `workflow`, or null.
export async function watch(workflow, token, now = new Date().toISOString()) {
  const { status, body } = await request(
    `/repos/${WARD}/actions/workflows/${workflow}/runs?per_page=1&status=completed`,
    token,
  );
  if (status === 404) return `${workflow} does not exist in ${WARD}.`;
  if (status !== 200) return `Cannot read ${workflow} runs on ${WARD} (HTTP ${status}).`;
  return lastRunProblem(workflow, body, now, { requireSuccess: false });
}

async function main(argv) {
  const workflow = argv[0];
  if (!workflow) throw new Error("usage: node tools/watchdog.mjs <workflow file>");
  const problem = await watch(workflow, process.env.GITHUB_TOKEN || "");
  if (problem) {
    console.log(`::error::${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${workflow}: the latest completed run is fresh.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
```

`request` is already exported from `repo-audit.mjs` (line 431). `lastRunProblem` was exported in Step 4.

- [ ] **Step 9: Run every test and the linter**

Run: `npm test && npm run lint`
Expected: unit tests 150 + 4 (3 watchdog, 1 `lastRunProblem`), 1 skipped as before; lint clean. Then one live check: `GITHUB_TOKEN=$(gh auth token) node tools/watchdog.mjs repo-audit.yml` prints `repo-audit.yml: the latest completed run is fresh.` (the 2026-10-01 run is red but within 8 days), and `node tools/watchdog.mjs canary.yml` prints `::error::canary.yml does not exist in malinfossum/ward.` and exits 1.

- [ ] **Step 10: Docs**

In `docs/repo-audit.md`: in the "Warnings, which never fail the run" paragraph delete `canary-missing` (`no canary.yml until Plan 5`) from the list. Replace the "The watchdogs" section with:

```markdown
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
```

- [ ] **Step 11: Commit**

```bash
git add tools/watchdog.mjs tools/watchdog.test.mjs tools/repo-audit.mjs tools/repo-audit.test.mjs docs/repo-audit.md
git commit -m "Add the watchdog script and make a missing canary a hard audit finding"
```

---

### Task 2: The canary workflow

**Files:**
- Create: `.github/workflows/canary.yml`
- Modify: `tools/workflows.test.mjs` (append two tests), `README.md` (the audit paragraph and the Layout table)

**Interfaces:**
- Consumes: `node tools/watchdog.mjs repo-audit.yml` (Task 1); `malinfossum/ward/.github/workflows/ci.yml@v1` with the inputs `node` and `dotnet`; `npm run test:fixtures` as it exists at the `v1` tag.
- Produces: the workflow file the audit's `checkCanary` reads runs of (`CANARY = "canary.yml"`), with jobs `published`, `rejects`, `watchdog`; `fixtures/node-ok/package-lock.json`.

- [ ] **Step 1: Write the failing workflow tests**

Append to `tools/workflows.test.mjs`:

```js
test("the canary calls the published @v1 for the good fixtures and the v1 tag's fixture suite for the broken ones", () => {
  const text = readWorkflow(".github/workflows/canary.yml");
  assert.match(text, /^ {4}uses: malinfossum\/ward\/\.github\/workflows\/ci\.yml@v1$/m);
  assert.doesNotMatch(text, /uses: \.\/\.github\/workflows\//, "the canary must test the tag, not this checkout");
  assert.match(text, /node: fixtures\/node-ok/);
  assert.match(text, /dotnet: fixtures\/dotnet-ok/);
  assert.match(text, /^ {10}ref: v1$/m);
  assert.match(text, /npm run test:fixtures/);
  assert.match(text, /node tools\/watchdog\.mjs repo-audit\.yml/);
  const on = text.match(/^on:\r?\n((?: {2}.*\r?\n?)+)/m)?.[1] ?? "";
  for (const trigger of ["schedule", "release", "workflow_dispatch"]) {
    assert.match(on, new RegExp(`^ {2}${trigger}:`, "m"), trigger);
  }
  assert.match(on, /types: \[published\]/);
  // A tag push would hand identity the old tag object as `before`, which the
  // checkout cannot fetch once v1 has moved; a release has no `before`.
  assert.doesNotMatch(on, /pull_request|push:/);
});

// ci.yml's node job runs `npm ci` and caches on <dir>/package-lock.json, so a
// fixture named as a `node:` input without a lock file fails before any check runs.
test("every node fixture a Ward caller names has a package-lock.json", () => {
  let checked = 0;
  for (const file of [".github/workflows/canary.yml", ".github/workflows/ward.yml"]) {
    for (const match of readWorkflow(file).matchAll(/^\s+node: (fixtures\/\S+)$/gm)) {
      checked++;
      assert.ok(existsSync(join(match[1], "package-lock.json")), `${file}: ${match[1]} has no lock file`);
    }
  }
  assert.ok(checked > 0, "no fixture node input found");
});

test("the gate fails on a failed or cancelled module and lets a skipped one through", () => {
  const gate = jobsOf(".github/workflows/ci.yml").find((job) => job.name === "gate");
  assert.ok(gate, "no gate job in ci.yml");
  assert.match(gate.body, /needs: \[identity, node, dotnet\]/);
  assert.match(gate.body, /if: always\(\)/);
  assert.match(
    gate.body,
    /contains\(needs\.\*\.result, 'failure'\) \|\| contains\(needs\.\*\.result, 'cancelled'\)/,
  );
  assert.doesNotMatch(gate.body, /'skipped'/);
});
```

Add `existsSync` to the `node:fs` import at the top of the file (`join` is already imported).

- [ ] **Step 2: Run it to see them fail**

Run: `node --test tools/workflows.test.mjs`
Expected: the canary test FAILS with ENOENT on `canary.yml`; the lock-file test FAILS because `ward.yml` names no fixture node input yet and `canary.yml` is missing; the gate test passes already (it pins existing behaviour).

- [ ] **Step 3: Give `fixtures/node-ok` a lock file**

```bash
(cd fixtures/node-ok && npm install --package-lock-only --ignore-scripts)
git status --short fixtures/node-ok
```
Expected: one new file, `fixtures/node-ok/package-lock.json`, and no `node_modules`. The fixture suite never needed it because `tests/fixtures.test.mjs` runs `node-contract.mjs` directly, but `ci.yml`'s node job runs `npm ci` first (stress test 2026-10-02).

- [ ] **Step 4: Write `.github/workflows/canary.yml`**

```yaml
# Runs the published @v1 the way every other repo does: ci.yml@v1 against the
# good fixtures, and the v1 tag's own fixture suite, which rejects the broken
# ones. A reusable-workflow job cannot be marked expected-to-fail, and a canary
# that is red by design every Monday would train me to ignore it, so the
# broken fixtures go through the published scripts rather than the published
# gate. Weekly, and on every published release, which I create after moving
# v1, so a release that breaks consumers shows up before Monday. The watchdog
# job fails when the weekly audit has gone quiet; the audit checks this
# workflow the same way.
name: Canary

on:
  schedule:
    - cron: "47 6 * * 1"
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: read

env:
  DOTNET_CLI_TELEMETRY_OPTOUT: "1"
  ASTRO_TELEMETRY_DISABLED: "1"
  WRANGLER_SEND_METRICS: "false"

jobs:
  # Exactly a consumer's call: the published tag, never this checkout.
  published:
    uses: malinfossum/ward/.github/workflows/ci.yml@v1
    with:
      node: fixtures/node-ok
      dotnet: fixtures/dotnet-ok

  rejects:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: v1
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
          cache: npm
      - uses: actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6.0.0
        with:
          dotnet-version: 10.0.x
      - run: npm ci
      - name: The published scripts reject the broken fixtures
        run: npm run test:fixtures

  watchdog:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      actions: read
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
      - name: The weekly audit completed a run within 8 days
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: node tools/watchdog.mjs repo-audit.yml
```

The cron sits 30 minutes after the audit's `17 6 * * 1`, so on a Monday the watchdog sees that morning's audit run. `${{ github.token }}` is not a secret read (`secrets.`), so the existing "a workflow that reads a secret runs only on a schedule or by hand" test still counts one workflow. The watchdog job asks for `actions: read` explicitly: the runs endpoint answers for a public repo without it, but the job must not depend on that.

- [ ] **Step 5: Run every test**

Run: `npm test && npm run lint`
Expected: unit tests Task 1's total + 3; lint clean. The existing guards pass on the new file: every action SHA-pinned, `contents: read` at the top, 30 and 10 minute timeouts, telemetry off, no `pull_request_target`, no `./` call to the auto-merge workflow, and `canary.yml` is not a reusable workflow so the "fetches Ward's tools at its own commit" count stays 3.

- [ ] **Step 6: README**

In `README.md`, extend the paragraph that starts "Two more checks live outside `ci.yml`" with one sentence at the end: `[`canary.yml`](.github/workflows/canary.yml) runs the published `@v1` every Monday and after every release, as a consumer would, and watches that the audit keeps running.` In the Layout table, change the `.github/workflows/` row to: `` `ci.yml` (entry point), `dependabot-automerge.yml`, `repo-hygiene.yml`, the weekly `repo-audit.yml` and `canary.yml`, Ward's own `ward.yml` `` and the `tools/` row to `` The scripts each job runs, `watchdog.mjs`, and their unit tests ``.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/canary.yml fixtures/node-ok/package-lock.json tools/workflows.test.mjs README.md
git commit -m "Add the canary that runs the published v1 weekly and after every release"
```

---

### Task 3: Audit exceptions for modules that stay off on purpose

**Files:**
- Modify: `stacks.json` (`$comment`, new `exceptions` map), `tools/repo-audit.mjs` (`WARN_KINDS`, `checkInputs` lines 105 to 150, `auditRepo` line 379, `fetchRepoData` return at line 497), `tools/repo-audit.test.mjs`, `tools/stacks.test.mjs`, `docs/repo-audit.md`

**Interfaces:**
- Consumes: `detectStacks(paths, stacks)` output (`{ name, input, status, files }[]`), `stacks.json` as loaded by `loadStacks()`.
- Produces: `exceptionsFor(repo: string, stacks) → Record<module, reason>` (case-insensitive on the repo name, `{}` when none); `checkInputs(inputs, detected, paths, exceptions = {})`; `fetchRepoData` returns `repo: meta.full_name` alongside `self`; `auditRepo` reads `data.repo` and passes `exceptionsFor(data.repo, stacks)` on; new warning kind `exception`. The caller generator in Task 8 writes `""` for an excepted module.

- [ ] **Step 1: Write the failing tests**

In `tools/repo-audit.test.mjs`, add `exceptionsFor` to the import list and append:

```js
const STACKS_WITH_EXCEPTIONS = {
  ...stacks,
  exceptions: {
    "malinfossum/Backend-Course": { dotnet: "Course repo, one solution per week (2026-10-02)." },
  },
};

test("exceptionsFor matches the repo name case-insensitively and is empty otherwise", () => {
  assert.deepEqual(exceptionsFor("malinfossum/backend-course", STACKS_WITH_EXCEPTIONS), {
    dotnet: "Course repo, one solution per week (2026-10-02).",
  });
  assert.deepEqual(exceptionsFor("malinfossum/other", STACKS_WITH_EXCEPTIONS), {});
  assert.deepEqual(exceptionsFor("malinfossum/backend-course", { ...stacks, exceptions: {} }), {});
});

test("an exception can also defer a caller, ruleset or baseline finding on a joint repo", () => {
  const paths = ["Wend.slnx"];
  const deferred = {
    ...stacks,
    exceptions: { "wendhq/wend": { ruleset: "Waiting for the co-owner (2026-10-02)." } },
  };
  const { findings } = auditRepo(
    { repo: "wendhq/wend", tree: paths, caller: null, files: {}, baseline: { ...baseline, rules: [] }, self: false },
    { stacks: deferred, today: "2026-10-02" },
  );
  assert.ok(!findings.some(([kind]) => kind === "ruleset"), "ruleset findings are deferred");
  assert.ok(findings.some(([kind, msg]) => kind === "exception" && /ruleset .*deferred/.test(msg)));
  assert.ok(findings.some(([kind]) => kind === "caller"), "an undeferred kind still fails");
});

test("an excepted module that is off is a warning naming the reason, never an inputs finding", () => {
  const paths = ["Week 01/A.slnx", "Week 02/B.slnx"];
  const detected = detectStacks(paths, stacks);
  const exceptions = { dotnet: "Course repo, one solution per week (2026-10-02)." };
  const findings = checkInputs({ node: "", dotnet: "" }, detected, paths, exceptions);
  assert.deepEqual(kinds(findings), ["exception"]);
  assert.match(findings[0][1], /dotnet is off by exception: Course repo/);
  assert.ok(WARN_KINDS.has("exception"));
  // Without the exception the same caller is an inputs failure.
  assert.deepEqual(kinds(checkInputs({ node: "", dotnet: "" }, detected, paths)), ["inputs"]);
});

test("a stale exception is reported: no files for that module, or the input is set anyway", () => {
  const exceptions = { dotnet: "Gone (2026-10-02)." };
  const none = checkInputs({ node: "." }, detectStacks(["package.json"], stacks), ["package.json"], exceptions);
  assert.deepEqual(kinds(none), ["exception"]);
  assert.match(none[0][1], /stale exception for dotnet/);
  const paths = ["A.slnx"];
  const on = checkInputs({ dotnet: "A.slnx" }, detectStacks(paths, stacks), paths, exceptions);
  assert.deepEqual(kinds(on), ["exception"]);
  assert.match(on[0][1], /stale exception for dotnet/);
});

test("auditRepo passes the repo's exceptions through", () => {
  const paths = ["Week 01/A.slnx"];
  const caller = [
    "jobs:",
    "  ward:",
    "    uses: malinfossum/ward/.github/workflows/ci.yml@v1",
    "    with:",
    '      dotnet: ""',
  ].join("\n");
  const { findings } = auditRepo(
    { repo: "malinfossum/backend-course", tree: paths, caller, files: {}, baseline: baseline, self: false },
    { stacks: STACKS_WITH_EXCEPTIONS, today: "2026-10-02" },
  );
  assert.ok(findings.some(([kind]) => kind === "exception"));
  assert.ok(!findings.some(([kind]) => kind === "inputs"));
});
```

`baseline` is the healthy baseline fixture object the file already uses in its `checkBaseline` tests (a passing `{ securityUpdates, alerts, analysis, codeScanning, rules }`); reuse its name. In `tools/stacks.test.mjs` append:

```js
test("every exception names a public repo of mine, a shipped module, and a dated reason", () => {
  const stacks = loadStacks();
  const shipped = new Set(stacks.modules.filter((m) => m.status === "shipped").map((m) => m.name));
  const entries = Object.entries(stacks.exceptions ?? {});
  assert.ok(entries.length >= 1);
  for (const [repo, modules] of entries) {
    assert.match(repo, /^(malinfossum|rookdex|wendhq)\/[\w.-]+$/, repo);
    for (const [key, reason] of Object.entries(modules)) {
      assert.ok(
        shipped.has(key) || ["caller", "ruleset", "baseline"].includes(key),
        `${repo}: ${key} is neither a shipped module nor a deferrable finding kind`,
      );
      assert.match(reason, /\(\d{4}-\d{2}-\d{2}\)\.$/, `${repo}/${key}: the reason ends with a date`);
    }
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tools/repo-audit.test.mjs tools/stacks.test.mjs`
Expected: FAIL. `exceptionsFor` is not exported; `checkInputs` ignores the fourth argument; `stacks.json` has no `exceptions`.

- [ ] **Step 3: `stacks.json`**

Add to the `$comment`: ` exceptions: repos where a detected shipped module stays off on purpose, keyed by full repo name, with a reason ending in a date in parentheses; the audit reports each one as an exception warning every week so none outlives its reason, and reports a stale one (no files, or the input is set) the same way. A key may also be a finding kind (caller, ruleset, baseline) to defer that kind on a joint repo whose co-owner has not agreed yet.` Add after `"ignore"`:

```json
  "exceptions": {
    "malinfossum/backend-course": {
      "dotnet": "Course repo with one solution per week and no single entry point (2026-10-02)."
    },
    "malinfossum/devops-course": {
      "dotnet": "Course repo; the one project has no tests (2026-10-02)."
    },
    "malinfossum/workbench": {
      "node": "Scaffold copies; workbench's own ci.yml tests the tools (2026-10-02).",
      "dotnet": "Scaffold copies; workbench's own ci.yml tests the tools (2026-10-02)."
    },
    "malinfossum/ember-black": {
      "node": "A VS Code theme: a build script and nothing to lint or test (2026-10-02)."
    }
  },
```

- [ ] **Step 4: `repo-audit.mjs`**

`WARN_KINDS` becomes `new Set(["uncovered", "exception", "token"])` and its comment gains: `exception: a module I turned off on purpose, listed in stacks.json with a dated reason.`

Add below `WARN_KINDS`:

```js
// The modules a repo keeps off on purpose, from stacks.json. Repo names on
// GitHub are case-insensitive, so the lookup is too.
export function exceptionsFor(repo, stacks) {
  const wanted = repo.toLowerCase();
  const hit = Object.entries(stacks.exceptions ?? {}).find(([name]) => name.toLowerCase() === wanted);
  return hit ? hit[1] : {};
}
```

Change `checkInputs` to take `exceptions = {}` and report them. The first loop becomes:

```js
export function checkInputs(inputs, detected, paths, exceptions = {}) {
  const findings = [];
  const seen = new Set();
  for (const stack of detected) {
    if (stack.status !== "shipped") {
      findings.push([
        "uncovered",
        `${stack.name} files (${sample(stack.files)}) but no Ward module covers them yet.`,
      ]);
      continue;
    }
    seen.add(stack.name);
    const reason = exceptions[stack.name];
    const off = inputs && !(inputs[stack.input] ?? "");
    if (off && reason) {
      findings.push(["exception", `${stack.name} is off by exception: ${reason}`]);
    } else if (off) {
      findings.push([
        "inputs",
        `${stack.name} files (${sample(stack.files)}) but the caller's ${stack.input} input is empty.`,
      ]);
    } else if (reason && inputs) {
      findings.push([
        "exception",
        `A stale exception for ${stack.name}: the caller's ${stack.input} input is set; remove it from stacks.json.`,
      ]);
    }
  }
  for (const [module, reason] of Object.entries(exceptions)) {
    if (!seen.has(module)) {
      findings.push([
        "exception",
        `A stale exception for ${module}: no ${module} files are on the default branch (${reason}); remove it from stacks.json.`,
      ]);
    }
  }
  if (!inputs) return findings;
  // ... the rest of the function (the node and dotnet path checks) is unchanged
```

In `auditRepo`, change the signature to `export function auditRepo({ repo = "", tree, caller, files, baseline, self }, { stacks, today })`, compute `const exceptions = exceptionsFor(repo, stacks);` first, pass it as the fourth argument of `checkInputs`, and before returning map the deferred kinds:

```js
  // A joint repo can defer a whole kind until the co-owner agrees; the
  // weekly warning keeps it visible and dated.
  const deferred = findings.map(([kind, message]) =>
    ["caller", "ruleset", "baseline"].includes(kind) && exceptions[kind]
      ? ["exception", `${kind} finding deferred by exception: ${message} (${exceptions[kind]})`]
      : [kind, message],
  );
  return { findings: deferred, suppressions };
```

(`suppressions` is whatever name the existing return uses.) In `fetchRepoData`'s return object add `repo,` (the local `const repo = meta.full_name` already exists). Update the comment above `auditRepo` with `repo: full name, for the exception lookup;`.

- [ ] **Step 5: Run every test and the linter**

Run: `npm test && npm run lint`
Expected: unit tests Task 2's total + 6; lint clean. Then the live sweep, warn mode, to see the four exceptions reported and no `inputs` finding appear on those repos once they carry a caller (today they have none, so only the `exception` lines for stale-or-not are absent; the point is the run still completes):

```bash
GITHUB_TOKEN=$(gh auth token) WARD_AUDIT_TOKEN=$(gh auth token) node tools/repo-audit.mjs --owner malinfossum --mode warn 2>&1 | grep -c "::warning::"
```
Expected: a count, exit 0, and the `malinfossum/ward canary` section now shows `canary` instead of `canary-missing` (hard, so in strict mode this sweep is red until Task 6 runs the canary; that is intended).

- [ ] **Step 6: Docs**

In `docs/repo-audit.md`'s kinds table add a row: `` | `exception` | Warning: a module the repo keeps off on purpose, listed in `stacks.json` under `exceptions` with a dated reason; also a stale exception (no files for that module, or the input is set), and a `caller`, `ruleset` or `baseline` finding deferred on a joint repo | ``. In the "Warnings, which never fail the run" paragraph add `exception` to the list.

- [ ] **Step 7: Commit**

```bash
git add stacks.json tools/repo-audit.mjs tools/repo-audit.test.mjs tools/stacks.test.mjs docs/repo-audit.md
git commit -m "Let the audit carry dated exceptions for modules a repo keeps off on purpose"
```

---

### Task 4: Ward's own auto-merge job at the released SHA

**Files:**
- Modify: `.github/workflows/ward.yml` (header comment, new job), `templates/ward.yml` (the pin), `tools/workflows.test.mjs` (append one test)

**Interfaces:**
- Consumes: `malinfossum/ward/.github/workflows/dependabot-automerge.yml` at commit `fb2ea870674fa102cf0e0a8b8d8d97a7ba26a521` (`v1.1.0`), input `required-check` default `ward / gate`.
- Produces: the `automerge` job every Dependabot PR on Ward runs; Task 7 observes it.

- [ ] **Step 1: Write the failing test**

Append to `tools/workflows.test.mjs`:

```js
test("Ward's own auto-merge job pins a released commit and runs only for Dependabot PRs", () => {
  const job = jobsOf(".github/workflows/ward.yml").find((j) => j.name === "automerge");
  assert.ok(job, "no automerge job in ward.yml");
  assert.match(
    job.body,
    /^ {4}uses: malinfossum\/ward\/\.github\/workflows\/dependabot-automerge\.yml@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m,
  );
  assert.match(
    job.body,
    /^ {4}if: github\.event_name == 'pull_request' && github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'$/m,
  );
  assert.match(job.body, /^ {6}contents: write$/m);
  assert.match(job.body, /^ {6}pull-requests: write$/m);
  // Not asserted: that the template pins the same release. Dependabot bumps
  // ward.yml alone, and that PR must stay green so I can merge it.
});

test("no template carries an em dash", () => {
  for (const file of readdirSync("templates")) {
    const emDash = new RegExp(String.fromCharCode(0x2014));
    assert.doesNotMatch(readFileSync(join("templates", file), "utf8"), emDash, file);
  }
});
```

`readdirSync` and `readFileSync` are already imported in this file.

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tools/workflows.test.mjs`
Expected: FAIL with "no automerge job in ward.yml".

- [ ] **Step 3: Edit `ward.yml` and the template**

Replace the header comment of `.github/workflows/ward.yml` with:

```yaml
# Ward checks itself with its own entry point, on Linux and on Windows, plus the
# fixture suite. The auto-merge job calls a released commit, never ./: a pull
# request could otherwise change the code that runs with write access before
# I review it. Dependabot proposes the bump to each new release, and the job
# refuses to merge that bump itself.
```

Append the job at the end of the file:

```yaml
  automerge:
    if: github.event_name == 'pull_request' && github.event.pull_request.user.login == 'dependabot[bot]'
    permissions:
      contents: write
      pull-requests: write
    uses: malinfossum/ward/.github/workflows/dependabot-automerge.yml@fb2ea870674fa102cf0e0a8b8d8d97a7ba26a521 # v1.1.0
```

In `templates/ward.yml` change the last line to the same `uses:` line (`fb2ea870674fa102cf0e0a8b8d8d97a7ba26a521 # v1.1.0`), keeping its two-space job indentation, and change line 1, which opens with `# Ward` followed by an em dash, to `# Ward: shared CI, security and accessibility checks.` (the generator copies it into 23 repos).

- [ ] **Step 4: Run every test and the linter**

Run: `npm test && npm run lint`
Expected: unit tests Task 3's total + 2; lint clean. The templates test "the caller template uses ci.yml@v1, a SHA-pinned auto-merge and a weekly run" still passes.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ward.yml templates/ward.yml tools/workflows.test.mjs
git commit -m "Give Ward its own auto-merge job at the v1.1.0 commit"
```

---

### Task 5: Docs, version 1.2.0, spec deviations, and the PR

**Files:**
- Modify: `package.json` + `package-lock.json` (version), `docs/specs/2026-09-25-ci-standard-design.md` (Architecture tree, a Plan 5 deviations paragraph, Testing Ward itself), `docs/repo-audit.md` (the `--warn-kinds` sentence), `README.md` if Task 2 left anything out

- [ ] **Step 1: Version**

```bash
npm version 1.2.0 --no-git-tag-version
```
Expected: `package.json` and `package-lock.json` both say `1.2.0`.

- [ ] **Step 2: Spec**

In the Architecture tree, the `tools/` line gains `watchdog.mjs` after `repo-audit additions`. After the "Deviations recorded 2026-09-30 (Plan 2)" paragraph add:

```markdown
**Deviations recorded 2026-10-02 (Plan 5):** the canary's broken half does not go through
`ci.yml@v1`: a reusable-workflow job cannot be marked expected-to-fail, and a canary that is red
by design every Monday would train me to ignore it, so the broken fixtures run through the
published tag's scripts and fixture suite (`actions/checkout` at `ref: v1`, then the fixture
tests), while the good fixtures go through `ci.yml@v1` exactly as a consumer. The gate's red
path is pinned by a unit test on `ci.yml` and was proven end to end by the Plan 1 red-gate PR.
The watchdogs are not symmetric: the audit fails when the canary is red or stale, the canary
fails only when the audit is stale or has never run, because a red audit already fails and emails
on its own and a conclusion check both ways deadlocks on the first run. A repo can keep a detected
module off on purpose through a dated `exceptions` entry in `stacks.json`, reported weekly as a
warning; course repos, the scaffold copies in workbench and the ember-black theme use it. The
hygiene check keeps its own caller file: folding it into `ward.yml` would make a README nit block
every merge. `a11y` stays `off` in every caller until Plan 4 ships `test:a11y`.
```

In "Testing Ward itself", amend the canary bullet to end with `..., against the good fixtures through `ci.yml@v1` and the broken ones through the tag's own fixture suite, weekly and after every release.` and the mutual-watchdogs bullet to: `**Mutual watchdogs.** `repo-audit` fails when the canary's last run is red, older than 8 days or missing; the canary fails when the audit has not completed a run in 8 days or never ran.`

- [ ] **Step 3: `docs/repo-audit.md`**

Change the `--warn-kinds` sentence in the warnings paragraph to: `...and whatever `--warn-kinds` names for a run: the workflow passes `--warn-kinds caller,baseline,ruleset` until the Plan 5 rollout has put the caller and the settings on every repo; the last step of that plan removes the flag.`

- [ ] **Step 4: Run everything, commit, push, open the PR**

Run: `npm test && npm run test:fixtures && npm run lint`
Expected: unit tests Task 4's total, fixtures 10, lint clean.

```bash
git add package.json package-lock.json docs/specs/2026-09-25-ci-standard-design.md docs/repo-audit.md README.md
git commit -m "Record the Plan 5 deviations and bump Ward to 1.2.0"
git push -u origin feat/rollout
gh pr create --base main --head feat/rollout --title "Canary on the published v1, watchdogs, exceptions, and Ward's own auto-merge" --body "$(cat <<'EOF'
Plan 5, Ward side.

- `canary.yml` runs `ci.yml@v1` against the good fixtures every Monday and after every release, as a consumer would, and the v1 tag's own fixture suite for the broken ones. A reusable-workflow job cannot be expected to fail, and a weekly red run would train me to ignore it.
- `tools/watchdog.mjs` fails when the weekly audit has not completed a run in 8 days; the audit already fails on a red, stale or now missing canary (`canary-missing` is gone: a 404 is a deleted canary).
- `stacks.json` carries dated exceptions for modules a repo keeps off on purpose; the audit reports them weekly as warnings and flags stale ones.
- `ward.yml` gets the `automerge` job at the `v1.1.0` commit; `templates/ward.yml` pins the same.
- Version 1.2.0. Spec deviations recorded.

After merge: run the canary by hand once, then the audit (it is red on `canary` until the canary has a completed run), then tag `v1.2.0`.
EOF
)"
```

- [ ] **Step 5: Whole-branch review**

A fresh reviewer (the most capable model) reads the diff `main...feat/rollout` against this plan and the spec sections it names. Fix every critical and important finding on the branch (one commit per wave), re-run the three commands, push. Report the review's counts and the final commit.

---

### Task 6: Malin's manual steps: merge, first canary, audit, release `v1.2.0`

Written as her steps with exact commands. The agent runs nothing here; it hands her this task and waits.

- [ ] **Step 1: Merge the PR**

Merge the Task 5 PR on GitHub. If the `code_scanning` rule blocks a green PR, merge `main` into the branch, push, and wait for CodeQL on the new merge commit (the Plan 1 tidy-up trap).

- [ ] **Step 2: Run the canary by hand, then the audit**

Order matters: the audit is red on `canary` until the canary has one completed run.

```bash
gh workflow run canary.yml --repo malinfossum/ward
sleep 240 && gh run list --repo malinfossum/ward --workflow canary.yml --limit 1 --json conclusion,url
```
Expected: `success`. Open the run: `published / gate` green (that was `v1.1.0`), `rejects` green, `watchdog` prints `repo-audit.yml: the latest completed run is fresh.` Then:

```bash
gh workflow run repo-audit.yml --repo malinfossum/ward
sleep 240 && gh run list --repo malinfossum/ward --workflow repo-audit.yml --limit 1 --json conclusion,url
```
Expected: `success`; the summary's `malinfossum/ward canary` section has no finding, and every other repo shows only `caller`, `baseline`, `ruleset` (warnings), `uncovered` and the two org `token` warnings.

- [ ] **Step 3: Tag `v1.2.0` and move `v1`**

```bash
git switch main && git pull --ff-only
git tag -a v1.2.0 -m "Ward 1.2.0: canary on the published v1, watchdogs, audit exceptions, Ward's own auto-merge"
git tag -fa v1 -m "Ward v1: currently v1.2.0" v1.2.0^{commit}
git push origin v1.2.0
git push --force origin v1
git rev-parse v1.2.0^{commit}
gh release create v1.2.0 --verify-tag --title "v1.2.0" --latest --notes "The canary runs the published v1 every Monday and after every release; the audit and the canary watch each other; stacks.json carries dated exceptions; Ward's own ward.yml runs the auto-merge job. No change to ci.yml's inputs or checks."
gh api repos/malinfossum/ward/git/ref/tags/v1 --jq '.object.sha' | xargs -I{} gh api repos/malinfossum/ward/git/tags/{} --jq '.object.sha'
```
Expected: the last command prints the same commit SHA as `git rev-parse v1.2.0^{commit}`. Publishing the release starts one canary run, after `v1` has moved, so it tests the new release:

```bash
sleep 300 && gh run list --repo malinfossum/ward --workflow canary.yml --limit 1 --json conclusion,event
```
Expected: one `success` run with `event: release`.

- [ ] **Step 4: Tell the agent to continue**

Task 7 is a wait; Tasks 8 and onward need the release to exist.

---

### Task 7: The observation gate on Ward (one auto-merge, one refusal)

Nothing else in this plan touches another repo's auto-merge until both have been seen on Ward. Malin watches; the agent only reads.

- [ ] **Step 1: The auto-merge**

Dependabot's weekly run on Ward is Monday around 08:00 UTC. The first one after 2026-10-03 should open `Bump the npm-minor-patch group with 1 update` (`@biomejs/biome` 2.5.14 to 2.5.15). On that PR:

```bash
gh pr list --repo malinfossum/ward --author app/dependabot --json number,title,url
gh run list --repo malinfossum/ward --event pull_request --limit 3 --json name,conclusion,url
```
Open the `Ward` run for the PR: the `automerge / automerge` job's "Merge when safe" step prints `Auto-merge enabled: version-update:semver-patch of @biomejs/biome`. Once `ward / gate`, `ward-windows / gate`, `fixtures` and CodeQL are green the PR merges by itself, squashed, with Dependabot as the author. Then, because a `GITHUB_TOKEN` merge starts no push run, run the push check by hand once: `gh workflow run ward.yml --repo malinfossum/ward` and confirm it is green.

If no Dependabot PR has arrived by Tuesday: Insights, Dependency graph, Dependabot, "Check for updates" on the npm entry. If the Biome PR was opened before the Task 5 PR merged, its run used a `ward.yml` without the `automerge` job: comment `@dependabot rebase` on it, and the new run has the job. If Dependabot opens nothing because 2.5.15 is already in the lock file (it is not, today), any later first-party patch does the same job; do not fake one by downgrading a dependency. A Biome patch can change lint output; a red `ward / gate` then simply leaves the PR for me, which is also correct behaviour.

- [ ] **Step 2: The refusal**

After `v1.2.0`, Dependabot proposes `Bump malinfossum/ward from 1.1.0 to 1.2.0` for the `automerge` pin in `ward.yml` (github-actions ecosystem, not grouped, so its own PR, after the cooldown). Dependabot scans `.github/workflows/` only, so `templates/ward.yml` keeps its pin; Task 12 moves it. On that PR the `automerge` job prints `::notice::Leaving this PR for review: Ward itself: malinfossum/ward`, enables nothing, and the PR stays open. Malin merges it by hand after reading the diff (one line, the SHA and the comment). Check that the diff leaves `canary.yml`'s `ci.yml@v1` line alone; Dependabot has never touched a floating `@v1` or `@main` reference on any consumer (verified 2026-10-02), but this is the first repo with both forms of the same dependency.

If the Monday after the release brings no such PR: "Check for updates" on the github-actions entry.

- [ ] **Step 3: Record**

Both run URLs go into the Follow-ups list at the end of this plan as `Observed on Ward: auto-merge <url> (date), refusal <url> (date).` That is the gate; Tasks 8 to 12 start after it.

---

### Task 8: Consumer PRs, wave A: identity-only callers (8 repos; Malin merges)

Outside Ward; gated by Task 7. Repos: `backend-course`, `devops-course`, `ember-black`, `getacademy`, `malinfossum`, `portfolio`, `profile-dashboard`, `workbench`. Each gets `.github/workflows/ward.yml` with every module off (identity and gate only) and, where missing, a `.github/dependabot.yml` with the github-actions block. Nothing is deleted.

- [ ] **Step 1: The generators**

Two throwaway scripts, written to a temp dir, never into any repo. `caller.mjs` fills `templates/ward.yml`; `dependabot.mjs` keeps the wanted blocks of `templates/dependabot.yml` and rewrites `directory:` for a non-root block.

```bash
tmp="$(mktemp -d)"
ward="$(git rev-parse --show-toplevel)"   # run from the Ward checkout, on main after v1.2.0
pin="$(git -C "$ward" rev-parse v1^{commit})"
cat > "$tmp/caller.mjs" <<'EOF'
// node caller.mjs <template> <pin> <version> <node> <dotnet> <dotnet-os> <ef-project> <ef-startup>
import { readFileSync } from "node:fs";
const [template, pin, version, node, dotnet, os, ef, efStartup] = process.argv.slice(2);
let text = readFileSync(template, "utf8");
const set = (key, value) => {
  const re = new RegExp(`^( {6}${key}: )("[^"]*"|\\S+)`, "m");
  if (!re.test(text)) throw new Error(`no ${key} line in the template`);
  text = text.replace(re, `$1${/^[\w.-]+$/.test(value) && key === "dotnet-os" ? value : JSON.stringify(value)}`);
};
set("node", node);
set("dotnet", dotnet);
set("dotnet-os", os || "ubuntu-latest");
set("dotnet-ef-project", ef);
if (efStartup) {
  text = text.replace(/^( {6}dotnet-ef-project: .*\n)/m, `$1      dotnet-ef-startup-project: ${JSON.stringify(efStartup)}\n`);
}
text = text.replace(/dependabot-automerge\.yml@[0-9a-f]{40} # v[\d.]+/, `dependabot-automerge.yml@${pin} # ${version}`);
process.stdout.write(text);
EOF
cat > "$tmp/dependabot.mjs" <<'EOF'
// node dependabot.mjs <template> <eco[:dir],eco[:dir],...>   e.g. github-actions,npm:/web,nuget:/api
import { readFileSync } from "node:fs";
const [template, spec] = process.argv.slice(2);
const wanted = new Map(spec.split(",").map((s) => { const [eco, dir = "/"] = s.split(":"); return [eco, dir]; }));
const [head, ...blocks] = readFileSync(template, "utf8").split(/\n(?= {2}- package-ecosystem: )/);
const kept = blocks
  .filter((b) => wanted.has(b.match(/package-ecosystem: (\S+)/)[1]))
  .map((b) => b.replace(/^( {4}directory: )\S+/m, `$1${wanted.get(b.match(/package-ecosystem: (\S+)/)[1])}`));
if (kept.length !== wanted.size) throw new Error(`template lacks a block for ${[...wanted.keys()].join(",")}`);
process.stdout.write(`${head.replace(/^# Ward baseline\. Keep the blocks.*\n/, "# Ward baseline, from templates/dependabot.yml in malinfossum/ward.\n")}\n${kept.join("\n")}`);
EOF
node "$tmp/caller.mjs" "$ward/templates/ward.yml" "$pin" v1.2.0 "" "" "" "" "" | head -30
```
Expected: a caller with `node: ""`, `dotnet: ""`, `dotnet-os: ubuntu-latest`, `dotnet-ef-project: ""`, the comments kept, and the auto-merge line pinned to the `v1.2.0` commit. Check the `v1.2.0` pin equals `git rev-parse v1.2.0^{commit}` (the moved `v1` and the release point at the same commit).

- [ ] **Step 2: Open the eight PRs**

```bash
while IFS='|' read -r repo eco; do
  dir="$tmp/$(basename "$repo")"
  if ! git clone --quiet --depth 1 "https://github.com/$repo" "$dir"; then echo "SKIP $repo: clone failed"; continue; fi
  git -C "$dir" switch -qc feat/ward
  mkdir -p "$dir/.github/workflows"
  if [ -f "$dir/.github/workflows/ward.yml" ]; then echo "SKIP $repo: ward.yml exists"; continue; fi
  node "$tmp/caller.mjs" "$ward/templates/ward.yml" "$pin" v1.2.0 "" "" "" "" "" > "$dir/.github/workflows/ward.yml"
  if [ ! -f "$dir/.github/dependabot.yml" ]; then
    node "$tmp/dependabot.mjs" "$ward/templates/dependabot.yml" "$eco" > "$dir/.github/dependabot.yml"
  fi
  git -C "$dir" add .github
  git -C "$dir" -c user.name="Malin Fossum" -c user.email=malinfossum.dev@proton.me commit -qm "Call Ward's checks"
  git -C "$dir" push -q -u origin feat/ward
  gh pr create --repo "$repo" --base main --head feat/ward --title "Call Ward's checks" --body "Adds the Ward caller: identity on every commit and the \`ward / gate\` check, from malinfossum/ward \`ci.yml@v1\` (1.2.0). Stack modules stay off here on purpose (see \`stacks.json\` exceptions in Ward, or no stack to check). Adds the Dependabot baseline where it was missing. Nothing is removed; the ruleset switch to \`ward / gate\` comes after this merges."
done <<'EOF'
malinfossum/backend-course|github-actions
malinfossum/devops-course|github-actions
malinfossum/ember-black|github-actions
malinfossum/getacademy|github-actions
malinfossum/malinfossum|github-actions
malinfossum/portfolio|github-actions
malinfossum/profile-dashboard|github-actions
malinfossum/workbench|github-actions
EOF
```
`profile-dashboard` already has a `dependabot.yml`, so the generator is skipped there (report what it contains).
`malinfossum/malinfossum` needs one hand edit before its commit (D9): the dashboard pushes a README refresh to `main` twice a day as `github-actions[bot]`, and the weekly scheduled run checks the head commit, which is almost always that bot's. Under `with:` in its `ward.yml` add:

```yaml
      # The profile dashboard refreshes the README as github-actions[bot] (D9, 2026-10-02).
      allowed-emails: "malinfossum.dev@proton.me, 41898282+github-actions[bot]@users.noreply.github.com"
``` A rerun after a failed push finds `feat/ward` on the remote: delete it first (`gh api -X DELETE repos/<repo>/git/refs/heads/feat/ward`).

- [ ] **Step 3: Read the checks and report**

For each PR, wait for the `Ward` run and read `ward / gate`:
```bash
for r in backend-course devops-course ember-black getacademy malinfossum portfolio profile-dashboard workbench; do
  printf '%-18s ' "$r"; gh pr checks --repo "malinfossum/$r" feat/ward 2>/dev/null | grep -E "gate|identity" | tr '\n' ' '; echo
done
```
Expected: `ward / gate` and `ward / identity` pass on all eight (identity reads the one commit, mine). Report the eight PR URLs and the table. Malin merges; `delete_branch_on_merge` may be off on some repos, so the agent deletes `feat/ward` after each merge she reports (`gh api -X DELETE ...` as above).

---

### Task 9: Consumer PRs, wave B: module callers (9 repos; Malin merges)

Outside Ward; gated by Task 7 and by D6 and D7. Repos and inputs from the rollout table. Each PR adds `ward.yml`, a `dependabot.yml` where missing, and the script fixes D6 approved. Old CI is not deleted here (it still backs the required checks); Task 10 does that. `wendhq/wend` is not in this loop: it has its own step below and waits for Malin's go.

- [ ] **Step 1: Prepare the eight clones**

Same `$tmp`, `$ward`, `$pin` as Task 8. The table columns: repo, node dir, dotnet target, dotnet-os, ef project, ef startup, Dependabot spec. A repo with a `global.json` also gets the `dotnet-sdk` block.

```bash
while IFS='|' read -r repo node dotnet os ef efs eco; do
  dir="$tmp/$(basename "$repo")"
  if ! git clone --quiet --depth 1 "https://github.com/$repo" "$dir"; then echo "SKIP $repo: clone failed"; continue; fi
  git -C "$dir" switch -qc feat/ward
  mkdir -p "$dir/.github/workflows"
  if [ -f "$dir/.github/workflows/ward.yml" ]; then echo "SKIP $repo: ward.yml exists"; continue; fi
  node "$tmp/caller.mjs" "$ward/templates/ward.yml" "$pin" v1.2.0 "$node" "$dotnet" "$os" "$ef" "$efs" > "$dir/.github/workflows/ward.yml"
  if [ -f "$dir/global.json" ] && [ -n "$eco" ]; then eco="$eco,dotnet-sdk"; fi
  if [ ! -f "$dir/.github/dependabot.yml" ] && [ -n "$eco" ]; then
    node "$tmp/dependabot.mjs" "$ward/templates/dependabot.yml" "$eco" > "$dir/.github/dependabot.yml"
  fi
  echo "READY $repo: apply the script fixes below, then ship it"
done <<'EOF'
malinfossum/hugin|hugin-web|Hugin.slnx|ubuntu-latest|||github-actions,npm:/hugin-web,nuget
malinfossum/ignite|.||ubuntu-latest|||github-actions,npm
malinfossum/kenaz|Kenaz.Web|Kenaz.slnx|ubuntu-latest|||github-actions,npm:/Kenaz.Web,nuget
malinfossum/munin|.||ubuntu-latest|||github-actions,npm
malinfossum/spindle|.||ubuntu-latest|||github-actions,npm
malinfossum/tidsro||Tidsro.slnx|windows-latest|||github-actions,nuget
malinfossum/varde|web|api/Varde.slnx|ubuntu-latest|api/Varde.Data|api/Varde.Api|github-actions,npm:/web,nuget:/api
rookdex/rookdex|.||ubuntu-latest|||
EOF
```

Script fixes, applied in the clone before shipping (D6):
- `hugin/hugin-web/package.json`: add `"typecheck": "tsc -b"` to `scripts` (Vite's `tsconfig.app.json` sets `noEmit`; if `tsc -b` emits anything, use `"tsc -b --noEmit"`).
- `rookdex/package.json`: add `"typecheck": "astro check"` and `"deploy:check": "wrangler deploy --dry-run"`. If the dry run needs the build output, use `"astro build && wrangler deploy --dry-run"`.
- `munin`: `npm install --save-dev @biomejs/biome@2.5.14 && npx biome init`, then `"lint": "biome ci ."` in `scripts`; run `npx biome check --write .` once and read the diff; if it rewrites more than formatting, stop and show Malin. Name Biome in munin's README Stack line, or the hygiene sweep reports it as a manifest tool the README never names.

- [ ] **Step 2: Ship each repo**

```bash
ship() {
  local repo="$1" modules="$2" fixes="$3"
  local dir="$tmp/$(basename "$repo")"
  git -C "$dir" add -A
  git -C "$dir" -c user.name="Malin Fossum" -c user.email=malinfossum.dev@proton.me commit -qm "Call Ward's checks"
  git -C "$dir" push -q -u origin feat/ward
  gh pr create --repo "$repo" --base main --head feat/ward --title "Call Ward's checks" --body "Adds the Ward caller from malinfossum/ward \`ci.yml@v1\` (1.2.0): identity on every commit, the $modules, auto-merge for Dependabot patch and minor updates once this repo's ruleset requires \`ward / gate\`, and the Dependabot baseline where it was missing. $fixes The existing CI stays until the ruleset switches to \`ward / gate\`; then I remove it."
}
ship malinfossum/hugin "node and dotnet modules" "Adds a \`typecheck\` script, which Ward requires next to a tsconfig."
ship malinfossum/ignite "node module" ""
ship malinfossum/kenaz "node and dotnet modules" ""
ship malinfossum/munin "node module" "Adds Biome and a \`lint\` script, which Ward requires."
ship malinfossum/spindle "node module" ""
ship malinfossum/tidsro "dotnet module on Windows" ""
ship malinfossum/varde "node and dotnet modules, with the EF pending-migrations check" ""
ship rookdex/rookdex "node module" "Adds \`typecheck\` and \`deploy:check\` scripts, which Ward requires next to a tsconfig and a wrangler config."
```
`spindle` merges by squash (its ruleset requires linear history).

- [ ] **Step 3: `wendhq/wend`, only after Malin's go (D7)**

The co-owner's recent commits carry a personal address, which `identity` rejects and which must never appear in the public caller. The caller therefore lists their GitHub noreply address, with their consent, and they set that address as their commit email (GitHub, Settings, Emails, "Keep my email addresses private") before the PR merges. Prepare the clone as in Step 1 with the row `wendhq/wend||Wend.slnx|ubuntu-latest|||`, then under `with:` add `allowed-emails: "malinfossum.dev@proton.me, <id>+<login>@users.noreply.github.com"`, and ship with the body sentence: `Identity accepts commits from both of us by our GitHub addresses; nothing else changes for you until the ruleset requires \`ward / gate\`, and auto-merge stays off until we both agree.` Until the co-owner agrees, Ward carries `"wendhq/wend": { "caller": "...", "ruleset": "..." }` in `stacks.json` `exceptions` (dated), so the strict audit stays honest for the other sixteen repos.

- [ ] **Step 4: Read every check and report a table**

```bash
for repo in malinfossum/hugin malinfossum/ignite malinfossum/kenaz malinfossum/munin malinfossum/spindle malinfossum/tidsro malinfossum/varde rookdex/rookdex; do
  printf '%-24s ' "$repo"; gh pr checks --repo "$repo" feat/ward 2>/dev/null | grep -E "ward / " | awk '{print $1, $2}' | tr '\n' ';'; echo
done
```
For each red `ward / node` or `ward / dotnet`, open the job log and name the failing step (`lint`, `typecheck`, `test`, `build`, `restore`, `build -warnaserror`, `format`, `test`, `pending migrations`) and its first error line. Report the table: repo, result, failing step, the smallest fix I can see. Malin decides per red repo: a fix PR by the agent in that repo, or an `exception` entry in Ward (a new Ward PR, two lines in `stacks.json`). A green PR she merges; a red one waits for its fix.

---

### Task 10: Malin's settings, ruleset and auto-merge pass, then the cleanup PRs

Her commands, one repo at a time, after each caller PR is merged. The order matters: settings and CodeQL first, the ruleset only after CodeQL has analysed `main` (the `code_scanning` rule blocks every PR until then), "Allow auto-merge" only after the ruleset (auto-merge on a repo without required checks merges instantly).

- [ ] **Step 1: Settings and CodeQL, right after a caller merges**

```bash
r=malinfossum/<repo>
gh api -X PUT "repos/$r/vulnerability-alerts"
gh api -X PUT "repos/$r/automated-security-fixes"
gh api -X PATCH "repos/$r" --input - <<'EOF'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
EOF
gh api -X PATCH "repos/$r/code-scanning/default-setup" -f state=configured -f query_suite=default
```
Expected: `204`, `204`, the repo JSON, and a `202` with a `run_id`. The first two are idempotent; the CodeQL call answers `409` when default setup is already on, which is fine. For the org repos use `rookdex/rookdex` and `wendhq/wend` (D7: wend only with the co-owner's agreement).

- [ ] **Step 2: The ruleset, once CodeQL has analysed `main`**

Check first; an empty answer means wait (default setup takes a few minutes, up to an hour on a first run):
```bash
gh api "repos/$r/code-scanning/analyses?ref=refs/heads/main&per_page=1" --jq 'length'
```
Expected: `1`. Then one ruleset per repo, from `templates/ruleset.json`. An existing branch ruleset is updated in place so the old required checks (`verify`, `api-tests`, `web-tests`, `Commit identity`) go away with the same call, and any rule type the existing ruleset has that the template lacks (spindle's `required_linear_history`) is kept. The script refuses a repo with classic branch protection or more than one branch ruleset, so nothing is overwritten blind:

```bash
cd "$ward"
if gh api "repos/$r/branches/main/protection" >/dev/null 2>&1; then echo "STOP $r: classic branch protection; migrate it by hand first"; fi
ids="$(gh api "repos/$r/rulesets" --jq '[.[] | select(.target=="branch") | .id] | join(" ")')"
case "$(echo $ids | wc -w)" in
  0) id="" ;;
  1) id="$ids" ;;
  *) echo "STOP $r: more than one branch ruleset ($ids); keep one, delete the rest, rerun"; id=STOP ;;
esac
[ "$id" = STOP ] && exit 1
body="$(mktemp)"
if [ -n "$id" ]; then gh api "repos/$r/rulesets/$id" > "$tmp/existing.json"; else echo '{"rules":[]}' > "$tmp/existing.json"; fi
EXISTING="$tmp/existing.json" node -e '
  const fs = require("fs");
  const t = JSON.parse(fs.readFileSync("templates/ruleset.json", "utf8"));
  const e = JSON.parse(fs.readFileSync(process.env.EXISTING, "utf8"));
  const have = new Set(t.rules.map((r) => r.type));
  for (const rule of e.rules ?? []) if (!have.has(rule.type)) t.rules.push(rule);
  if (process.env.BYPASS_ADMIN === "1") t.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
  console.log(JSON.stringify(t));
' > "$body"
if [ -n "$id" ]; then gh api -X PUT "repos/$r/rulesets/$id" --input "$body" --jq '{id,name,bypass_actors,rules:[.rules[].type]}'
else gh api -X POST "repos/$r/rulesets" --input "$body" --jq '{id,name,bypass_actors,rules:[.rules[].type]}'; fi
gh api "repos/$r/rules/branches/main" --jq '[.[].type] | sort'
```
Expected: `["code_scanning","deletion","non_fast_forward","pull_request","required_status_checks"]` (plus `required_linear_history` on spindle). `rookdex/rookdex` has two branch rulesets: the list endpoint returns 23300025 (deletion and non-fast-forward only) first and 23444906 (pull request, `web-tests`) second, so delete 23300025 first (`gh api -X DELETE repos/rookdex/rookdex/rulesets/23300025`) and let the script update 23444906. For `devops-course` (no ruleset today) the POST path runs. `malinfossum/malinfossum` runs with `BYPASS_ADMIN=1` (D9): the dashboard's twice-daily README push uses `PROFILE_README_TOKEN`, a token of mine, so the repository-admin bypass lets it through the pull-request and status-check rules, the same pattern as Ward's tag ruleset.
- [ ] **Step 3: Allow auto-merge, in the same sitting as Step 2**

Between the ruleset switch and this step a Dependabot PR's `automerge` job fails on `gh pr merge --auto` ("auto-merge is not allowed"), which is noise, not harm; doing both steps together avoids it.

```bash
gh api -X PATCH "repos/$r" -F allow_auto_merge=true --jq '{allow_auto_merge}'
for n in $(gh pr list --repo "$r" --author app/dependabot --json number --jq '.[].number'); do gh pr comment "$n" --repo "$r" --body "@dependabot rebase"; done
```
Expected: `true`, and one `@dependabot rebase` per open Dependabot PR: those PRs were opened the moment `dependabot.yml` landed, refused for want of the required check, and Dependabot never re-runs a workflow on its own, so the rebase gives each one a fresh `automerge` run. Not on `wendhq/wend` until the co-owner agrees. For `malinfossum/malinfossum` also run the dashboard once by hand and confirm the README commit lands: `gh workflow run update-dashboard.yml --repo malinfossum/profile-dashboard`, then `gh api repos/malinfossum/malinfossum/commits?per_page=1 --jq '.[0].commit.message'`.

- [ ] **Step 4: Tell the agent which repos are done**

The agent then opens one cleanup PR per repo with old CI (`ignite/ci.yml`, `kenaz/verify.yml`, `varde/ci.yml`, `rookdex/ci.yml`'s `web-tests` job together with the `needs: web-tests` line on its `preview` job, `wend/ci.yml`, `spindle/commit-identity.yml`), title `Retire the CI that Ward now runs`, body `Ward's \`ward / gate\` is the required check since <date>; this workflow duplicated it.` `devops-course` has no CI to retire: its only workflow is a `workflow_dispatch` demo (`hei.yml`), which stays. These PRs show `ward / gate` as the one required check, which is the proof the switch worked. Malin merges.

- [ ] **Step 5: Report**

A table: repo, settings done, ruleset id and rules, auto-merge on, cleanup PR URL and state.

---

### Task 11: The six scaffolds in workbench (one PR; Malin merges)

Runs in the workbench checkout next to Ward (`git -C ../workbench pull --ff-only` first). Gated like Task 8.

- [ ] **Step 1: Write the callers**

Same generators as Task 8 (`$tmp/caller.mjs`, `$pin`, `v1.2.0`). Inputs per scaffold:

| Scaffold | node | dotnet | dotnet-os | ef project | ef startup |
|---|---|---|---|---|---|
| `csharp-api` | `""` | `"."` | `ubuntu-latest` | `App.Data` | `App.Api` |
| `csharp-console` | `""` | `"."` | `ubuntu-latest` | | |
| `csharp-layered` | `""` | `"."` | `ubuntu-latest` | | |
| `csharp-wpf` | `""` | `"."` | `windows-latest` | | |
| `web-react-ts` | `"."` | `""` | `ubuntu-latest` | | |
| `web-vite` | `"."` | `""` | `ubuntu-latest` | | |

```bash
cd ../workbench && git switch -c feat/ward-callers
for s in csharp-api csharp-console csharp-layered csharp-wpf web-react-ts web-vite; do
  # fill node/dotnet/os/ef/efs from the table
  node "$tmp/caller.mjs" "$ward/templates/ward.yml" "$pin" v1.2.0 "<node>" "<dotnet>" "<os>" "<ef>" "<efs>" > "scaffolds/$s/.github/workflows/ward.yml"
done
git rm scaffolds/web-react-ts/.github/workflows/ci.yml scaffolds/web-vite/.github/workflows/ci.yml
```
Each web scaffold's `package.json` must already carry `lint`, `test`, and `typecheck` where it has a `tsconfig.json` (`web-react-ts`); add what is missing the same way as D6. Each C# scaffold must carry a test project and the template `Directory.Build.props` (check: `diff --strip-trailing-cr "$ward/templates/Directory.Build.props" scaffolds/<s>/Directory.Build.props`, since scaffold files are CRLF). Add a workbench test that every scaffold's `ward.yml` auto-merge pin equals the pin in Ward's `templates/ward.yml` (read Ward's file from the sibling checkout, skip when it is absent), because workbench's Dependabot scans only the root workflows and would never move the scaffold pins. Every scaffold also gets `.github/dependabot.yml` from `dependabot.mjs` (`github-actions,npm` or `github-actions,nuget,dotnet-sdk`) if missing. Scaffold workflow files are CRLF in workbench: after writing, `unix2dos` or `sed -i 's/$/\r/'` on the new files and confirm `git status` shows only the intended files.

- [ ] **Step 2: Workbench tests, README, commit, PR**

```bash
npm test
```
Expected: green (105 today; tests that enumerate scaffold workflow files are updated to expect `ward.yml` and `repo-hygiene.yml`). Update the workbench README's scaffold section: one sentence that every scaffold ships the Ward caller with its modules set, and `a11y: "off"` until Plan 4. Commit `Ship the Ward caller in every scaffold`, push, `gh pr create --repo malinfossum/workbench --base main --head feat/ward-callers --title "Ship the Ward caller in every scaffold" --body "..."` with the table above in the body. Malin merges.

---

### Task 12: Drop `--warn-kinds`, pin the template to `v1.2.0`, update `/morning`

After every consumer PR and cleanup PR is merged and Task 10 is complete for every repo in the table. If the co-owner of `wendhq/wend` has not agreed yet, wend's `caller` and `ruleset` kinds are deferred through dated `exceptions` entries in `stacks.json` (Task 9 Step 3): its `ruleset` findings come from the public rules endpoint and would otherwise be hard the moment the flag goes, and the `token` warning covers only the settings.

- [ ] **Step 1: The strict dry run**

```bash
cd "$ward" && git switch main && git pull --ff-only
GITHUB_TOKEN=$(gh auth token) WARD_AUDIT_TOKEN=$(gh auth token) node tools/repo-audit.mjs --owner malinfossum,rookdex,wendhq --include-archived --mode strict
echo "exit $?"
```
Expected: exit 0, and `::warning::` lines only of kinds `uncovered`, `exception` and the org `token` lines. Every `::error::` line is a repo Task 10 did not finish; stop and list them.

- [ ] **Step 2: Remove the flag, pin the template**

```bash
git switch -c chore/warn-kinds
```
In `.github/workflows/repo-audit.yml` delete the four comment lines above the audit `run:` that start `# --warn-kinds` and the ` --warn-kinds caller,baseline,ruleset` tail of that `run:` line. In `tools/repo-audit.mjs` change the comment on line 574 to `// Kinds demoted to warnings for this run, if any.` and the comment above `warnKindsFor` to drop its "until Plan 5" clause. In `docs/repo-audit.md` delete the sentence about the workflow passing `--warn-kinds` and leave the flag documented under "Running it". In the spec's Plan 2 deviations paragraph, change `Plan 5 removes the flag` to `removed 2026-<mm>-<dd> at the end of Plan 5`. In `templates/ward.yml` move the auto-merge pin to `$(git rev-parse v1.2.0^{commit}) # v1.2.0` (what every consumer now pins). `ward.yml` on Ward normally got it through the Task 7 refusal PR; if that PR has not merged, move `ward.yml`'s pin in this commit too.

Run: `npm test && npm run lint`
Expected: green, same counts as Task 5.

```bash
git add .github/workflows/repo-audit.yml tools/repo-audit.mjs docs/repo-audit.md docs/specs/2026-09-25-ci-standard-design.md templates/ward.yml
git commit -m "Run the audit strict on every kind now that the baseline is on every repo"
git push -u origin chore/warn-kinds
gh pr create --base main --head chore/warn-kinds --title "Run the audit strict on every kind" --body "Every public repo carries the caller, the settings and the ruleset (Plan 5 Tasks 8 to 11), so caller, baseline and ruleset drift fail the weekly run again. The template pins the auto-merge job to the v1.2.0 commit, as every consumer does."
```
Malin merges, then runs the audit once by hand and confirms it is green: that is Plan 5's exit criterion.

- [ ] **Step 3: `/morning` (gated: Malin's `.claude/`)**

In `~/.claude/skills/morning/SKILL.md`, line 44: replace `A \`HTTP 404: workflow canary.yml not found\` means the canary does ...` (through the end of that sentence) with `A \`HTTP 404: workflow canary.yml not found\` is a deleted canary: report it as **Fix**.` and on line 74 replace `a missing canary reads \`canary: not yet (Plan 5)\`` with `a missing canary reads \`**Fix** Ward watchdog: canary missing\``. Commit in the harness repo as `Treat a missing Ward canary as a fault now that Plan 5 shipped it`; Malin pushes.

- [ ] **Step 4: Memory and handoff**

Update `~/.claude/memory/domain/ward.md`'s Resume with the observed auto-merge and refusal URLs, the exceptions in force, and `NEXT: Plan 3 (loadout skill + apply.mjs, which replaces Task 10's commands; pre-push hook)`. Say "safe to /clear" only when every touched repo is merged and pushed.

---

## Follow-ups (dated)

- Observed on Ward: auto-merge <url> (date), refusal <url> (date). Filled in by Task 7.
- `templates/ward.yml` pins `v1.2.0` from Task 12 on. Release routine from now on: tag, move `v1`, publish the release (which runs the canary), then one PR that moves the pin in `templates/ward.yml` and in the six workbench scaffold callers, because Dependabot scans only `.github/workflows/` at a repo's root and never moves those. Dependabot proposes the `ward.yml` bump per consumer repo, and the automerge job refuses each so I read it.
- Bypass actors are not audited (deferred from Plan 2, and D9 adds one on purpose on the profile repo). When the audit learns to read `/repos/{r}/rulesets/{id}`, the profile repo's admin bypass becomes a dated exception like the others.
- Plan 3: `apply.mjs` replaces Task 10's `gh api` loop (settings, ruleset, auto-merge in that order) and the caller generator from Task 8; the loadout pre-push hook lands there too.
- Plan 4: flip `a11y` to `warn` in the web callers and scaffolds once `test:a11y` exists.
- Plan 6: python, powershell and docker move from `planned` to `shipped` in `stacks.json`; the `uncovered` warnings on hugin, tidsro, varde, wend, devops-course and profile-dashboard go away then.
- 2026-10-28: Node 26 becomes Active LTS; bump the `node-version` default in `ci.yml` and the `"24"` fallback in `auditRepo`.
- `WARD_AUDIT_TOKEN` on Ward expires 2027-10-01. If D7 adds `AUDIT_TOKEN_ROOKDEX`, record its expiry here.
- Every `exceptions` entry in `stacks.json` is dated; the weekly `exception` warning is the reminder to revisit it (backend-course after the course ends 2027-01-08; devops-course when the course ends; ember-black if it ever gets tests).

## Considered and rejected

- **A broken-fixture job through `ci.yml@v1` with the audit reading the `verdict` job instead of the run conclusion.** Keeps the spec's letter but makes every weekly canary run red, which emails me every Monday and teaches me to ignore the one email that matters. D1.
- **Expected-failure through `continue-on-error`.** Not a valid key on a reusable-workflow call job.
- **A second workflow `canary-broken.yml` that is red by design.** Same weekly red email.
- **A `push: tags: ["v*"]` trigger instead of `release: published`.** It would run on the `v1.2.0` push, before `v1` has moved, and again on the forced `v1` move, where `github.event.before` is the old annotated tag object, which `actions/checkout` cannot fetch once nothing references it, so `identity`'s `git log <before>..<head>` fails and the canary is red on every release (stress test 2026-10-02). A release has no `before`, and the release routine publishes it after moving `v1`. The cost is that a release I forget to publish leaves the new `v1` untested until Monday; `gh release create --verify-tag` is the last line of the routine, so that is one forgotten line, not a design hole.
- **Symmetric watchdogs (each checks the other's conclusion).** Deadlocks on the first run and doubles every real finding. D2.
- **Downgrading a dependency on Ward to force an auto-merge observation.** A fake PR proves nothing a real one does not, and a real first-party patch is days away (Biome 2.5.15). Task 7 waits, with "Check for updates" as the accelerator.
- **Deleting old CI in the caller PRs.** A PR that deletes the workflow behind a required check cannot merge. The cleanup PRs come after the ruleset switch.
- **One ruleset per repo added next to the old one.** Two rulesets stack, and the old required checks would block every PR for ever once their workflows are gone. The existing ruleset is updated in place.
- **Folding hygiene into `ward.yml`.** D4.
- **`a11y: warn` now.** Requires `test:a11y`, which Plan 4 writes.
- **A per-repo exception comment inside the caller.** `parseCaller` strips comments on purpose, and a public per-repo file is a worse place for policy than one list in Ward.

> Stress-tested 2026-10-02 (skill 0b01b4c): 15 applied, 4 adapted, 3 decided by me (all as recommended, same day).
