# Apply

`tools/apply.mjs` puts a repo on the Ward standard: the files it carries and the settings GitHub holds
for it. Every command prints what it would do and changes nothing until `--apply`. The `ward` skill in
loadout runs it for me; by hand it runs from a Ward clone at the released tag.

## Commands

| Command | What it reads | What `--apply` does |
|---|---|---|
| `files [--dir <repo>]` | The tree, every `.csproj`, the caller, `dependabot.yml`, `Directory.Build.props`, `package.json` | Writes the caller, the Dependabot config and `Directory.Build.props` where they are missing, and adds missing `lint`, `typecheck` and `deploy:check` scripts |
| `settings <owner/repo>` | Dependabot alerts and security updates, secret scanning and push protection, CodeQL default setup | Turns on what is off |
| `ruleset <owner/repo> [--no-codeql] [--bypass-admin]` | Classic protection, the branch rulesets, CodeQL's analyses of the default branch | Creates or updates the one branch ruleset from `templates/ruleset.json`, keeping the repo's own rule types and required checks |
| `automerge <owner/repo>` | The rules on the default branch, `allow_auto_merge`, open Dependabot PRs | Allows auto-merge and asks Dependabot to rebase each open PR |
| `status <owner/repo>` | All of the above | Nothing; one line |

The order is the only safe one. `ruleset` waits until CodeQL has analysed the default branch once,
because a code-scanning rule before that blocks every merge. `automerge` refuses until the default
branch requires `ward / gate`, because auto-merge on a repo without required checks merges every
Dependabot PR at once. `settings` is safe at any time.

The settings commands read `GITHUB_TOKEN`; locally that is `GITHUB_TOKEN=$(gh auth token)`, which
has admin on my repos and on both orgs. The token is never printed.

## Output

One line per decision, a word padded to seven characters and then the text:

| Word | Meaning |
|---|---|
| `inputs` | The caller inputs the files say this repo needs |
| `create` | The file or ruleset is missing and would be written |
| `edit` | `package.json` would get the scripts named |
| `keep` | What is there already matches |
| `drift` | What is there differs; the detail says how. Nothing is overwritten: I settle it by hand |
| `ask` | A choice that is mine: a `test` script's runner |
| `note` | A package a new script needs; I install it, the script never does |
| `warn` | Files of a stack no module covers yet; the covered modules still apply, and the module is the next PR to Ward |
| `stop` | A precondition is not met: two candidates at one depth, classic branch protection, two branch rulesets, a setting the token cannot read, auto-merge before the gate. Exit 1, nothing written |
| `wait` | CodeQL has not analysed the default branch yet; rerun later. Exit 1 |
| `set` | A setting that would be turned on |
| `rebase` | An open Dependabot PR that would be asked to rebase |
| `done` | A change `--apply` made |
| `wrote` | A file `--apply` wrote |
| `status` | The one-line state of a repo, printed by the `status` command |
| `usage` | The command was not understood; the text lists the accepted forms. Exit 1 |
| `error` | The API answered with a failure; the message says which call |

Exit code 0 means nothing to do or everything applied; 1 means stopped, waiting, or an error.

## What it never does

Overwrite a file that exists, install a package, guess a `test` runner, merge a PR, enable auto-merge
before the ruleset, or write the ruleset before CodeQL's first analysis. `--no-codeql` is for a repo
CodeQL has no language for (HTML and CSS only), together with a dated `ruleset` exception in
`stacks.json`; `--bypass-admin` is for a repo a token of mine pushes to directly (the profile README),
with the reason in the PR that adds it.

## Stack detection

The same `stacks.json` the audit reads. `node` is the directory of the one `package.json` (the
shallowest when there are several at different depths); `dotnet` is the one solution file, or the one
project file when there is no solution; `dotnet-os` is `windows-latest` when a project sets `UseWPF`;
`dotnet-ef-project` is the directory of the one project referencing
`Microsoft.EntityFrameworkCore.Design`. A tie at one depth is a `stop`. Dependabot gets one block per
ecosystem and directory found: `github-actions` always, `npm` per `package.json` directory, `nuget` beside
the solution, `dotnet-sdk` per `global.json`, `docker` and `pip` per directory with their files.
