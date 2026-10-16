# Apply

`tools/apply.mjs` puts a repo on the Ward standard: the files it carries and the settings GitHub holds
for it. Every command prints what it would do and changes nothing until `--apply`. The `ward` skill in
loadout runs it for me; by hand it runs from a Ward clone at the released tag.

## Commands

| Command | What it reads | What `--apply` does |
|---|---|---|
| `files [--dir <repo>] [--repo <owner/name>]` | The tree, every `.csproj`, the caller, `dependabot.yml`, `Directory.Build.props`, `package.json` | Writes the caller, the Dependabot config and `Directory.Build.props` where they are missing, adds the `codeql` job to a caller that has none (before `automerge:`, or at the end), and adds the npm scripts the module contract needs that are missing (`deploy:check` only for a wrangler setup); a script it will not guess, such as `test`, is reported as `ask`. An existing caller has already settled the inputs it sets, so a tie among the files for one of them (two EF projects at one depth, say) is not a `stop`: the caller's value stands, `""` included. `Directory.Build.props` is written only where the caller is new too: on a repo already on Ward it turns warnings into errors on a build that is green today, so a missing one is reported as `ask` and never written |
| `settings <owner/repo> [--dir <checkout>]` | Dependabot alerts and security updates, secret scanning and push protection, CodeQL default setup and the languages it scans, the caller's `codeql` job on the default branch or in `--dir`, and the tracked files that job will scan | Turns on what is off, and turns CodeQL default setup off once a caller with the `codeql` job is visible and covers every language default setup scans |
| `ruleset <owner/repo> [--no-codeql] [--bypass-admin]` | Classic protection, the branch rulesets, CodeQL's analyses of the default branch | Creates or updates the one branch ruleset from `templates/ruleset.json`, keeping the repo's own rule types and required checks |
| `automerge <owner/repo>` | The rules on the default branch, `allow_auto_merge`, open Dependabot PRs | Allows auto-merge and asks Dependabot to rebase each open PR |
| `status <owner/repo>` | All of the above | Nothing; one line |

The order is the only safe one. On a repo that still runs CodeQL's default setup: `files --apply`
adds the `codeql` job to the caller, `settings --dir . --apply` turns default setup off, `status`
until it reads `default-setup=not-configured`, then I push the PR, so its own `codeql` run uploads
and satisfies the code-scanning rule. `--dir` has no default: run from a Ward clone, `.` would read
Ward's own caller, so a `--dir` whose origin is another repo is a `stop`. `ruleset` waits until
CodeQL has analysed the default branch once, because a code-scanning rule before that blocks every
merge. `automerge` refuses until the default branch requires `ward / gate`, because auto-merge on a
repo without required checks merges every Dependabot PR at once. `settings` is safe at any time:
without a visible `codeql` job it leaves default setup on and says so.

CodeQL runs as the caller's `codeql` job, which calls Ward's `codeql.yml` at a pinned commit, and
GitHub refuses its uploads while default setup is on. Before it plans default setup off, `settings`
checks that every language default setup scans (`javascript` and `typescript` count as
`javascript-typescript`) is one `tools/codeql-languages.mjs` finds in the same tree; a language it
would lose is a `stop`, and so is default setup that does not list its languages. On a private repo
it prints a `note` to leave the job out: CodeQL there needs GitHub Advanced Security.

The settings commands read `GITHUB_TOKEN`; locally that is `GITHUB_TOKEN=$(gh auth token)`, which
has admin on my repos and on both orgs. The token is never printed.

## Output

One line per decision, a word padded to seven characters and then the text:

| Word | Meaning |
|---|---|
| `inputs` | The caller inputs the files say this repo needs |
| `create` | The file or ruleset is missing and would be written |
| `edit` | `package.json` would get the scripts named, or the caller the `codeql` job |
| `keep` | What is there already matches |
| `drift` | What is there differs; the detail says how. Nothing is overwritten: I settle it by hand |
| `ask` | A choice that is mine: a `test` script's runner, or `Directory.Build.props` on a repo already on Ward |
| `note` | A package a new script needs (I install it, the script never does), or a CodeQL remark: default setup stays on until a caller has the `codeql` job, wait for `status` after turning it off, leave the job out on a private repo |
| `warn` | Files of a stack no module covers yet; the covered modules still apply, and the module is the next PR to Ward |
| `stop` | A precondition is not met: two candidates at one depth for an input no existing caller sets, classic branch protection, two branch rulesets, a setting the token cannot read, auto-merge before the gate, a `--dir` that is not a readable checkout of the repo, default setup that does not list its languages, a language default setup scans that the `codeql` job would not. Exit 1, nothing written |
| `wait` | CodeQL has not analysed the default branch yet; rerun later. Exit 1 |
| `set` | A setting that would be turned on, or CodeQL default setup that would be turned off |
| `update` | A ruleset that exists and differs from the template; `--apply` brings it in line and keeps the repo's own rule types and checks |
| `rebase` | An open Dependabot PR that would be asked to rebase |
| `done` | A change `--apply` made |
| `wrote` | A file `--apply` wrote |
| `status` | The one-line state of a repo, printed by the `status` command |
| `usage` | The command was not understood; the text lists the accepted forms. Exit 1 |
| `error` | The API answered with a failure; the message says which call |

Exit code 0 means nothing to do or everything applied; 1 means stopped, waiting, or an error.

## What it never does

Overwrite a file that exists (the one edit to a caller only inserts the `codeql` job), install a
package, guess a `test` runner, merge a PR, enable auto-merge before the ruleset, write the ruleset
before CodeQL's first analysis, or turn CodeQL default setup off while no caller with the `codeql`
job is visible. `--no-codeql` is for a repo with no workflows at all, together with a dated
`ruleset` exception in `stacks.json`; every warded repo has the caller and with it an `actions`
analysis, so in practice it is unused. `--bypass-admin` is for a repo a token of mine pushes to
directly (the profile README), with the reason in the PR that adds it.

## Stack detection

The same `stacks.json` the audit reads. `node` is the directory of the one `package.json` (the
shallowest when there are several at different depths); `dotnet` is the one solution file, or the one
project file when there is no solution; `dotnet-os` is `windows-latest` when a project sets `UseWPF`;
`dotnet-ef-project` is the directory of the one project referencing
`Microsoft.EntityFrameworkCore.Design`. A tie at one depth is a `stop`, unless the repo's caller
already sets that input: then its value is what the files say, and `dotnet-ef-startup-project`
follows `dotnet-ef-project` from the caller too, `""` when the caller leaves it out. A tie for an
input the caller does not mention is still mine to settle. Dependabot gets one block per
ecosystem and directory found: `github-actions` always, `npm` per `package.json` directory, `nuget` beside
the solution, `dotnet-sdk` per `global.json`, `docker` and `pip` per directory with their files.
