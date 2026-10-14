# Ward: CodeQL as a workflow, so fork pull requests get scanned

**Status:** design, approved in brainstorm and stress-tested 2026-10-14 · **Date:** 2026-10-14

## Why

Every warded repo runs CodeQL through GitHub's default setup, and every main ruleset carries a
`code_scanning` rule that waits for CodeQL results on the pull request's head commit. Default setup
never analyses a pull request from a fork. Hugin PR #53 came from a contributor's fork, got 0 analyses
on `refs/pull/53/head`, and could only be merged after I turned the rule off in Settings, merged and
turned it back on. That manual step has to go, without dropping the rule.

The fix is CodeQL's advanced setup: a workflow that runs on `pull_request`, which fires for forks
too. GitHub refuses uploads from an advanced workflow while default setup is on, so default setup
has to be turned off wherever the workflow takes over.

What does not change: the `code_scanning` rule stays in `templates/ruleset.json`, and a fork's
workflow runs still wait for my "Approve and run".

## Decisions

1. **Its own reusable workflow, pinned by SHA.** `.github/workflows/codeql.yml` in Ward, called from
   the existing caller as a second job `codeql`, pinned to a full commit SHA like `automerge`. It
   holds `security-events: write`, and a write-holding job never follows the moving `v1` tag. Still
   one caller file per repo. Rejected: a job inside `ci.yml@v1` (write access on a moving tag) and a
   copied `codeql.yml` per repo (drift, hand-kept language lists).
2. **Languages are found at runtime, not set as an input.** A first job lists the tracked files and
   maps them to CodeQL languages. No new caller input, nothing for the audit to compare, and a new
   language in a repo is picked up on its next run.
3. **`build-mode: none` for every language.** No build step, no SDK pinning, no Windows runner for
   WPF repos. C# buildless extraction is GitHub's recommended mode for repos that do not need a
   custom build.
4. **The audit fails, not warns, until a repo is migrated.** Default setup on, or a caller without a
   pinned `codeql` job, is a finding. The red weekly run is the reminder that gets the migration done.
5. **Python and C/C++ join the list.** Default setup scans them today (Python in profile-dashboard and
   ember-black, C/C++ in devops-course). Leaving them out would quietly drop coverage.
6. **As little fork code as possible runs in the job that can write.** `build-mode: none` is not only
   a speed choice: no build step and no npm hook runs next to `security-events: write`. Autobuild and
   manual builds are off the table for that reason. One exception remains: C# buildless extraction
   still runs `dotnet restore`, which evaluates the PR's MSBuild files. The real protection is the
   fork run's read-only token and my "Approve and run", which comes after I have read the diff.
   (Corrected 2026-10-14 while planning; CodeQL's `NugetPackageRestorer.cs`.)

## The workflow: `.github/workflows/codeql.yml`

`on: workflow_call` with no inputs. Top-level `permissions: contents: read`.

**Job `languages`** (`ubuntu-latest`, 10 min, `contents: read`):

- Fetches Ward's `tools/` at `job.workflow_sha`, the same way `ci.yml` does, then checks out the
  calling repo with `persist-credentials: false`.
- Runs `node tools/codeql-languages.mjs`, which reads `git ls-files -z` (NUL-separated, so a file
  name with a newline cannot split into two paths) and writes a JSON array to `$GITHUB_OUTPUT` as
  `languages`. The array only ever holds names from the table below, whatever the file names are.

**Job `analyze`** (`needs: languages`, `ubuntu-latest`, 60 min):

- `permissions: actions: read, contents: read, security-events: write`. `actions: read` is what
  `codeql-action` needs on a private repo.
- `strategy.fail-fast: false`, `matrix.language: ${{ fromJSON(needs.languages.outputs.languages) }}`.
- Checkout (`persist-credentials: false`), `github/codeql-action/init` with
  `languages: ${{ matrix.language }}` and `build-mode: none`, then `github/codeql-action/analyze`
  with `category: "/language:${{ matrix.language }}"`. That is the category default setup used, so
  the alerts already open carry over instead of closing and reopening.
- No `run:` step and no autobuild in this job: the only steps are checkout, init and analyze.
- Every action is pinned to a full SHA with a version comment, as `workflows.test.mjs` already demands.

The check names on a PR read `codeql / analyze (csharp)` and so on. None of them is a required
status check: the `code_scanning` rule is what makes the merge wait for them.

### `tools/codeql-languages.mjs`

Pure function `languagesFor(paths)` plus a thin CLI around `git ls-files`. Rules, in output order:

| Language | When |
|---|---|
| `actions` | Always. Every warded repo has `.github/workflows/ward.yml` |
| `csharp` | Any tracked `.cs` file |
| `javascript-typescript` | Any tracked `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` or `.tsx` file |
| `python` | Any tracked `.py` file |
| `c-cpp` | Any tracked `.c`, `.cc`, `.cpp`, `.cxx` or `.c++` file (a header alone does not count) |

Paths under a `stacks.json` ignore prefix (`node_modules/`, `bin/`, `obj/`) never count, and neither
does a `.min.js` file: CodeQL's extractor skips minified code, so a repo with only vendored minified
scripts would otherwise get a JavaScript run with nothing to extract, which fails. `.html`
alone does not count: CodeQL's JavaScript extractor fails a run that finds no script file, and that
red would block every merge on an HTML and CSS repo. A `.d.ts`-only tree counts as TypeScript, which
is right.

## The caller

`templates/ward.yml` gets the job between `ward` and `automerge`:

```yaml
  # CodeQL on every pull request, forks included; the main ruleset waits for its results.
  codeql:
    permissions:
      actions: read
      contents: read
      security-events: write
    uses: malinfossum/ward/.github/workflows/codeql.yml@<sha> # v1.4.0
```

**The first pin.** The SHA has to exist before the release that ships it. The template pins the
branch commit that holds the final `codeql.yml` and `tools/codeql-languages.mjs` (the workflow fetches
its tools at that same commit). Ward PRs are merged with a merge commit, never squashed, so the
branch commit stays reachable from `main` and from `v1.4.0`. Any later change to either file on the
branch means a new pin before merge. Before the tag, the release step checks
`git merge-base --is-ancestor <pin> v1.4.0` and that `git diff <pin> v1.4.0 -- .github/workflows/codeql.yml
tools/codeql-languages.mjs` is empty. From the next release on, Dependabot proposes the new pin in
every repo, as it does for `automerge`; `automerge.mjs` already refuses any `malinfossum/ward` bump,
so I merge each one by hand.

Ward's own `ward.yml` calls `./.github/workflows/codeql.yml` instead, so a PR to Ward tests its own
version of the workflow. A fork PR to Ward runs with a read-only token and waits for my approval, so
the local call gives nothing away that the pinned one would keep.

## `apply.mjs`

**`files`.** A caller that parses and matches the planned inputs but has no `codeql` job gets an
`edit`: the template's `codeql` block is inserted before the `automerge:` job, or at the end when
there is none. Nothing else in the file changes, and a CRLF file stays CRLF. A caller with input
drift stays `drift` and names the missing job in its detail; I settle it by hand. A caller with a
`codeql` job that is not pinned to a full SHA is `drift` too.

**`settings`.** The CodeQL line flips:

- Default setup `configured` and the `codeql` job visible: `set CodeQL default setup off`
  (`PATCH /code-scanning/default-setup` with `{"state": "not-configured"}`).
- Default setup `configured` and no `codeql` job visible: `note` that default setup stays on until
  the caller has the job, and nothing is planned. A repo is never left unscanned by accident.
- Default setup off: nothing to do. The old "turn it on" action and the `languages: []` note go.
- **Coverage guard.** Before planning "off", `settings` maps the languages default setup reports
  (`javascript` and `typescript` fold into `javascript-typescript`) and compares them with
  `languagesFor` over the same tree the workflow will see: the `--dir` checkout, else the default
  branch's tree that `readState` already fetches. A language default setup scans and the workflow
  would not is a `stop` naming it: add it to `codeql-languages.mjs` first.
- **Private repo.** CodeQL on a private repo needs GitHub Advanced Security, which I do not have, so
  the `codeql` job would fail red there. `settings` on a private repo prints a `note` saying to leave
  the job out. Every warded repo is public today.
- The PATCH answers 202 and finishes in the background. The migration waits for `status` to read
  `default-setup=not-configured` before pushing, or the PR's first upload can still be refused.

"Visible" means the caller on the default branch has the job, or `--dir <checkout>` points at a
checkout whose caller has it. `--dir` has no default: run by hand from a Ward clone, `.` would read
Ward's own caller and pass for any repo. A `--dir` whose origin is a different repo than the argument
is a `stop`. The usual order becomes: `files --apply`, then `settings --dir . --apply`, then push the
PR, so the PR's own `codeql` run uploads and satisfies the rule.

**`ruleset`.** Unchanged. It still waits for an analysis on the default branch, which the `codeql`
job's push run now provides. `--no-codeql` stays for a repo with no workflows at all; every warded
repo has one, so in practice it is unused.

**`status`.** `codeql=` becomes `default-setup=` so the line says what it reads.

## The audit

- `checkBaseline`: the finding "CodeQL default setup is not configured" goes. New finding when
  `codeScanning.state === "configured"`: "CodeQL default setup is on; it blocks the caller's codeql
  job. Run apply.mjs settings." The `languages` special case goes with it.
- `parseCaller` reads the `codeql` job's `uses:` beside `automerge`. `checkCaller` adds a finding when
  there is no `codeql` job, and one when it is not
  `malinfossum/ward/.github/workflows/codeql.yml@<40 hex>`. Ward itself may use the `./` path.
- The audit's own read of `default-setup` is unchanged, so the 403-on-archived trap is unchanged.

## Docs

`docs/apply.md` (settings row, order paragraph, `--no-codeql` sentence), `docs/repo-audit.md`
(baseline row, new caller rows), `README.md` (CodeQL line). `package.json` version to `1.4.0`; the tag
and release are a separate step on my go.

## Testing

- `codeql-languages.test.mjs`: every row of the table, the ignore prefixes, HTML-only gives only
  `actions`, the output order is stable.
- `codeql-languages.test.mjs` also: a `.min.js`-only tree gives no `javascript-typescript`, a header-only
  tree gives no `c-cpp`, a path with a newline in it is one path.
- `apply.test.mjs`: the coverage-guard stop (default setup lists `c-cpp`, the tree has none of its
  files the tool counts), `javascript` plus `typescript` folding, the private-repo note, and the caller edit (LF and CRLF, with and without an `automerge` job, unpinned job
  as drift, drift plus missing job), settings off with the job on the default branch, off with it
  only in `--dir`, the note without it, the `--dir` origin mismatch stop, the status word.
- `repo-audit.test.mjs`: default setup on is a finding, off is clean, missing and unpinned `codeql`
  job findings, Ward's `./` call accepted.
- `workflows.test.mjs`: every `init` step in `codeql.yml` sets `build-mode: none`, the `analyze` job
  has no `run:` step and no `autobuild`, `codeql.yml` holds `security-events: write` only on `analyze`, never runs on
  `pull_request_target` (already covered), and nothing outside Ward's own `ward.yml` calls it by `./`.
- `templates.test.mjs`: the template's `codeql` job is SHA-pinned and sits between `ward` and
  `automerge`.
- Live: on this branch Ward's own PR runs `codeql / analyze` for `actions` and
  `javascript-typescript` (and `csharp` for the fixtures) and uploads, after I turn default setup off
  on `malinfossum/ward`.

## Open risk

GitHub's docs do not state outright that the analyze step can upload from a fork PR's read-only
token. Real runs report that it does (oneTBB, bytefolk/mem), and it is the documented migration path.
The first fork PR after migration is the proof. If it fails, the fallback is a `workflow_run` upload,
designed then, not now.

## Considered and rejected

- **Skipping the job on private repos at runtime.** The schedule event carries no `repository`
  payload to read visibility from, and an API call per run is weight for a case with no repo in it
  today. The `settings` note covers it; revisit when a private repo is warded.
- **Leaving out vendored but unminified scripts** (`wwwroot/lib/jquery.js` in ASP.NET scaffolds).
  Default setup scans them too, so this is no regression, and a path list would drift.
- **An audit check on the age of the last analysis.** GitHub turns off scheduled runs after 60 days
  without activity in a public repo, which would also stop the Ward job; the existing canary pattern
  is the place for that, not this change.
- **Polling inside `settings` until default setup is off.** `status` already shows it; a poll loop
  with a timeout is more code than the one manual check it saves.

## Migration (after release, one repo at a time, Hugin first)

Per repo: branch `chore/ward-codeql`, `apply.mjs files --apply` (adds the job), `settings --dir .
--apply` (default setup off), `status` until it reads `default-setup=not-configured`, commit, PR,
green `codeql / analyze` runs, merge, audit clean. Open PRs from before the merge (Dependabot's
included) have no CodeQL results on their head once default setup is off, so the rule blocks them:
`@dependabot rebase` each one, or merge `main` into a branch of mine. Portfolio
also drops its `ruleset` exception in `stacks.json` and gets the code-scanning rule, since `actions`
is always there to analyse. Workbench's six scaffold callers are regenerated with `renderCaller`, and
the loadout `ward` skill moves `settings` before the PR. All of that happens outside this PR.

> Stress-tested 2026-10-14 (skill 1b85fca): 8 applied, 1 adapted, 0 decided by me.
