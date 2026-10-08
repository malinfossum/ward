# Ward apply: `apply.mjs`, the `ward` skill and the pre-push identity gate (Plan 3 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-run `task-10.sh` with `tools/apply.mjs`, a script that detects a repo's stacks, writes the files Ward needs (caller, Dependabot config, `Directory.Build.props`, missing npm scripts) and applies the GitHub settings, the ruleset and auto-merge, each change shown before it is made; wrap it in a `ward` skill in loadout; and put the guard against a private commit address where it belongs, in a pre-push hook that sees every repo on this machine.

**Architecture:** Ward side first, on one branch: `apply.mjs` reuses what the audit already has (`detectStacks`, `parseCaller`, `fetchRepoData`, `checkBaseline`, `request`) so the files it writes and the settings it sets are exactly what the weekly audit checks. Every command is a dry run until `--apply`, and the settings commands refuse out of order: the ruleset waits for CodeQL's first analysis of `main`, auto-merge waits for the ruleset. Then `v1.3.0`. Loadout side second, on one branch: the skill clones Ward at `v1` and runs the released script, and `.githooks/pre-push` becomes the global `core.hooksPath` so the identity gate runs before any push from this machine. Last, on Malin's go, the end-to-end proof on two throwaway repos, and the hand-off from `project-init`.

**Tech Stack:** Node 24 ESM scripts with no dependencies, `node:test`, Biome 2.5.15, GitHub REST API via `fetch`; PowerShell 7.4 and Pester 5.7 in loadout; POSIX `sh` for the hook (Git for Windows and GitHub Desktop both ship `sh.exe`).

**Spec:** `docs/specs/2026-09-25-ci-standard-design.md` (rollout item 3; sections Capturing new stacks, Security of Ward itself (Account), Baseline, Auto-merge). Stress-test finding 32 (2026-09-28, "the guard against a private address sits before the push") is what the hook implements.

## Global Constraints

- English, first person, short direct sentences. No em dashes anywhere: not in code comments, docs, commit messages, PR bodies, the skill or this plan. Never a `Co-Authored-By` trailer or AI attribution in commits.
- Node **24** as the local floor (`engines: >=24`); scripts use the Node standard library only. Biome **2.5.15**: `npm run lint` is `biome ci .` and must exit 0 with clean output. Unit tests: `npm test` (`node --test "tools/*.test.mjs"`). Fixture tests: `npm run test:fixtures`. Both stay green; new totals are stated as "previous count + N", never invented. Loadout: `Invoke-Pester tests` stays green.
- Scripts start processes as argument arrays, never shell strings. Findings and output lines never print a token. `apply.mjs` prints my dev address only in the form the template already carries; the hook prints an offending address redacted the way the identity job does (first character and domain), because a Claude Code session sees the refusal too.
- `apply.mjs` changes nothing without `--apply`, never overwrites a file that exists, never installs a package, never guesses a `test` runner, never merges a PR, and never enables auto-merge while the default branch does not require `ward / gate`.
- A script that fails sets `process.exitCode = 1`; nothing calls `process.exit`. Output lines are `<word, padded to 7> <text>`; the words are `inputs`, `create`, `edit`, `keep`, `drift`, `ask`, `note`, `warn`, `stop`, `wait`, `set`, `rebase`, `done`, `error`.
- Branch `feat/apply` off `main` in Ward (Tasks 1 to 5); branch `skills/ward` off `main` in loadout (Tasks 7 and 8). Commit after every task. Commit author `malinfossum.dev@proton.me`. Merging, tagging, releasing, creating or deleting repos, running `install.ps1`, and any change under `~/.claude/` outside the loadout links are Malin's calls.
- Loadout stays installable on a machine that is not mine: the hook must not assume `pwsh` unless it is in loadout itself, and the installer must never override a global `core.hooksPath` that is not ours.

## Review Focus

Each line names an input the spec implies but no existing test covers, and the task whose tests now pin it.

1. Two `package.json` (or two solutions, or two EF projects) at the same depth are a stop, never a pick: the script says which two and leaves the input to me. Pinned in Task 1 (`planInputs` tie tests).
2. An existing caller is never rewritten, and `dotnet: "."` next to a planned `App.slnx` at the root is the same choice, not drift; a real difference is reported per input. Pinned in Task 2 (`planFiles` caller tests).
3. A settings field the token could not read is a stop, never a blind write: a `PUT` with a token that lacks admin would fail anyway, and a silent retry would hide it. Pinned in Task 3 (`planSettings` unreadable test).
4. The ruleset keeps a repo's own required checks beside `ward / gate` (workbench's two `test (...)` checks, varde's `api-tests`) and its foreign rule types, and `automerge` refuses while `main` does not require `ward / gate`. Pinned in Task 4 (`mergeRuleset` and `planAutomerge` tests).
5. The hook refuses a foreign committer behind my own author line, and lets a branch deletion, a push of commits already on the remote, and `--no-verify` through. Pinned in Task 7 (`Hooks.Tests.ps1`).

## Decisions (recommendation first; Malin decides on review)

**Decided 2026-10-08 (Malin):** D1 and D3 as recommended. The rest stand as recommended.

- **D1, how the hook reaches every repo.** Recommendation: `install.ps1` sets the global `core.hooksPath` to the clone's `.githooks` folder (and keeps the clone's own local setting). One hook file, every repo on the machine, new clones included, and GitHub Desktop runs it too (its bundled git honours `core.hooksPath` and ships `sh.exe`, verified below). The cost: a repo that relies on its own `.git/hooks/*` files loses them while the global path is set; today no repo of mine has any (verified below), and husky-style repos set a local `core.hooksPath`, which wins over the global one. Alternatives: the `ward` skill copies the hook into each repo's `.git/hooks` (misses every repo the skill never touched, and every fresh clone), or `init.templateDir` (new clones only).
- **D2, how the skill gets Ward's code.** Recommendation: a shallow clone of the `v1` tag into a temp folder on every run (`git clone --depth 1 --branch v1`), `WARD_DIR` as an override for a local clone while developing. `apply.mjs` needs `stacks.json`, the templates and three sibling modules, so fetching `stacks.json` alone (the spec's wording) is not enough, and the local Ward clone sits on `main`, which is development, not the standard. Alternative: `npx github:malinfossum/ward#v1` with a `bin` entry; it adds an npm cache whose refresh rules for a moving tag I have not verified.
- **D3, an uncovered stack warns, it does not stop.** The spec says the skill "stops and drafts a new module" when files match no rule. Hugin (`powershell`) and devops-course (`docker`) have carried callers since Plan 5 with `uncovered` as a weekly warning, so a hard stop would make the skill refuse repos the audit accepts. Recommendation: the covered modules are applied, the `warn` line names the stack, and drafting the module (or the dated exception) is the skill's last step. Recorded as a Plan 3 deviation.
- **D4, the end-to-end proof.** Recommendation: two throwaway public repos you create, `ward-test-web` (the `web-react-ts` scaffold) and `ward-test-dotnet` (the `csharp-api` scaffold, which has a test project and an EF project), taken through the whole skill, the hook refusal proven on the first push from the CLI and from GitHub Desktop, the audit run against them, then deleted. Alternative: dry runs on existing repos only, which proves the reads and the plans but not one write.
- **D5, the hook's allowlist.** Recommendation: fixed in the hook: my dev address, Dependabot's, and GitHub's web address (`noreply@github.com`, which a web-UI merge can set as committer). No per-repo configuration and no reading of the caller's `allowed-emails`: when I push a co-owner's commits myself, which is rare, `git push --no-verify` is the deliberate escape and the identity job on the PR still checks them. The refusal names the address redacted (first character and domain), as the identity job does, so a co-owner's address never lands whole in a session transcript. Alternative: parse `allowed-emails` from `.github/workflows/ward.yml` in `sh`, which the multi-line YAML form defeats.
- **D6, which scripts are written.** `lint` (`biome ci .`), `typecheck` (`tsc --noEmit`, or `astro check` when `astro` is a dependency) and `deploy:check` (`wrangler deploy --dry-run`) are written when the node contract requires them, with a `note` naming the package to add when it is not a devDependency. `test` is never guessed: an `ask` line, and I pick the runner.
- **D7, `project-init` hands over to `ward`.** One line in `~/.claude/skills/project-init/SKILL.md` step 8, so a scaffolded repo gets its caller before its first push. A harness edit, so it lands in Task 9 on your go, as the morning-skill edit did in Plan 5.
- **D8, what is never overwritten.** An existing `ward.yml`, `dependabot.yml` or `Directory.Build.props` is compared and reported (`keep` or `drift`), never replaced: a hand edit (a co-owner's noreply address, `a11y: warn`, the dashboard's bot address) must survive a rerun.

## Reference facts (verified 2026-10-08)

- Ward `main` is at `3971d19`; unit tests 172 (171 pass, 1 skipped live test); `npm run lint` clean over 30 files. `templates/ward.yml` pins the automerge job to `81c5a32c5a0bdb52ea1f8e99fd314d41eb73b397 # v1.2.1`.
- `task-10.sh` lives under `.superpowers/sdd/2026-10-02-ward-rollout/` and is gitignored (`.superpowers/sdd/.gitignore`), so nothing is deleted from the tree; `docs/apply.md` is where its knowledge goes. Its `ruleset` step merged the template with any rule type the repo already had, and I kept workbench's and varde's own required checks by hand; `mergeRuleset` does both.
- `request(path, token)` in `tools/repo-audit.mjs` is GET-only today; 204, 401, 403 and 404 come back with a `null` body, anything else 4xx or 5xx throws. `fetchRepoData(meta, { admin, read })` reads settings only when `meta.security_and_analysis` is present, which the single-repo endpoint includes only for a token with admin on the repo. `checkBaseline` treats a CodeQL `default-setup` body with an empty `languages` list as "cannot be turned on", not a finding. `requiredChecksFrom(rules)` exists in `repo-audit.mjs` but is not exported.
- The settings endpoints, as used by `task-10.sh` on 16 repos on 2026-10-08: `PUT /repos/{r}/vulnerability-alerts` (204), `PUT /repos/{r}/automated-security-fixes` (204), `PATCH /repos/{r}` with `security_and_analysis` and with `allow_auto_merge`, `PATCH /repos/{r}/code-scanning/default-setup` with `{ "state": "configured", "query_suite": "default" }` (202 with a `run_id`), `GET /repos/{r}/code-scanning/analyses?ref=refs/heads/main&per_page=1` (an empty list or 404 until the first analysis), `GET /repos/{r}/branches/main/protection` (200 only for classic protection), `GET /repos/{r}/rulesets` (list; `target` is `branch` or `tag`), `GET|PUT /repos/{r}/rulesets/{id}`, `POST /repos/{r}/rulesets`, `GET /repos/{r}/rules/branches/main`, and the comment `@dependabot rebase` on each open Dependabot PR (`POST /repos/{r}/issues/{n}/comments`).
- `gh auth token` on this machine is a classic token with `repo` and `workflow`, enough for every call above on my own repos and on both orgs where I am admin.
- `node-contract.mjs`'s `planSteps({ scripts, files, a11y, hasPlaywright })` returns `missing`, the required scripts the manifest lacks: `lint` and `test` always, `typecheck` when `tsconfig.json` or `astro.config.*` is in the node directory, `deploy:check` when `wrangler.toml|json|jsonc` is.
- `stacks.json` modules in order: `node` (`package.json`), `dotnet` (`*.sln`, `*.slnx`, `*.csproj`), then `python`, `powershell`, `docker` as `planned`. `detectStacks` returns them in that order and already applies the ignore prefixes `node_modules/`, `bin/`, `obj/`, `.git/`.
- Workbench scaffolds and the callers Plan 5 gave them: `web-react-ts` (`node: "."`; scripts `lint`, `test`, `typecheck`, `test:e2e`, `build`; `tsconfig.json`; a lock file), `csharp-api` (`dotnet: "."`, `dotnet-ef-project: "App.Data"`; `App.Tests`, `App.slnx`, `global.json`), `csharp-wpf` (`dotnet-os: windows-latest`), `csharp-console` (dotnet off: no tests). The scaffolds carry `node_modules`, `dist` and `test-results` folders locally.
- Loadout: `main` at `4a8fd6f`, clean. `install.ps1` sets `core.hooksPath=.githooks` on the clone only and skips when a global path exists; `.githooks/pre-push` is `sh`, runs `tools/scan-secrets.ps1` through `pwsh`; `.gitattributes` already forces LF on it. `Get-LoadoutSkillNames` is a fixed list of ten names in `lib/Loadout.psm1`; `tests/Manifest.Tests.ps1` pins that list and the CLAUDE.md heading `(v0.4.0)`; `tests/Verify.Tests.ps1` line 21 expects 17 health lines (loadout + 10 skills + 2 agents + block + standards + git + hooks) and lines 55 to 60 pin the two hooks messages; `$script:Heading` in the module still says `(v0.3.0)` (used by the smoke test only). `Test-LoadoutSamePath` compares full paths case-insensitively and accepts forward slashes.
- This machine: no global `core.hooksPath`; the only repo with a local `core.hooksPath` or a custom `.git/hooks` file is loadout itself (checked every clone under `Development\GitHub\repos` and `Documents\Brain`). GitHub Desktop 3.6.6 ships `resources/app/git/usr/bin/sh.exe`, so a `#!/bin/sh` hook runs from Desktop pushes too; whether its `sh` has `awk` is unverified, which is why the hook below uses `case` and no external tool but `git`.
- `malinfossum/loadout` is private, so it is outside the audit and never gets a caller.
- `readdirSync(dir, { recursive: true, withFileTypes: true })` entries carry `parentPath` on Node 24; `JSON.stringify(value, null, "\t")` indents with tabs, which the `web-react-ts` scaffold's `package.json` uses.

## File map

| Path | Task | What |
|---|---|---|
| `tools/apply.mjs` | 1 to 4 | `planInputs`, `renderCaller`, `renderDependabot` (1); `listTree`, `missingScripts`, `withScripts`, `planFiles`, `writeFiles`, the `files` command and `runApply` (2); `readState`, `planSettings`, `statusLine`, the `settings` and `status` commands (3); `mergeRuleset`, `sameRuleset`, `planRuleset`, `planAutomerge`, the `ruleset` and `automerge` commands (4) |
| `tools/apply.test.mjs` | 1 to 4 | The tests for each of those, with a local `stubFetch` |
| `tools/repo-audit.mjs` | 3, 4 | `request` gains `{ method, body }`; `requiredChecksFrom` is exported |
| `docs/apply.md`, `README.md`, `docs/specs/...design.md`, `package.json` | 5 | Docs, the Plan 3 deviations, version 1.3.0 |
| loadout `.githooks/pre-push`, `lib/Loadout.psm1`, `tests/Hooks.Tests.ps1`, `tests/Install.Tests.ps1`, `tests/Verify.Tests.ps1`, `README.md` | 7 | The identity gate and the global hooks path |
| loadout `skills/ward/SKILL.md`, `skills/ward/references/commands.md`, `lib/Loadout.psm1`, `tests/Manifest.Tests.ps1`, `tests/Verify.Tests.ps1`, `CLAUDE.md`, `README.md` | 8 | The skill, the manifest, version 0.5.0 |
| `~/.claude/skills/project-init/SKILL.md` | 9 | One line in step 8 (Malin's go) |

---

### Task 1: What a tree needs: inputs and Dependabot blocks, and the two renderers

**Files:**
- Create: `tools/apply.mjs`, `tools/apply.test.mjs`

**Interfaces:**
- Consumes: `detectStacks(paths, stacks)`, `ignored(path, prefixes)`, `loadStacks()` from `tools/stacks.mjs`; `parseCaller(text)` from `tools/repo-audit.mjs` (tests only).
- Produces: `dirOf(path) → string` (`.` for a root file); `planInputs(paths: string[], csproj: Record<path, text>, stacks) → { inputs: { node, dotnet, "dotnet-os", "dotnet-ef-project" }, ecosystems: { ecosystem, directory }[], uncovered: string[], stops: string[] }`; `renderCaller(template: string, inputs) → string`; `renderDependabot(template: string, ecosystems) → string`. Task 2 builds `planFiles` on all three.

- [ ] **Step 1: Branch**

```bash
git switch main && git pull --ff-only && git switch -c feat/apply
```

- [ ] **Step 2: Write the failing tests**

Create `tools/apply.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { planInputs, renderCaller, renderDependabot } from "./apply.mjs";
import { parseCaller } from "./repo-audit.mjs";
import { loadStacks } from "./stacks.mjs";

const stacks = loadStacks();
const plan = (paths, csproj = {}) => planInputs(paths, csproj, stacks);
const EF = '<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.12" />';
const WPF = "<UseWPF>true</UseWPF>";
const callerTemplate = readFileSync("templates/ward.yml", "utf8");
const dependabotTemplate = readFileSync("templates/dependabot.yml", "utf8");

test("node is the one package.json's directory, the root as .", () => {
  assert.equal(plan(["package.json", "src/a.js"]).inputs.node, ".");
  assert.equal(plan(["web/package.json"]).inputs.node, "web");
  assert.equal(plan(["README.md"]).inputs.node, "");
});

test("the shallowest package.json wins; a tie is a stop, never a guess", () => {
  assert.equal(plan(["package.json", "e2e/package.json"]).inputs.node, ".");
  const tie = plan(["web/package.json", "api/package.json"]);
  assert.equal(tie.inputs.node, "");
  assert.match(
    tie.stops[0],
    /More than one package\.json at the same depth \(web\/package\.json, api\/package\.json\)/,
  );
});

test("dotnet is the solution file, or the only project when there is none", () => {
  assert.equal(plan(["App.slnx", "src/App/App.csproj"]).inputs.dotnet, "App.slnx");
  assert.equal(plan(["api/App.sln", "api/src/App/App.csproj"]).inputs.dotnet, "api/App.sln");
  assert.equal(plan(["Tool/Tool.csproj"]).inputs.dotnet, "Tool/Tool.csproj");
  const two = plan(["A/A.csproj", "B/B.csproj"]);
  assert.equal(two.inputs.dotnet, "");
  assert.match(two.stops[0], /More than one project file with no solution above it/);
  assert.equal(plan(["Legacy.sln", "App.slnx"]).stops.length, 1);
});

test("WPF means windows-latest; the project referencing EF Design is the EF project", () => {
  const paths = ["App.slnx", "src/App/App.csproj", "src/App.Data/App.Data.csproj"];
  const csproj = { "src/App/App.csproj": WPF, "src/App.Data/App.Data.csproj": EF };
  const { inputs } = plan(paths, csproj);
  assert.equal(inputs["dotnet-os"], "windows-latest");
  assert.equal(inputs["dotnet-ef-project"], "src/App.Data");
  assert.equal(plan(paths, {}).inputs["dotnet-os"], "ubuntu-latest");
  assert.equal(plan(paths, {}).inputs["dotnet-ef-project"], "");
  const twoEf = plan(paths, { "src/App/App.csproj": EF, "src/App.Data/App.Data.csproj": EF });
  assert.match(twoEf.stops[0], /More than one project referencing Microsoft\.EntityFrameworkCore\.Design/);
});

test("files under node_modules, bin and obj never count", () => {
  const { inputs } = plan(["node_modules/x/package.json", "bin/Debug/App.csproj", "README.md"]);
  assert.deepEqual(inputs, {
    node: "",
    dotnet: "",
    "dotnet-os": "ubuntu-latest",
    "dotnet-ef-project": "",
  });
});

test("a planned stack is reported as uncovered and still gets its Dependabot block", () => {
  const { uncovered, ecosystems } = plan(["pyproject.toml", "Dockerfile"]);
  assert.deepEqual(uncovered, ["python", "docker"]);
  assert.deepEqual(
    ecosystems.map((e) => e.ecosystem),
    ["github-actions", "docker", "pip"],
  );
});

test("Dependabot blocks follow the stacks: one per npm directory, nuget and dotnet-sdk with dotnet", () => {
  const { ecosystems } = plan([
    "package.json",
    "App.slnx",
    "src/App/App.csproj",
    "global.json",
    "e2e/package.json",
  ]);
  assert.deepEqual(ecosystems, [
    { ecosystem: "github-actions", directory: "/" },
    { ecosystem: "npm", directory: "/" },
    { ecosystem: "npm", directory: "/e2e" },
    { ecosystem: "nuget", directory: "/" },
    { ecosystem: "dotnet-sdk", directory: "/" },
  ]);
  const nested = plan(["api/App.sln", "api/global.json", "api/src/App/App.csproj", "web/Dockerfile"]);
  assert.deepEqual(nested.ecosystems.slice(1), [
    { ecosystem: "nuget", directory: "/api" },
    { ecosystem: "dotnet-sdk", directory: "/api" },
    { ecosystem: "docker", directory: "/web" },
  ]);
});

test("renderCaller fills the inputs, keeps the comments aligned and round-trips through parseCaller", () => {
  const inputs = { node: "web", dotnet: "App.slnx", "dotnet-os": "ubuntu-latest", "dotnet-ef-project": "" };
  const text = renderCaller(callerTemplate, inputs);
  assert.match(text, /^ {6}node: "web" +# npm project directory/m);
  assert.match(text, /^ {6}a11y: "off"/m);
  const parsed = parseCaller(text);
  assert.equal(parsed.uses, "malinfossum/ward/.github/workflows/ci.yml@v1");
  for (const [key, value] of Object.entries(inputs)) assert.equal(parsed.inputs[key], value);
  const columns = text
    .split("\n")
    .filter((line) => /^ {6}(node|a11y|dotnet|dotnet-os|dotnet-ef-project):/.test(line))
    .map((line) => line.indexOf("#"));
  assert.equal(columns.length, 5);
  assert.equal(new Set(columns).size, 1, `comment columns differ: ${columns}`);
});

test("renderCaller keeps a bare value bare and one space before a comment it cannot align", () => {
  const inputs = {
    node: "",
    dotnet: "api/App.slnx",
    "dotnet-os": "windows-latest",
    "dotnet-ef-project": "api/src/App.Data",
  };
  const text = renderCaller(callerTemplate, inputs);
  assert.match(text, /^ {6}dotnet-os: windows-latest # windows-latest for WPF$/m);
  assert.match(text, /^ {6}dotnet-ef-project: "api\/src\/App\.Data" # EF Core project/m);
  assert.match(text, /^ {6}node: "" +# npm project directory/m);
  assert.equal(parseCaller(text).inputs["dotnet-ef-project"], "api/src/App.Data");
});

test("renderDependabot keeps one block per ecosystem, in order, with its directory and comments", () => {
  const text = renderDependabot(dependabotTemplate, [
    { ecosystem: "github-actions", directory: "/" },
    { ecosystem: "npm", directory: "/web" },
    { ecosystem: "nuget", directory: "/" },
  ]);
  const blocks = [...text.matchAll(/^ {2}- package-ecosystem: (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(blocks, ["github-actions", "npm", "nuget"]);
  assert.match(text, /^version: 2$/m);
  assert.match(text, /^ {2}# Only GitHub's own actions are grouped/m);
  assert.match(text, /package-ecosystem: npm[^\n]*\n {4}directory: \/web$/m);
  assert.match(text, /dotnet-runtime:/);
  assert.doesNotMatch(text, /pip|docker|dotnet-sdk/);
  assert.doesNotMatch(text, /delete the rest/);
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
});

test("renderDependabot repeats the npm block for a second directory", () => {
  const text = renderDependabot(dependabotTemplate, [
    { ecosystem: "github-actions", directory: "/" },
    { ecosystem: "npm", directory: "/" },
    { ecosystem: "npm", directory: "/e2e" },
  ]);
  assert.deepEqual(
    [...text.matchAll(/^ {4}directory: (\S+)/gm)].map((m) => m[1]),
    ["/", "/", "/e2e"],
  );
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test tools/apply.test.mjs`
Expected: FAIL, `Cannot find module './apply.mjs'`.

- [ ] **Step 4: Write `planInputs`, `renderCaller` and `renderDependabot`**

Create `tools/apply.mjs`:

```js
// Applies the Ward standard to one repo: the files it carries (the caller,
// the Dependabot config, Directory.Build.props, the npm scripts the node
// contract needs) and the settings GitHub holds for it (Dependabot, secret
// scanning, CodeQL, the ruleset on the default branch, auto-merge). Every
// command prints what it would do and changes nothing until --apply. The
// ward skill in loadout drives it; by hand: node tools/apply.mjs <command>.
import { detectStacks, ignored } from "./stacks.mjs";

const depth = (path) => path.split("/").length;
export const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

// The shallowest of the candidates; a tie is a stop, because the choice is
// then mine, not the script's.
function pickOne(paths, what, stops) {
  if (paths.length === 0) return "";
  const top = Math.min(...paths.map(depth));
  const shallowest = paths.filter((path) => depth(path) === top);
  if (shallowest.length === 1) return shallowest[0];
  stops.push(
    `More than one ${what} at the same depth (${shallowest.join(", ")}); set that input yourself.`,
  );
  return "";
}

// The caller inputs and the Dependabot blocks a tree needs. paths are
// repo-relative with forward slashes; csproj holds the text of every .csproj
// in paths, by path. A planned stack is reported as uncovered, never guessed.
export function planInputs(paths, csproj, stacks) {
  const stops = [];
  const kept = paths.filter((path) => !ignored(path, stacks.ignore));
  const detected = detectStacks(kept, stacks);
  const filesOf = (name) => detected.find((stack) => stack.name === name)?.files ?? [];
  const uncovered = detected.filter((stack) => stack.status !== "shipped").map((s) => s.name);

  const manifests = filesOf("node");
  const manifest = pickOne(manifests, "package.json", stops);
  const solutions = filesOf("dotnet").filter((path) => /\.slnx?$/.test(path));
  const projects = filesOf("dotnet").filter((path) => path.endsWith(".csproj"));
  const dotnet = solutions.length
    ? pickOne(solutions, "solution file", stops)
    : pickOne(projects, "project file with no solution above it", stops);
  const text = (path) => csproj[path] ?? "";
  const wpf = projects.some((path) => /<UseWPF>\s*true\s*<\/UseWPF>/i.test(text(path)));
  const ef = pickOne(
    projects.filter((path) => /Microsoft\.EntityFrameworkCore\.Design/.test(text(path))),
    "project referencing Microsoft.EntityFrameworkCore.Design",
    stops,
  );

  const inputs = {
    node: manifest ? dirOf(manifest) : "",
    dotnet,
    "dotnet-os": wpf ? "windows-latest" : "ubuntu-latest",
    "dotnet-ef-project": ef ? dirOf(ef) : "",
  };
  const ecosystems = [{ ecosystem: "github-actions", directory: "/" }];
  for (const path of manifests) {
    const dir = dirOf(path);
    ecosystems.push({ ecosystem: "npm", directory: dir === "." ? "/" : `/${dir}` });
  }
  // Dependabot looks only in the directory a block names, so the nuget block
  // sits beside the solution and a nested global.json, Dockerfile or
  // pyproject.toml gets a block of its own (varde keeps global.json under api/).
  const asDirectory = (dir) => (dir === "." ? "/" : `/${dir}`);
  const dirs = (files) => [...new Set(files.map((path) => dirOf(path)))];
  if (dotnet) ecosystems.push({ ecosystem: "nuget", directory: asDirectory(dirOf(dotnet)) });
  for (const dir of dirs(kept.filter((path) => /(^|\/)global\.json$/.test(path)))) {
    ecosystems.push({ ecosystem: "dotnet-sdk", directory: asDirectory(dir) });
  }
  for (const dir of dirs(filesOf("docker"))) {
    ecosystems.push({ ecosystem: "docker", directory: asDirectory(dir) });
  }
  for (const dir of dirs(filesOf("python"))) {
    ecosystems.push({ ecosystem: "pip", directory: asDirectory(dir) });
  }
  return { inputs, ecosystems, uncovered, stops };
}

// Fills the template's input lines. A quoted template value stays quoted, a
// bare one stays bare, and the comment keeps its column when the value fits.
export function renderCaller(template, inputs) {
  return template
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s+)([\w-]+):\s*("[^"]*"|[^\s#]*)\s*(#.*)?$/);
      if (!m || !Object.hasOwn(inputs, m[2])) return line;
      const quoted = m[3].startsWith('"');
      const value = quoted ? `"${inputs[m[2]]}"` : inputs[m[2]] || '""';
      const head = `${m[1]}${m[2]}: ${value}`;
      if (!m[4]) return head;
      return head.padEnd(Math.max(line.indexOf("#"), head.length + 1)) + m[4];
    })
    .join("\n");
}

// Keeps the template's header and one block per ecosystem entry, with its
// directory set; the comment lines above a block travel with it.
export function renderDependabot(template, ecosystems) {
  const [header, body] = template.split("updates:\n");
  const blocks = [];
  let current = null;
  let comments = [];
  for (const line of body.split("\n")) {
    const start = line.match(/^ {2}- package-ecosystem: (\S+)/);
    if (start) {
      current = { ecosystem: start[1], lines: [...comments, line] };
      comments = [];
      blocks.push(current);
    } else if (line.trim() === "") {
      current = null;
      comments = [];
    } else if (current) {
      current.lines.push(line);
    } else {
      comments.push(line);
    }
  }
  const chosen = ecosystems.flatMap(({ ecosystem, directory }) => {
    const block = blocks.find((b) => b.ecosystem === ecosystem);
    if (!block) return [];
    const lines = block.lines.map((l) => l.replace(/^( {4}directory: ).*$/, `$1${directory}`));
    return [lines.join("\n")];
  });
  const intro = header.replace(
    /^# Ward baseline\..*$/m,
    "# Ward baseline, written by the ward skill from the stacks in this repo.",
  );
  return `${intro}updates:\n${chosen.join("\n\n")}\n`;
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tools/apply.test.mjs && npm run lint`
Expected: PASS, 11 tests; lint clean.

- [ ] **Step 6: Commit**

```bash
git add tools/apply.mjs tools/apply.test.mjs
git commit -m "apply: plan a repo's caller inputs and Dependabot blocks from its files"
```

---
### Task 2: The files a repo carries: plan, write, and the `files` command

**Files:**
- Modify: `tools/apply.mjs` (imports and new functions after `renderDependabot`), `tools/apply.test.mjs`

**Interfaces:**
- Consumes: `planInputs`, `renderCaller`, `renderDependabot`, `dirOf` (Task 1); `planSteps` from `tools/node-contract.mjs`; `parseCaller` from `tools/repo-audit.mjs`; `loadStacks` from `tools/stacks.mjs`.
- Produces: `ROOT`, `CALLER`, `DEPENDABOT`, `PROPS` constants; `readTemplates(root = ROOT) → { caller, dependabot, props: Buffer }`; `listTree(dir, stacks) → string[]`; `missingScripts(pkg, files) → { add, ask, notes }`; `withScripts(text, add) → string`; `planFiles(dir, { stacks, templates }) → { inputs, ecosystems, uncovered, stops, files: { path, action, detail?, content? }[], notes }` with actions `create | edit | keep | drift | ask`; `writeFiles(dir, plan) → string[]`; `runApply(argv, env, deps = {}) → Promise<{ lines, exitCode }>` handling `files [--dir d] [--apply]`. Tasks 3 and 4 add commands to `runApply`.

- [ ] **Step 1: Write the failing tests**

Append to `tools/apply.test.mjs`. Extend the first import line to `import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";`, add `import { tmpdir } from "node:os";` and `import { dirname, join } from "node:path";`, and extend the `./apply.mjs` import with `CALLER, DEPENDABOT, PROPS, planFiles, readTemplates, runApply, writeFiles`.

```js
const templates = readTemplates();
const PKG = JSON.stringify({ name: "x", scripts: { lint: "biome ci .", test: "node --test" } }, null, 2);

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "ward-apply-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const actions = (plan) => plan.files.map((f) => [f.path, f.action]);
const file = (plan, path) => plan.files.find((f) => f.path === path);

test("a fresh web repo gets the caller and the Dependabot config; node_modules is invisible", () => {
  const dir = repo({ "package.json": PKG, "src/app.js": "", "node_modules/x/package.json": "{}" });
  const plan = planFiles(dir, { templates });
  assert.equal(plan.inputs.node, ".");
  assert.deepEqual(actions(plan), [
    [CALLER, "create"],
    [DEPENDABOT, "create"],
    ["package.json", "keep"],
  ]);
  assert.match(file(plan, CALLER).content, /^ {6}node: "\."/m);
  assert.match(file(plan, DEPENDABOT).content, /package-ecosystem: npm/);
  assert.doesNotMatch(file(plan, DEPENDABOT).content, /nuget/);
});

test("a C# repo gets Directory.Build.props too; a changed copy is drift, never replaced", () => {
  const dir = repo({
    "App.slnx": "",
    "src/App/App.csproj": "<Project />",
    "tests/App.Tests/App.Tests.csproj": "<Project />",
  });
  const plan = planFiles(dir, { templates });
  assert.equal(plan.inputs.dotnet, "App.slnx");
  assert.equal(file(plan, PROPS).action, "create");
  assert.deepEqual(writeFiles(dir, plan), [CALLER, DEPENDABOT, PROPS]);
  assert.ok(templates.props.equals(readFileSync(join(dir, PROPS))));
  assert.equal(file(planFiles(dir, { templates }), PROPS).action, "keep");
  writeFileSync(join(dir, PROPS), "<Project></Project>\n");
  const drift = file(planFiles(dir, { templates }), PROPS);
  assert.equal(drift.action, "drift");
  assert.match(drift.detail, /differs from templates\/Directory\.Build\.props/);
});

test("an existing caller is kept when its inputs mean the same, and reported per input when not", () => {
  const same = { node: "./web", dotnet: ".", "dotnet-os": "ubuntu-latest", "dotnet-ef-project": "" };
  const dir = repo({
    [CALLER]: renderCaller(templates.caller, same),
    "web/package.json": PKG,
    "App.slnx": "",
    "src/App/App.csproj": "<Project />",
  });
  assert.equal(file(planFiles(dir, { templates }), CALLER).action, "keep");
  writeFileSync(join(dir, "src/App/App.csproj"), `<Project>${EF}</Project>`);
  const drift = file(planFiles(dir, { templates }), CALLER);
  assert.equal(drift.action, "drift");
  assert.match(drift.detail, /^dotnet-ef-project is "", the files say "src\/App"$/);
});

test("a hand-edited caller (a11y in warn, an extra address) is never overwritten", () => {
  const text = renderCaller(templates.caller, {
    node: ".",
    dotnet: "",
    "dotnet-os": "ubuntu-latest",
    "dotnet-ef-project": "",
  })
    .replace('a11y: "off"', 'a11y: "warn"')
    .replace(/(dotnet-ef-project: ""[^\n]*\n)/, "$1      allowed-emails: x@users.noreply.github.com\n");
  const dir = repo({ [CALLER]: text, "package.json": PKG });
  const plan = planFiles(dir, { templates });
  assert.equal(file(plan, CALLER).action, "keep");
  assert.deepEqual(writeFiles(dir, plan), [DEPENDABOT]);
  assert.equal(readFileSync(join(dir, CALLER), "utf8"), text);
});

test("a caller that does not call Ward, and a dependabot.yml missing a block, are drift", () => {
  const dir = repo({
    [CALLER]: "name: Ward\non: [push]\njobs:\n  x:\n    runs-on: ubuntu-latest\n",
    [DEPENDABOT]: "version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n",
    "package.json": PKG,
    "App.slnx": "",
    "src/App/App.csproj": "<Project />",
  });
  const plan = planFiles(dir, { templates });
  assert.match(file(plan, CALLER).detail, /does not call malinfossum\/ward/);
  assert.equal(file(plan, DEPENDABOT).action, "drift");
  assert.equal(file(plan, DEPENDABOT).detail, "no block for npm at /, nuget at /");
});

test("missing scripts are added in the file's own indentation; test is asked for, never guessed", () => {
  const pkg = [
    "{",
    '\t"name": "x",',
    '\t"scripts": {',
    '\t\t"lint": "biome ci ."',
    "\t},",
    '\t"devDependencies": {',
    '\t\t"@biomejs/biome": "2.5.15",',
    '\t\t"typescript": "7.0.2"',
    "\t}",
    "}",
    "",
  ].join("\n");
  const dir = repo({ "package.json": pkg, "tsconfig.json": "{}", "wrangler.jsonc": "{}" });
  const plan = planFiles(dir, { templates });
  const edit = plan.files.find((f) => f.action === "edit");
  assert.equal(edit.detail, "scripts: typecheck, deploy:check");
  assert.match(edit.content, /^\t\t"typecheck": "tsc --noEmit",$/m);
  assert.match(edit.content, /^\t\t"deploy:check": "wrangler deploy --dry-run"$/m);
  assert.ok(plan.files.some((f) => f.action === "ask" && /"test" script/.test(f.detail)));
  assert.deepEqual(plan.notes, ["deploy:check runs wrangler: add wrangler as a devDependency first."]);
  writeFiles(dir, plan);
  const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(written.scripts), ["lint", "typecheck", "deploy:check"]);
});

test("an Astro repo gets astro check; a repo without Biome gets lint and a note", () => {
  const manifest = { name: "x", scripts: { test: "vitest run" }, dependencies: { astro: "7.3.5" } };
  const dir = repo({ "package.json": JSON.stringify(manifest), "astro.config.mjs": "" });
  const plan = planFiles(dir, { templates });
  const edit = plan.files.find((f) => f.action === "edit");
  assert.equal(edit.detail, "scripts: lint, typecheck");
  assert.match(edit.content, /"typecheck": "astro check"/);
  assert.match(edit.content, /"lint": "biome ci \."/);
  assert.match(plan.notes[0], /^lint runs Biome: add @biomejs\/biome/);
});

test("the files command prints the plan and writes only with --apply; a stop writes nothing", async () => {
  const dir = repo({ "package.json": PKG });
  const dry = await runApply(["files", "--dir", dir], {}, { templates });
  assert.equal(dry.exitCode, 0);
  assert.ok(dry.lines[0].startsWith('inputs  node="." dotnet=""'));
  assert.ok(dry.lines.includes(`create  ${CALLER}`));
  assert.ok(!existsSync(join(dir, CALLER)));
  const wet = await runApply(["files", "--dir", dir, "--apply"], {}, { templates });
  assert.ok(wet.lines.includes(`wrote   ${CALLER}`));
  assert.ok(existsSync(join(dir, CALLER)));
  const tied = repo({ "a/package.json": PKG, "b/package.json": PKG, "pyproject.toml": "" });
  const tie = await runApply(["files", "--dir", tied, "--apply"], {}, { templates });
  assert.equal(tie.exitCode, 1);
  assert.ok(tie.lines.some((l) => l.startsWith("stop    More than one package.json")));
  assert.ok(tie.lines.some((l) => l.startsWith("warn    python files found")));
  assert.ok(!existsSync(join(tied, CALLER)));
  const broken = await runApply(["files", "--dir", repo({ "package.json": "{" })], {}, { templates });
  assert.equal(broken.exitCode, 1);
  assert.ok(broken.lines.some((l) => l.startsWith("stop    package.json is not valid JSON")));
  const gone = await runApply(["files", "--dir", join(tmpdir(), "ward-no-such-dir")], {}, { templates });
  assert.equal(gone.exitCode, 1);
  assert.ok(gone.lines[0].startsWith("stop"));
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tools/apply.test.mjs`
Expected: FAIL, `planFiles` (and the other new names) are not exported.

- [ ] **Step 3: Implement the file side and the command**

In `tools/apply.mjs`, replace the import block with:

```js
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planSteps } from "./node-contract.mjs";
import { parseCaller } from "./repo-audit.mjs";
import { detectStacks, ignored, loadStacks } from "./stacks.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CALLER = ".github/workflows/ward.yml";
export const DEPENDABOT = ".github/dependabot.yml";
export const PROPS = "Directory.Build.props";
const DEFAULTS = { node: "", dotnet: "", "dotnet-os": "ubuntu-latest", "dotnet-ef-project": "" };
```

Append after `renderDependabot`:

```js
export function readTemplates(root = ROOT) {
  return {
    caller: readFileSync(join(root, "templates", "ward.yml"), "utf8"),
    dependabot: readFileSync(join(root, "templates", "dependabot.yml"), "utf8"),
    props: readFileSync(join(root, "templates", PROPS)),
  };
}

// Every file under dir as a repo-relative path with forward slashes, minus
// the prefixes stack detection ignores (node_modules, bin, obj, .git).
export function listTree(dir, stacks) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .filter((path) => !ignored(path, stacks.ignore))
    .sort();
}

const SCRIPT_FOR = {
  lint: () => "biome ci .",
  typecheck: (deps) => ("astro" in deps ? "astro check" : "tsc --noEmit"),
  "deploy:check": () => "wrangler deploy --dry-run",
};

// The scripts the node contract requires and package.json lacks, with the
// standard command for each. test is never guessed: the runner is mine to
// pick. A note names the package a script needs; nothing is installed here.
export function missingScripts(pkg, files) {
  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const { missing } = planSteps({ scripts, files, a11y: "off", hasPlaywright: false });
  const add = {};
  const ask = [];
  const notes = [];
  for (const name of missing) {
    if (SCRIPT_FOR[name]) add[name] = SCRIPT_FOR[name](deps);
    else ask.push(name);
  }
  if (add.lint && !("@biomejs/biome" in deps)) {
    notes.push("lint runs Biome: add @biomejs/biome as a devDependency and a biome.json first.");
  }
  if (add.typecheck === "tsc --noEmit" && !("typescript" in deps)) {
    notes.push("typecheck runs tsc: add typescript as a devDependency first.");
  }
  if (add["deploy:check"] && !("wrangler" in deps)) {
    notes.push("deploy:check runs wrangler: add wrangler as a devDependency first.");
  }
  return { add, ask, notes };
}

// package.json with the scripts added, in the file's own indentation.
export function withScripts(text, add) {
  const pkg = JSON.parse(text);
  pkg.scripts = { ...(pkg.scripts ?? {}), ...add };
  const indent = text.match(/^(\t| +)"/m)?.[1] ?? "  ";
  return `${JSON.stringify(pkg, null, indent)}\n`;
}

// `./web`, `web` and `web/` are one directory; `./` alone is the root.
const bare = (value) => (value ?? "").replace(/^\.\//, "").replace(/\/$/, "") || ".";
const sameDir = (a, b) => bare(a.replace(/^\//, "")) === bare(b.replace(/^\//, ""));

// `dotnet: "."` next to a planned `App.slnx` at the root is the same choice.
function sameInput(key, current, planned) {
  if (key === "dotnet-os") return (current || DEFAULTS[key]) === planned;
  if (!current && !planned) return true;
  if (!current || !planned) return false;
  if (bare(current) === bare(planned)) return true;
  return key === "dotnet" && bare(current) === bare(dirOf(planned));
}

function planCaller(text, inputs, template) {
  if (text == null) return { path: CALLER, action: "create", content: renderCaller(template, inputs) };
  const current = parseCaller(text);
  if (!current) {
    const detail = "does not call malinfossum/ward/.github/workflows/ci.yml@v1";
    return { path: CALLER, action: "drift", detail };
  }
  const drift = Object.keys(DEFAULTS)
    .filter((key) => !sameInput(key, current.inputs[key], inputs[key]))
    .map((key) => `${key} is "${current.inputs[key] ?? DEFAULTS[key]}", the files say "${inputs[key]}"`);
  if (drift.length) return { path: CALLER, action: "drift", detail: drift.join("; ") };
  return { path: CALLER, action: "keep" };
}

function planDependabot(text, ecosystems, template) {
  if (text == null) {
    return { path: DEPENDABOT, action: "create", content: renderDependabot(template, ecosystems) };
  }
  const have = [];
  for (const line of text.split("\n")) {
    const eco = line.match(/^\s*-\s*package-ecosystem:\s*"?([\w-]+)/);
    const dir = line.match(/^\s*directory:\s*"?([^"\s#]+)/);
    if (eco) have.push({ ecosystem: eco[1], directory: "/" });
    else if (dir && have.length) have[have.length - 1].directory = dir[1];
  }
  const missing = ecosystems.filter(
    (e) => !have.some((h) => h.ecosystem === e.ecosystem && sameDir(h.directory, e.directory)),
  );
  if (!missing.length) return { path: DEPENDABOT, action: "keep" };
  const detail = `no block for ${missing.map((e) => `${e.ecosystem} at ${e.directory}`).join(", ")}`;
  return { path: DEPENDABOT, action: "drift", detail };
}

// What the repo at dir should carry, and what it carries today. Nothing here
// overwrites: a file that exists and differs is drift for me to settle by
// hand, so a hand edit (a co-owner's address, a11y in warn) survives a rerun.
export function planFiles(dir, { stacks = loadStacks(), templates = readTemplates() } = {}) {
  const paths = listTree(dir, stacks);
  const read = (path) => (paths.includes(path) ? readFileSync(join(dir, path), "utf8") : null);
  const csproj = Object.fromEntries(
    paths.filter((p) => p.endsWith(".csproj")).map((p) => [p, read(p)]),
  );
  const { inputs, ecosystems, uncovered, stops } = planInputs(paths, csproj, stacks);
  const files = [];
  const notes = [];
  files.push(planCaller(read(CALLER), inputs, templates.caller));
  files.push(planDependabot(read(DEPENDABOT), ecosystems, templates.dependabot));
  if (inputs.dotnet) {
    if (!paths.includes(PROPS)) {
      files.push({ path: PROPS, action: "create", content: templates.props });
    } else if (templates.props.equals(readFileSync(join(dir, PROPS)))) {
      files.push({ path: PROPS, action: "keep" });
    } else {
      files.push({ path: PROPS, action: "drift", detail: `differs from templates/${PROPS}` });
    }
  }
  if (inputs.node) {
    const manifest = inputs.node === "." ? "package.json" : `${inputs.node}/package.json`;
    const text = read(manifest);
    let pkg = null;
    try {
      pkg = JSON.parse(text);
    } catch {
      stops.push(`${manifest} is not valid JSON.`);
    }
    if (pkg) {
      const siblings = paths
        .filter((p) => dirOf(p) === inputs.node)
        .map((p) => p.slice(p.lastIndexOf("/") + 1));
      const { add, ask, notes: scriptNotes } = missingScripts(pkg, siblings);
      notes.push(...scriptNotes);
      const names = Object.keys(add);
      if (names.length) {
        const detail = `scripts: ${names.join(", ")}`;
        files.push({ path: manifest, action: "edit", detail, content: withScripts(text, add) });
      }
      for (const name of ask) {
        const detail = `add a "${name}" script; the runner is yours to choose`;
        files.push({ path: manifest, action: "ask", detail });
      }
      if (!names.length && !ask.length) files.push({ path: manifest, action: "keep" });
    }
  }
  return { inputs, ecosystems, uncovered, stops, files, notes };
}

// Writes the create and edit actions under dir; returns the paths written.
export function writeFiles(dir, plan) {
  const written = [];
  for (const file of plan.files) {
    if (file.action !== "create" && file.action !== "edit") continue;
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    written.push(file.path);
  }
  return written;
}

const say = (word, text) => `${word.padEnd(7)} ${text}`;
const arg = (argv, flag, fallback = "") => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

function filesCommand(argv, { stacks, templates }) {
  const dir = arg(argv, "--dir", ".");
  if (!existsSync(dir)) return { lines: [say("stop", `${dir} is not a directory I can read.`)], exitCode: 1 };
  const plan = planFiles(dir, { stacks, templates });
  const lines = [];
  const shown = Object.entries(plan.inputs).map(([key, value]) => `${key}="${value}"`);
  lines.push(say("inputs", shown.join(" ")));
  for (const name of plan.uncovered) {
    const text = `${name} files found, but no Ward module covers them yet; draft the module as a PR to Ward.`;
    lines.push(say("warn", text));
  }
  for (const stop of plan.stops) lines.push(say("stop", stop));
  for (const file of plan.files) {
    lines.push(say(file.action, file.detail ? `${file.path}: ${file.detail}` : file.path));
  }
  for (const note of plan.notes) lines.push(say("note", note));
  if (plan.stops.length) return { lines, exitCode: 1 };
  if (argv.includes("--apply")) {
    for (const path of writeFiles(dir, plan)) lines.push(say("wrote", path));
  }
  return { lines, exitCode: 0 };
}

export const USAGE = [
  "node tools/apply.mjs files [--dir <repo>] [--apply]",
  "node tools/apply.mjs settings|ruleset|automerge|status <owner/repo> [--apply] [--bypass-admin] [--no-codeql]",
  "Settings commands read GITHUB_TOKEN (locally: GITHUB_TOKEN=$(gh auth token)).",
].join("\n");

// deps lets the tests pass their own stacks and templates.
export async function runApply(argv, env, deps = {}) {
  const [command, ...rest] = argv;
  const stacks = deps.stacks ?? loadStacks();
  const templates = deps.templates ?? readTemplates();
  if (command === "files") return filesCommand(rest, { stacks, templates });
  return { lines: [say("usage", USAGE)], exitCode: 1 };
}

async function main() {
  const { lines, exitCode } = await runApply(process.argv.slice(2), process.env);
  for (const line of lines) console.log(line);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

`wrote` is one more output word; it joins the list in the Global Constraints and in `docs/apply.md` (Task 5).

- [ ] **Step 4: Run the tests and the linter**

Run: `node --test tools/apply.test.mjs && npm run lint`
Expected: PASS, 11 + 8 = 19 tests; lint clean. If Biome reformats long lines from Step 3, accept its formatting (`npx biome format --write tools/apply.mjs tools/apply.test.mjs`), rerun the tests and continue.

- [ ] **Step 5: Try it on real clones, read-only**

Run: `node tools/apply.mjs files --dir ../kenaz; node tools/apply.mjs files --dir ../tidsro; node tools/apply.mjs files --dir ../varde`
Expected: kenaz `inputs  node="Kenaz.Web" dotnet="Kenaz.slnx" ...` with `keep` for the caller, the Dependabot config, `Directory.Build.props` and `Kenaz.Web/package.json`; tidsro `dotnet-os="windows-latest"`; varde a `dotnet-ef-project` that matches its caller. A `drift` line that names a real difference from what Plan 5 wrote by hand goes in the task report; the clones are not changed.

- [ ] **Step 6: Commit**

```bash
git add tools/apply.mjs tools/apply.test.mjs
git commit -m "apply: write the caller, Dependabot config, props and missing scripts, never over a file that exists"
```

---
### Task 3: Reading a repo's state, the `settings` and `status` commands

**Files:**
- Modify: `tools/repo-audit.mjs` (`request`, around line 493), `tools/apply.mjs`, `tools/apply.test.mjs`

**Interfaces:**
- Consumes: `request`, `fetchRepoData`, `REQUIRED_CHECK` from `tools/repo-audit.mjs`.
- Produces: `request(path, token, { method = "GET", body } = {})` (a JSON body is sent with `Content-Type: application/json`; the silent statuses and the throw rule are unchanged); `readState(repo, token) → Promise<{ repo, meta, branch, baseline, classic, rulesets, existing, analysed, dependabotPulls }>`; `planSettings(baseline) → { stops, actions: { what, method, path, body? }[], notes }`; `statusLine(state) → string`; `runApply` handles `settings <repo> [--apply]` and `status <repo>`. Task 4 reuses `readState` and the command plumbing.

- [ ] **Step 1: Write the failing tests**

Append to `tools/apply.test.mjs` (extend the `./apply.mjs` import with `planSettings, readState, statusLine` and add `import { request } from "./repo-audit.mjs";`, merging it with the existing `parseCaller` import):

```js
// A fetch stub that records method, path, auth and the parsed body of every
// call, and answers from routes [pattern, status, body, method?]; first match
// wins, and a route with a method answers only that method.
function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push({
      method: init.method ?? "GET",
      path,
      auth: init.headers?.Authorization ?? "",
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const method = init.method ?? "GET";
    const route = routes.find(([pattern, , , only]) => pattern.test(path) && (!only || only === method));
    if (!route) return new Response(null, { status: 599 });
    const [, status, body] = route;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return {
    calls,
    writes: () => calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path]),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const OFF = { status: "disabled" };
const ON = { status: "enabled" };
const META = {
  full_name: "malinfossum/x",
  default_branch: "main",
  allow_auto_merge: false,
  security_and_analysis: { secret_scanning: OFF, secret_scanning_push_protection: OFF },
};
const GATE = {
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: false,
    required_status_checks: [{ context: "ward / gate" }],
  },
};
// A bare repo: nothing on, no ruleset, CodeQL never ran. Overrides go first.
const bareRoutes = (overrides = []) => [
  ...overrides,
  [/^\/repos\/malinfossum\/x$/, 200, META],
  [/\/git\/trees\/main/, 200, { truncated: false, tree: [] }],
  [/\/contents\//, 404],
  [/\/rules\/branches\/main$/, 200, []],
  [/\/automated-security-fixes$/, 404],
  [/\/vulnerability-alerts$/, 404],
  [/\/code-scanning\/default-setup$/, 200, { state: "not-configured", languages: ["javascript"] }],
  [/\/branches\/main\/protection$/, 404],
  [/\/rulesets$/, 200, []],
  [/\/code-scanning\/analyses/, 404],
  [/\/pulls\?/, 200, []],
];
const ENV = { GITHUB_TOKEN: "t" };

test("request sends a JSON body with the method and the token", async () => {
  const stub = stubFetch([[/./, 200, { ok: true }]]);
  try {
    const res = await request("/repos/a/b", "t", { method: "PATCH", body: { x: 1 } });
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    assert.deepEqual(stub.calls[0], { method: "PATCH", path: "/repos/a/b", auth: "Bearer t", body: { x: 1 } });
  } finally {
    stub.restore();
  }
});

test("settings: plans the four changes a bare repo needs and makes them only with --apply", async () => {
  const stub = stubFetch(bareRoutes());
  try {
    const dry = await runApply(["settings", "malinfossum/x"], ENV);
    assert.equal(dry.exitCode, 0);
    assert.deepEqual(
      dry.lines.filter((l) => l.startsWith("set")).map((l) => l.slice(8)),
      [
        "Dependabot alerts on",
        "Dependabot security updates on",
        "secret scanning and push protection on",
        "CodeQL default setup on",
      ],
    );
    assert.deepEqual(stub.writes(), []);
    const wet = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.deepEqual(stub.writes(), [
      ["PUT", "/repos/malinfossum/x/vulnerability-alerts"],
      ["PUT", "/repos/malinfossum/x/automated-security-fixes"],
      ["PATCH", "/repos/malinfossum/x"],
      ["PATCH", "/repos/malinfossum/x/code-scanning/default-setup"],
    ]);
    const patches = stub.calls.filter((c) => c.method === "PATCH").map((c) => c.body);
    assert.deepEqual(patches[0], {
      security_and_analysis: { secret_scanning: ON, secret_scanning_push_protection: ON },
    });
    assert.deepEqual(patches[1], { state: "configured", query_suite: "default" });
    assert.equal(wet.lines.filter((l) => l.startsWith("done")).length, 4);
    assert.ok(stub.calls.every((c) => c.auth === "Bearer t"));
  } finally {
    stub.restore();
  }
});

test("settings: everything on is kept; a setting the token cannot read is a stop, never a blind write", async () => {
  const onMeta = { ...META, security_and_analysis: { secret_scanning: ON, secret_scanning_push_protection: ON } };
  const stub = stubFetch(
    bareRoutes([
      [/^\/repos\/malinfossum\/x$/, 200, onMeta],
      [/\/automated-security-fixes$/, 200, { enabled: true, paused: false }],
      [/\/vulnerability-alerts$/, 204],
      [/\/code-scanning\/default-setup$/, 200, { state: "configured", languages: ["javascript"] }],
    ]),
  );
  try {
    const kept = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.ok(kept.lines.includes("keep    every setting is already on"));
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
  const { security_and_analysis: _, ...notAdmin } = META;
  const blind = stubFetch(bareRoutes([[/^\/repos\/malinfossum\/x$/, 200, notAdmin]]));
  try {
    const stop = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(stop.exitCode, 1);
    assert.ok(stop.lines.some((l) => l.startsWith("stop    The token cannot read this repo's settings")));
    assert.deepEqual(blind.writes(), []);
  } finally {
    blind.restore();
  }
});

test("settings: an API failure mid-apply keeps the lines before it and stops", async () => {
  const stub = stubFetch(bareRoutes([[/^\/repos\/malinfossum\/x$/, 422, { message: "nope" }, "PATCH"]]));
  try {
    const { lines, exitCode } = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(exitCode, 1);
    assert.deepEqual(
      lines.filter((l) => /^(done|error)/.test(l)),
      [
        "done    Dependabot alerts on",
        "done    Dependabot security updates on",
        'error   GitHub API 422 on /repos/malinfossum/x: {"message":"nope"}',
      ],
    );
    assert.equal(stub.writes().length, 3);
  } finally {
    stub.restore();
  }
});

test("settings: a repo with no CodeQL language gets a note instead of a CodeQL action", () => {
  const baseline = {
    alerts: true,
    securityUpdates: { enabled: true, paused: false },
    analysis: { secret_scanning: ON, secret_scanning_push_protection: ON },
    codeScanning: { state: "not-configured", languages: [] },
  };
  const plan = planSettings(baseline);
  assert.deepEqual(plan.actions, []);
  assert.match(plan.notes[0], /CodeQL has no language to analyse here/);
});

test("settings and status without a token or with a bad repo name are a stop", async () => {
  const noToken = await runApply(["settings", "malinfossum/x"], {});
  assert.equal(noToken.exitCode, 1);
  assert.ok(noToken.lines.some((l) => /GITHUB_TOKEN is not set/.test(l)));
  const badName = await runApply(["status", "x"], ENV);
  assert.equal(badName.exitCode, 1);
  assert.ok(badName.lines[0].startsWith("usage"));
});

test("status prints one line with the state, and readState sees classic protection and open Dependabot PRs", async () => {
  const stub = stubFetch(
    bareRoutes([
      [/\/branches\/main\/protection$/, 200, { enabled: true }],
      [/\/pulls\?/, 200, [{ number: 7, user: { login: "dependabot[bot]" } }, { number: 8, user: { login: "me" } }]],
      [/\/rules\/branches\/main$/, 200, [{ type: "deletion" }, GATE]],
    ]),
  );
  try {
    const state = await readState("malinfossum/x", "t");
    assert.equal(state.classic, true);
    assert.deepEqual(state.dependabotPulls, [7]);
    assert.equal(state.analysed, false);
    assert.equal(
      statusLine(state),
      "malinfossum/x: auto-merge=false secret-scanning=disabled push-protection=disabled codeql=not-configured analysed=false rulesets=0+classic rules=deletion,required_status_checks",
    );
    const { lines } = await runApply(["status", "malinfossum/x"], ENV);
    assert.equal(lines[0], statusLine(state));
  } finally {
    stub.restore();
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tools/apply.test.mjs`
Expected: FAIL. `request` ignores the options (the first test's `method` is `GET`), `readState` and the others are not exported.

- [ ] **Step 3: Teach `request` to write**

In `tools/repo-audit.mjs`, replace the `request` function (keep its comment, add one sentence) with:

```js
// Status plus parsed body. 401, 403 and 404 come back as a status with a null
// body, because for the settings endpoints they mean "cannot read" or "off",
// which the checks decide. Anything else 4xx or 5xx is a real failure. A
// method and a JSON body are what apply.mjs needs to change a setting.
export async function request(path, token, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ward-repo-audit",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const silent = res.status === 204 || [401, 403, 404].includes(res.status);
  if (res.status >= 400 && !silent) {
    // The API says why (a validation message on a 422); the first line of it
    // is the difference between a rerun and a search.
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`GitHub API ${res.status} on ${path}${detail ? `: ${detail}` : ""}`);
  }
  return { status: res.status, body: silent ? null : await res.json() };
}
```

Run `node --test tools/repo-audit.test.mjs` to confirm the audit's own tests still pass (56 tests, 1 skipped without a token). The audit's error stubs answer with no body, so every pinned `GitHub API 500` message is unchanged.

- [ ] **Step 4: Implement `readState`, `planSettings`, `statusLine` and the two commands**

In `tools/apply.mjs`, change the `./repo-audit.mjs` import to `import { fetchRepoData, parseCaller, REQUIRED_CHECK, request } from "./repo-audit.mjs";` (`REQUIRED_CHECK` is used in Task 4). Insert before `const say = ...`:

```js
// Everything the settings commands decide on, read with one token that has
// admin on the repo (locally, gh auth token). The baseline comes from the
// same reads the audit makes, so what apply sets is what the audit checks.
export async function readState(repo, token) {
  const meta = (await request(`/repos/${repo}`, token)).body;
  if (!meta) throw new Error(`Cannot read ${repo}; the token must be allowed to see it.`);
  const data = await fetchRepoData(meta, { admin: token, read: token });
  const branch = encodeURIComponent(meta.default_branch);
  const at = (path) => request(`/repos/${repo}${path}`, token);
  const classic = (await at(`/branches/${branch}/protection`)).status === 200;
  const listed = await at("/rulesets");
  const rulesets = (listed.body ?? []).filter((r) => r.target === "branch");
  const existing = rulesets.length === 1 ? (await at(`/rulesets/${rulesets[0].id}`)).body : null;
  const analyses = (await at(`/code-scanning/analyses?ref=refs/heads/${branch}&per_page=1`)).body;
  const pulls = (await at("/pulls?state=open&per_page=100")).body ?? [];
  return {
    repo,
    meta,
    branch: meta.default_branch,
    baseline: data.baseline,
    classic,
    rulesetsRead: listed.status === 200,
    rulesets,
    existing,
    analysed: Array.isArray(analyses) && analyses.length > 0,
    dependabotPulls: pulls.filter((p) => p.user?.login === "dependabot[bot]").map((p) => p.number),
  };
}

// The settings a repo still needs, from the baseline the audit reads. A
// field the token could not read is a stop, never a blind write: the write
// would fail for the same reason, and a silent retry would hide it.
export function planSettings(baseline) {
  const { alerts, securityUpdates, analysis, codeScanning } = baseline;
  if ([alerts, securityUpdates, analysis, codeScanning].some((value) => value == null)) {
    const stop = "The token cannot read this repo's settings; it needs admin on the repo.";
    return { stops: [stop], actions: [], notes: [] };
  }
  const actions = [];
  const notes = [];
  if (!alerts) actions.push({ what: "Dependabot alerts on", method: "PUT", path: "/vulnerability-alerts" });
  if (!securityUpdates.enabled || securityUpdates.paused) {
    actions.push({ what: "Dependabot security updates on", method: "PUT", path: "/automated-security-fixes" });
  }
  const on = { status: "enabled" };
  if (
    analysis.secret_scanning?.status !== "enabled" ||
    analysis.secret_scanning_push_protection?.status !== "enabled"
  ) {
    actions.push({
      what: "secret scanning and push protection on",
      method: "PATCH",
      path: "",
      body: { security_and_analysis: { secret_scanning: on, secret_scanning_push_protection: on } },
    });
  }
  if (codeScanning.state !== "configured") {
    // Same rule as checkBaseline: no languages means CodeQL cannot be turned on here.
    const analysable = codeScanning.languages ? codeScanning.languages.length > 0 : true;
    if (analysable) {
      actions.push({
        what: "CodeQL default setup on",
        method: "PATCH",
        path: "/code-scanning/default-setup",
        body: { state: "configured", query_suite: "default" },
      });
    } else {
      notes.push(
        "CodeQL has no language to analyse here; the ruleset needs --no-codeql and a dated ruleset exception in stacks.json.",
      );
    }
  }
  return { stops: [], actions, notes };
}

export function statusLine(state) {
  const analysis = state.baseline.analysis ?? {};
  const types = (state.baseline.rules ?? []).map((rule) => rule.type).sort();
  return [
    `${state.repo}:`,
    `auto-merge=${state.meta.allow_auto_merge}`,
    `secret-scanning=${analysis.secret_scanning?.status ?? "unread"}`,
    `push-protection=${analysis.secret_scanning_push_protection?.status ?? "unread"}`,
    `codeql=${state.baseline.codeScanning?.state ?? "unread"}`,
    `analysed=${state.analysed}`,
    `rulesets=${state.rulesets.length}${state.classic ? "+classic" : ""}`,
    `rules=${types.join(",") || "none"}`,
  ].join(" ");
}

async function settingsCommand(state, argv, token) {
  const { stops, actions, notes } = planSettings(state.baseline);
  const lines = stops.map((stop) => say("stop", stop));
  for (const action of actions) lines.push(say("set", action.what));
  for (const note of notes) lines.push(say("note", note));
  if (stops.length) return { lines, exitCode: 1 };
  if (!actions.length) lines.push(say("keep", "every setting is already on"));
  if (argv.includes("--apply")) {
    for (const action of actions) {
      const call = () =>
        request(`/repos/${state.repo}${action.path}`, token, {
          method: action.method,
          body: action.body,
        });
      if (!(await attempt(lines, call, action.what))) return { lines, exitCode: 1 };
    }
  }
  return { lines, exitCode: 0 };
}

// One write, with its done line or its error line. A failure mid-apply keeps
// the lines before it and stops; a rerun is idempotent, so nothing is lost.
async function attempt(lines, call, done) {
  try {
    const res = await call();
    lines.push(say("done", typeof done === "function" ? done(res) : done));
    return true;
  } catch (error) {
    lines.push(say("error", error.message));
    return false;
  }
}
```

Replace `runApply` with:

```js
const SETTINGS_COMMANDS = ["settings", "ruleset", "automerge", "status"];
const REPO = /^[\w.-]+\/[\w.-]+$/;

// deps lets the tests pass their own stacks and templates.
export async function runApply(argv, env, deps = {}) {
  const [command, ...rest] = argv;
  const stacks = deps.stacks ?? loadStacks();
  const templates = deps.templates ?? readTemplates();
  if (command === "files") return filesCommand(rest, { stacks, templates });
  if (!SETTINGS_COMMANDS.includes(command) || !REPO.test(rest[0] ?? "")) {
    return { lines: [say("usage", USAGE)], exitCode: 1 };
  }
  const token = env.GITHUB_TOKEN || "";
  if (!token) {
    const stop = "GITHUB_TOKEN is not set; run with GITHUB_TOKEN=$(gh auth token).";
    return { lines: [say("stop", stop)], exitCode: 1 };
  }
  try {
    const state = await readState(rest[0], token);
    if (command === "status") return { lines: [statusLine(state)], exitCode: 0 };
    if (command === "settings") return await settingsCommand(state, rest, token);
    return { lines: [say("usage", USAGE)], exitCode: 1 };
  } catch (error) {
    return { lines: [say("error", error.message)], exitCode: 1 };
  }
}
```

- [ ] **Step 5: Run the tests and the linter**

Run: `npm test && npm run lint`
Expected: PASS, 172 + 19 + 7 = 198 tests (1 skipped); lint clean.

- [ ] **Step 6: Read a real repo, change nothing**

Run: `GITHUB_TOKEN=$(gh auth token) node tools/apply.mjs status malinfossum/kenaz && GITHUB_TOKEN=$(gh auth token) node tools/apply.mjs settings malinfossum/kenaz`
Expected: a status line with `auto-merge=true secret-scanning=enabled push-protection=enabled codeql=configured analysed=true rulesets=1 rules=code_scanning,deletion,non_fast_forward,pull_request,required_status_checks`, then `keep    every setting is already on`. No `--apply`, so nothing changes.

- [ ] **Step 7: Commit**

```bash
git add tools/apply.mjs tools/apply.test.mjs tools/repo-audit.mjs
git commit -m "apply: read a repo's settings through the audit's reads and set what is off, only with --apply"
```

---

### Task 4: The ruleset and auto-merge, in the only safe order

**Files:**
- Modify: `tools/repo-audit.mjs` (export `requiredChecksFrom`), `tools/apply.mjs`, `tools/apply.test.mjs`

**Interfaces:**
- Consumes: `readState`, `say`, `request`, `REQUIRED_CHECK` (Task 3); `templates/ruleset.json`.
- Produces: `mergeRuleset(template, existing, { bypassAdmin, noCodeql }) → body`; `sameRuleset(existing, body) → boolean`; `planRuleset(state, template, opts) → { stops, wait, action: "" | "create" | "update" | "keep", body }`; `planAutomerge(state) → { stops, enable, rebase: number[] }`; `runApply` handles `ruleset <repo> [--apply] [--bypass-admin] [--no-codeql]` and `automerge <repo> [--apply]`. `readTemplates` gains `ruleset` (parsed JSON).

- [ ] **Step 1: Write the failing tests**

Append to `tools/apply.test.mjs` (extend the `./apply.mjs` import with `mergeRuleset, planAutomerge, planRuleset, sameRuleset`):

```js
const RULESET = JSON.parse(readFileSync("templates/ruleset.json", "utf8"));
const ADMIN = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
// What the API hands back for a ruleset apply created: ids, extra parameters, same rules.
const asExisting = (body, id = 42) => ({
  id,
  ...structuredClone(body),
  rules: body.rules.map((rule) =>
    rule.type === "pull_request"
      ? { ...rule, parameters: { ...rule.parameters, allowed_merge_methods: ["squash"] } }
      : rule,
  ),
});
const types = (body) => body.rules.map((rule) => rule.type);
const checks = (body) =>
  body.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks;

test("mergeRuleset keeps a repo's own required checks and foreign rule types beside the template", () => {
  const existing = {
    id: 1,
    rules: [
      { type: "required_linear_history" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "api-tests", integration_id: 15368 }],
        },
      },
    ],
  };
  const body = mergeRuleset(RULESET, existing);
  assert.deepEqual(types(body), [...types(RULESET), "required_linear_history"]);
  assert.deepEqual(checks(body), [{ context: "ward / gate" }, { context: "api-tests", integration_id: 15368 }]);
  assert.equal(body.rules.find((r) => r.type === "required_status_checks").parameters.strict_required_status_checks_policy, false);
  assert.deepEqual(body.bypass_actors, []);
  assert.deepEqual(types(mergeRuleset(RULESET, null, { noCodeql: true })), types(RULESET).filter((t) => t !== "code_scanning"));
  assert.deepEqual(mergeRuleset(RULESET, null, { bypassAdmin: true }).bypass_actors, ADMIN);
  assert.deepEqual(RULESET.bypass_actors, [], "the template was mutated");
});

test("sameRuleset ignores what the API adds and notices what I would change", () => {
  const body = mergeRuleset(RULESET, null);
  assert.equal(sameRuleset(asExisting(body), body), true);
  const withAdmin = mergeRuleset(RULESET, null, { bypassAdmin: true });
  assert.equal(sameRuleset(asExisting(body), withAdmin), false);
  const fewerChecks = asExisting(body);
  checks(fewerChecks).length = 0;
  assert.equal(sameRuleset(fewerChecks, body), false);
  const extraRule = asExisting(body);
  extraRule.rules.push({ type: "required_linear_history" });
  assert.equal(sameRuleset(extraRule, body), false);
  assert.equal(sameRuleset(extraRule, mergeRuleset(RULESET, extraRule)), true);
});

const state = (over = {}) => ({
  repo: "malinfossum/x",
  branch: "main",
  meta: { allow_auto_merge: false },
  baseline: { rules: [] },
  classic: false,
  rulesetsRead: true,
  rulesets: [],
  existing: null,
  analysed: true,
  dependabotPulls: [],
  ...over,
});

test("planRuleset: classic protection or two rulesets stop; no CodeQL analysis waits unless --no-codeql", () => {
  assert.match(planRuleset(state({ classic: true }), RULESET).stops[0], /Classic branch protection/);
  assert.match(planRuleset(state({ rulesetsRead: false }), RULESET).stops[0], /cannot list this repo's rulesets/);
  const two = planRuleset(state({ rulesets: [{ id: 1 }, { id: 2 }] }), RULESET);
  assert.match(two.stops[0], /More than one branch ruleset \(1, 2\)/);
  const waiting = planRuleset(state({ analysed: false }), RULESET);
  assert.match(waiting.wait, /CodeQL has not analysed main yet/);
  assert.equal(waiting.action, "");
  const noLanguage = state({ analysed: false, baseline: { rules: [], codeScanning: { languages: [] } } });
  assert.match(planRuleset(noLanguage, RULESET).wait, /never analyse it; rerun with --no-codeql/);
  const skipped = planRuleset(state({ analysed: false }), RULESET, { noCodeql: true });
  assert.equal(skipped.action, "create");
  assert.ok(!types(skipped.body).includes("code_scanning"));
});

test("planRuleset: create when none, keep when equal, update when it differs", () => {
  assert.equal(planRuleset(state(), RULESET).action, "create");
  const body = mergeRuleset(RULESET, null);
  const same = state({ rulesets: [{ id: 42 }], existing: asExisting(body) });
  assert.equal(planRuleset(same, RULESET).action, "keep");
  assert.equal(planRuleset(same, RULESET, { bypassAdmin: true }).action, "update");
});

test("ruleset command: POST when none, PUT by id when one, nothing without --apply or on wait", async () => {
  const stub = stubFetch(bareRoutes([[/\/code-scanning\/analyses/, 200, [{ id: 1 }]]]));
  try {
    const dry = await runApply(["ruleset", "malinfossum/x"], ENV);
    assert.ok(dry.lines[0].startsWith('create  ruleset "main" with deletion, non_fast_forward, pull_request, required_status_checks, code_scanning'));
    assert.deepEqual(stub.writes(), []);
    await runApply(["ruleset", "malinfossum/x", "--apply", "--bypass-admin"], ENV);
    assert.deepEqual(stub.writes(), [["POST", "/repos/malinfossum/x/rulesets"]]);
    assert.deepEqual(stub.calls.at(-1).body.bypass_actors, ADMIN);
  } finally {
    stub.restore();
  }
  const body = mergeRuleset(RULESET, null);
  const one = stubFetch(
    bareRoutes([
      [/\/code-scanning\/analyses/, 200, [{ id: 1 }]],
      [/\/rulesets$/, 200, [{ id: 42, target: "branch" }, { id: 43, target: "tag" }]],
      [/\/rulesets\/42$/, 200, asExisting(body)],
    ]),
  );
  try {
    const kept = await runApply(["ruleset", "malinfossum/x", "--apply"], ENV);
    assert.ok(kept.lines[0].startsWith("keep    ruleset"));
    assert.deepEqual(one.writes(), []);
    await runApply(["ruleset", "malinfossum/x", "--apply", "--no-codeql"], ENV);
    assert.deepEqual(one.writes(), [["PUT", "/repos/malinfossum/x/rulesets/42"]]);
  } finally {
    one.restore();
  }
  const waiting = stubFetch(bareRoutes());
  try {
    const wait = await runApply(["ruleset", "malinfossum/x", "--apply"], ENV);
    assert.equal(wait.exitCode, 1);
    assert.ok(wait.lines[0].startsWith("wait    CodeQL has not analysed main yet"));
    assert.deepEqual(waiting.writes(), []);
  } finally {
    waiting.restore();
  }
});

test("planAutomerge refuses until main requires ward / gate, then enables and rebases open Dependabot PRs", () => {
  const refused = planAutomerge(state());
  assert.match(refused.stops[0], /does not require "ward \/ gate"/);
  assert.equal(refused.enable, false);
  const ready = planAutomerge(state({ baseline: { rules: [GATE] }, dependabotPulls: [7, 9] }));
  assert.deepEqual(ready, { stops: [], enable: true, rebase: [7, 9] });
  const on = planAutomerge(
    state({ baseline: { rules: [GATE] }, meta: { allow_auto_merge: true }, dependabotPulls: [3] }),
  );
  assert.deepEqual(on, { stops: [], enable: false, rebase: [] });
});

test("automerge command: PATCH allow_auto_merge and one rebase comment per Dependabot PR, only with --apply", async () => {
  const stub = stubFetch(
    bareRoutes([
      [/\/rules\/branches\/main$/, 200, [GATE]],
      [/\/pulls\?/, 200, [{ number: 7, user: { login: "dependabot[bot]" } }]],
      [/\/issues\/7\/comments$/, 201, { id: 1 }],
    ]),
  );
  try {
    const dry = await runApply(["automerge", "malinfossum/x"], ENV);
    assert.ok(dry.lines.includes("set     allow auto-merge"));
    assert.ok(dry.lines.includes("rebase  #7"));
    assert.deepEqual(stub.writes(), []);
    await runApply(["automerge", "malinfossum/x", "--apply"], ENV);
    assert.deepEqual(stub.writes(), [
      ["PATCH", "/repos/malinfossum/x"],
      ["POST", "/repos/malinfossum/x/issues/7/comments"],
    ]);
    assert.deepEqual(stub.calls.at(-2).body, { allow_auto_merge: true });
    assert.deepEqual(stub.calls.at(-1).body, { body: "@dependabot rebase" });
  } finally {
    stub.restore();
  }
  const unguarded = stubFetch(bareRoutes());
  try {
    const stop = await runApply(["automerge", "malinfossum/x", "--apply"], ENV);
    assert.equal(stop.exitCode, 1);
    assert.ok(stop.lines[0].startsWith("stop    main does not require"));
    assert.deepEqual(unguarded.writes(), []);
  } finally {
    unguarded.restore();
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tools/apply.test.mjs`
Expected: FAIL, `mergeRuleset` and the others are not exported.

- [ ] **Step 3: Implement the ruleset and auto-merge side**

In `tools/repo-audit.mjs`, make `requiredChecksFrom` exported (`export function requiredChecksFrom(rules)`; it stays where it is). In `tools/apply.mjs`, import it (`fetchRepoData, parseCaller, REQUIRED_CHECK, request, requiredChecksFrom`), and add `ruleset: JSON.parse(readFileSync(join(root, "templates", "ruleset.json"), "utf8")),` to `readTemplates`. Insert before `const SETTINGS_COMMANDS`:

```js
// The template over what the repo has: a rule type the template does not
// know stays, and the repo's own required checks stay beside ward / gate
// (workbench's test jobs, varde's api-tests). The template is never mutated.
export function mergeRuleset(template, existing, { bypassAdmin = false, noCodeql = false } = {}) {
  const body = structuredClone(template);
  const have = new Set(body.rules.map((rule) => rule.type));
  for (const rule of existing?.rules ?? []) if (!have.has(rule.type)) body.rules.push(rule);
  const mine = body.rules.find((rule) => rule.type === "required_status_checks");
  const theirs = existing?.rules?.find((rule) => rule.type === "required_status_checks");
  for (const check of theirs?.parameters?.required_status_checks ?? []) {
    if (!mine.parameters.required_status_checks.some((c) => c.context === check.context)) {
      mine.parameters.required_status_checks.push(check);
    }
  }
  if (noCodeql) body.rules = body.rules.filter((rule) => rule.type !== "code_scanning");
  if (bypassAdmin) {
    body.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
  }
  return body;
}

// want is contained in have: every key I would send is there with my value;
// arrays match element for element in any order and must be the same length,
// so a dropped check or an extra rule is a difference.
function contains(want, have) {
  if (Array.isArray(want)) {
    return (
      Array.isArray(have) &&
      want.length === have.length &&
      want.every((w) => have.some((h) => contains(w, h)))
    );
  }
  if (want && typeof want === "object") {
    return (
      Boolean(have) &&
      typeof have === "object" &&
      Object.entries(want).every(([key, value]) => contains(value, have[key]))
    );
  }
  return want === have;
}

// The API returns more than it was sent (ids, links, parameters I did not
// set); the ruleset is the same when everything I would send is already there.
export function sameRuleset(existing, body) {
  const { enforcement, conditions, bypass_actors, rules } = body;
  return contains({ enforcement, conditions, bypass_actors, rules }, existing);
}

export function planRuleset(state, template, { bypassAdmin = false, noCodeql = false } = {}) {
  const stops = [];
  if (!state.rulesetsRead) stops.push("The token cannot list this repo's rulesets; it needs admin on the repo.");
  if (state.classic) stops.push("Classic branch protection is on; move it to a ruleset by hand first.");
  if (state.rulesets.length > 1) {
    const ids = state.rulesets.map((r) => r.id).join(", ");
    stops.push(`More than one branch ruleset (${ids}); keep one, delete the rest, rerun.`);
  }
  if (stops.length) return { stops, wait: "", action: "", body: null };
  if (!noCodeql && !state.analysed) {
    // A repo CodeQL has no language for never gets an analysis; waiting would never end.
    const none = state.baseline.codeScanning?.languages?.length === 0;
    const wait = none
      ? `CodeQL has no language to analyse on ${state.branch}, so it will never analyse it; rerun with --no-codeql and add a dated ruleset exception in stacks.json.`
      : `CodeQL has not analysed ${state.branch} yet, and a code-scanning rule before that blocks every merge; rerun in a few minutes (up to an hour on a first run).`;
    return { stops, wait, action: "", body: null };
  }
  const body = mergeRuleset(template, state.existing, { bypassAdmin, noCodeql });
  const action = !state.existing ? "create" : sameRuleset(state.existing, body) ? "keep" : "update";
  return { stops, wait: "", action, body };
}

async function rulesetCommand(state, argv, token, template) {
  const plan = planRuleset(state, template, {
    bypassAdmin: argv.includes("--bypass-admin"),
    noCodeql: argv.includes("--no-codeql"),
  });
  if (plan.stops.length) return { lines: plan.stops.map((s) => say("stop", s)), exitCode: 1 };
  if (plan.wait) return { lines: [say("wait", plan.wait)], exitCode: 1 };
  const bypass = plan.body.bypass_actors.length ? " (repository admin bypass)" : "";
  const what = `ruleset "${plan.body.name}" with ${plan.body.rules.map((r) => r.type).join(", ")}${bypass}`;
  const lines = [say(plan.action, what)];
  if (plan.action !== "keep" && argv.includes("--apply")) {
    const create = plan.action === "create";
    const path = create ? `/repos/${state.repo}/rulesets` : `/repos/${state.repo}/rulesets/${state.existing.id}`;
    const call = () => request(path, token, { method: create ? "POST" : "PUT", body: plan.body });
    const done = (res) => `ruleset ${res.body?.id ?? ""} ${plan.action}d`;
    if (!(await attempt(lines, call, done))) return { lines, exitCode: 1 };
  }
  return { lines, exitCode: 0 };
}

// Auto-merge on a repo whose default branch does not require the gate merges
// every Dependabot PR at once, so it is refused until the ruleset is there.
export function planAutomerge(state) {
  if (!requiredChecksFrom(state.baseline.rules ?? []).includes(REQUIRED_CHECK)) {
    const stop = `${state.branch} does not require "${REQUIRED_CHECK}", so auto-merge now would merge every Dependabot PR at once; run ruleset first.`;
    return { stops: [stop], enable: false, rebase: [] };
  }
  // The rebase nudge is for PRs that stalled before auto-merge existed; once it
  // is on, a rerun must not ask Dependabot to rebase every open PR again.
  const enable = !state.meta.allow_auto_merge;
  return { stops: [], enable, rebase: enable ? state.dependabotPulls : [] };
}

async function automergeCommand(state, argv, token) {
  const plan = planAutomerge(state);
  if (plan.stops.length) return { lines: plan.stops.map((s) => say("stop", s)), exitCode: 1 };
  const lines = [plan.enable ? say("set", "allow auto-merge") : say("keep", "auto-merge is already on")];
  for (const number of plan.rebase) lines.push(say("rebase", `#${number}`));
  if (argv.includes("--apply")) {
    if (plan.enable) {
      const call = () =>
        request(`/repos/${state.repo}`, token, { method: "PATCH", body: { allow_auto_merge: true } });
      if (!(await attempt(lines, call, "allow auto-merge"))) return { lines, exitCode: 1 };
    }
    for (const number of plan.rebase) {
      const call = () =>
        request(`/repos/${state.repo}/issues/${number}/comments`, token, {
          method: "POST",
          body: { body: "@dependabot rebase" },
        });
      if (!(await attempt(lines, call, `rebase asked on #${number}`))) return { lines, exitCode: 1 };
    }
  }
  return { lines, exitCode: 0 };
}
```

In `runApply`, replace the line `return { lines: [say("usage", USAGE)], exitCode: 1 };` inside the `try` with:

```js
    if (command === "ruleset") return await rulesetCommand(state, rest, token, templates.ruleset);
    return await automergeCommand(state, rest, token);
```

- [ ] **Step 4: Run the tests and the linter**

Run: `npm test && npm run lint`
Expected: PASS, 198 + 7 = 205 tests (1 skipped); lint clean. `requiredChecksFrom` is used by `checkBaseline` too, so the audit tests still pass.

- [ ] **Step 5: Dry-run the two commands on real repos**

Run: `for r in malinfossum/kenaz malinfossum/workbench malinfossum/varde malinfossum/portfolio; do GITHUB_TOKEN=$(gh auth token) node tools/apply.mjs ruleset $r; GITHUB_TOKEN=$(gh auth token) node tools/apply.mjs automerge $r; done`
Expected: `keep    ruleset "main" with ...` and `keep    auto-merge is already on` for kenaz, workbench and varde (workbench's and varde's extra checks make `sameRuleset` true only because `mergeRuleset` carried them; a `update` here means the merge dropped something: stop and fix before committing). For portfolio, `update` naming `code_scanning` is expected without `--no-codeql`, and `keep` with it. `malinfossum/malinfossum` needs `--bypass-admin` for `keep`. Record the four outputs in the task report.

- [ ] **Step 6: Commit**

```bash
git add tools/apply.mjs tools/apply.test.mjs tools/repo-audit.mjs
git commit -m "apply: the ruleset after CodeQL's first analysis, auto-merge after the ruleset, both only with --apply"
```

---
### Task 5: Docs, the Plan 3 deviations, version 1.3.0, and the PR

**Files:**
- Create: `docs/apply.md`
- Modify: `README.md` (the "Use it" section and the `tools/` row of the layout table), `docs/specs/2026-09-25-ci-standard-design.md` (a "Deviations recorded 2026-10-08 (Plan 3)" paragraph after the Plan 5 patch paragraph, and item 2 of "Capturing new stacks"), `package.json` (`version`), `tools/apply.test.mjs` (one docs test)

**Interfaces:**
- Consumes: everything Tasks 1 to 4 produced.
- Produces: the merged PR Task 6 releases.

- [ ] **Step 1: Write the failing docs test**

Append to `tools/apply.test.mjs`:

```js
test("docs/apply.md documents every command and every output word", () => {
  const doc = readFileSync("docs/apply.md", "utf8");
  for (const command of ["files", "settings", "ruleset", "automerge", "status"]) {
    assert.match(doc, new RegExp(`^\\| \`${command}\``, "m"), `${command} has no row`);
  }
  const words = ["inputs", "create", "edit", "keep", "drift", "ask", "note", "warn", "stop", "wait", "set", "rebase", "done", "wrote", "error"];
  for (const word of words) assert.match(doc, new RegExp(`^\\| \`${word}\``, "m"), `${word} has no row`);
  assert.match(doc, /--apply/);
  assert.match(doc, /gh auth token/);
});
```

Run: `node --test tools/apply.test.mjs`
Expected: FAIL, `ENOENT docs/apply.md`.

- [ ] **Step 2: Write `docs/apply.md`**

```markdown
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
```

- [ ] **Step 3: README, spec and version**

In `README.md`, replace the "Use it" paragraph and its code block with:

```markdown
## Use it

From a repo, run the `ward` skill in loadout ("apply ward"), which clones this repo at `v1` and runs
[`tools/apply.mjs`](tools/apply.mjs): it detects the stacks, writes the caller, the Dependabot config
and `Directory.Build.props`, adds missing npm scripts, and then applies the settings, the ruleset and
auto-merge, each change shown before it is made ([docs](docs/apply.md)). By hand, copy
[`templates/ward.yml`](templates/ward.yml) to `.github/workflows/ward.yml` and set the inputs:
```

(keep the YAML block and the module table that follow). In the layout table, change the `tools/` row to: ``| `tools/` | The scripts each job runs, `watchdog.mjs`, `apply.mjs` (puts a repo on the standard, [docs](docs/apply.md)), and their unit tests |``.

In the spec, after the "Deviations recorded 2026-10-07" paragraph, add:

```markdown
**Deviations recorded 2026-10-08 (Plan 3):** the skill gets Ward's code through a shallow clone of
the `v1` tag, not a fetched `stacks.json` alone, because `apply.mjs` needs the templates and three
sibling modules too, and the detection rules must be the released ones. An uncovered stack is a
warning, not a stop: hugin (`powershell`) and devops-course (`docker`) carry callers with the
covered modules on, and the weekly audit already reports the uncovered stack; drafting the module is
the skill's last step. An existing caller, `dependabot.yml` or `Directory.Build.props` is compared
and reported, never rewritten, so a hand edit survives a rerun. A `test` script is never guessed.
The pre-push hook is loadout's `.githooks/pre-push` set as the global `core.hooksPath`, allowing my
dev address, Dependabot's and GitHub's web address, with `git push --no-verify` as the deliberate
escape when I push a co-owner's commits myself.
```

In "Capturing new stacks", change item 2 to: `2. **Unknown stack.** When a detection finds files no rule covers, the skill applies the covered modules, says so in a warning, and drafts the new module as a PR to Ward as its last step; it never applies a guessed config. Capacitor Android is the first expected case.`

In `package.json`, set `"version": "1.3.0"`.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run lint && npm run test:fixtures`
Expected: unit 205 + 1 = 206 (1 skipped); lint clean (30 + 2 files); fixtures unchanged at their previous count.

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add docs/apply.md README.md docs/specs/2026-09-25-ci-standard-design.md package.json tools/apply.test.mjs
git commit -m "Document apply.mjs, record the Plan 3 deviations and bump Ward to 1.3.0"
git push -u origin feat/apply
gh pr create --title "apply.mjs: put a repo on the standard, each change shown first" --body-file - <<'BODY'
Plan 3 of the CI standard (`docs/plans/2026-10-08-ward-apply-skill.md`), Ward side.

`tools/apply.mjs` replaces the hand-run rollout helper. `files` detects a repo's stacks from the same `stacks.json` the audit reads and writes the caller, the Dependabot config, `Directory.Build.props` and missing npm scripts, never over a file that exists. `settings`, `ruleset` and `automerge` read the repo through the audit's own reads and change only what is off, in the one safe order: the ruleset waits for CodeQL's first analysis, auto-merge waits for the ruleset. Nothing changes without `--apply`.

- `request` in `repo-audit.mjs` takes a method and a body; `requiredChecksFrom` is exported. No workflow changes.
- `mergeRuleset` keeps a repo's own rule types and required checks (workbench, varde) beside `ward / gate`.
- Dry runs against kenaz, tidsro, varde, workbench and portfolio report `keep` (outputs in the plan's task reports).
- Docs: `docs/apply.md`; spec deviations for Plan 3; version 1.3.0.

The loadout half (the `ward` skill and the pre-push identity gate) follows in loadout once `v1.3.0` is released.
BODY
```

Expected: `ward / gate`, `ward-windows / gate`, `fixtures` and CodeQL green on the PR; the identity job's drift warning names `package.json` (the version bump touches `scripts`? No: only `version`, so no warning).

---

### Task 6: Release v1.3.0 (Malin's gate)

**Files:** none in the tree; tags and the release.

**Interfaces:**
- Consumes: the merged PR from Task 5.
- Produces: tag `v1.3.0`, `v1` moved to the same commit, release published. Task 8's skill clones `v1`, so it works only after this.

- [ ] **Step 1: Merge the PR** (Malin, in the GitHub UI, merge commit as before).

- [ ] **Step 2: Tag, move v1, release** (on her go; the pin is the commit SHA, never the tag object)

```bash
git switch main && git pull --ff-only
git tag -a v1.3.0 -m "Ward 1.3.0: apply.mjs puts a repo on the standard" \
  && git tag -fa v1 -m "Ward v1: currently v1.3.0" v1.3.0^{commit} \
  && git push origin v1.3.0 \
  && git push --force origin v1 \
  && git rev-parse v1.3.0^{commit} \
  && gh release create v1.3.0 --verify-tag --title "v1.3.0" --latest --notes "tools/apply.mjs: detects a repo's stacks, writes the caller, Dependabot config, Directory.Build.props and missing npm scripts, and applies the settings, the ruleset and auto-merge in the one safe order, each change shown before it is made (docs/apply.md). request() in repo-audit.mjs can now send a method and a body. No change to ci.yml or dependabot-automerge.yml."
gh api repos/malinfossum/ward/git/ref/tags/v1 --jq '.object.sha' | xargs -I{} gh api repos/malinfossum/ward/git/tags/{} --jq '.object.sha'
```

Expected: the last command prints the same commit SHA as `git rev-parse v1.3.0^{commit}`. The `templates/ward.yml` automerge pin stays at the `v1.2.1` commit: `dependabot-automerge.yml` did not change (`git log v1.2.1..v1.3.0 -- .github/workflows/dependabot-automerge.yml` is empty), so no consumer pin moves, and Dependabot proposes the Ward bump only on Ward's own `ward.yml`, which auto-merge refuses by design.

- [ ] **Step 3: Watch the release-triggered canary**

```bash
sleep 300 && gh run list --repo malinfossum/ward --workflow canary.yml --limit 1 --json conclusion,event,databaseId
```

Expected: `event: release`, `conclusion: success`.

---
### Task 7: Loadout: the pre-push identity gate on every repo

**Files (all in the loadout clone, `~/.claude/loadout`, which is the repo `repos\loadout`):**
- Modify: `.githooks/pre-push`, `lib/Loadout.psm1` (step 5 of `Install-Loadout` at lines 254 to 263, the git block of `Uninstall-Loadout` at lines 292 to 294, the hooks block of `Test-LoadoutHealth` at lines 340 to 347), `tests/Install.Tests.ps1` (the two hooks tests at lines 44 to 56), `tests/Verify.Tests.ps1` (the two hooks messages at lines 55 to 60), `README.md` (the "What it does" bullet about git identity and the "Tests" paragraph)
- Create: `tests/Hooks.Tests.ps1`

**Interfaces:**
- Consumes: `Test-LoadoutSamePath`, `Write-LoadoutStatus`, the existing `.githooks/pre-push`.
- Produces: `Get-LoadoutHooksPath -Source <clone> → string` (the clone's `.githooks`, absolute, forward slashes); `install.ps1` sets the global `core.hooksPath` to it when no foreign global path exists; `verify.ps1` reports it; the hook refuses a push whose new commits carry an author or committer outside the allowlist.

- [ ] **Step 1: Branch**

```bash
cd ~/.claude/loadout && git switch main && git pull --ff-only && git switch -c skills/ward
```

- [ ] **Step 2: Write the failing hook tests**

Create `tests/Hooks.Tests.ps1`:

```powershell
BeforeAll {
    $script:Repo = (Resolve-Path "$PSScriptRoot\..").Path
    $script:Hooks = (Join-Path $Repo '.githooks') -replace '\\', '/'
    # Isolate from the machine's global gitconfig, as Install.Tests.ps1 does.
    $script:GlobalGitConfig = Join-Path $TestDrive 'gitconfig-global'
    New-Item -ItemType File -Path $script:GlobalGitConfig -Force | Out-Null
    $script:PrevGitConfigGlobal = $env:GIT_CONFIG_GLOBAL
    $env:GIT_CONFIG_GLOBAL = $script:GlobalGitConfig
    $script:Mine = 'malinfossum.dev@proton.me'

    # A bare remote and a working clone whose pushes run the real hook.
    function New-Pair {
        $id = [guid]::NewGuid().ToString('N').Substring(0, 8)
        $remote = Join-Path $TestDrive "remote-$id"; git init -q --bare $remote
        $work = Join-Path $TestDrive "work-$id"; git init -q -b main $work
        git -C $work remote add origin $remote
        git -C $work config core.hooksPath $script:Hooks
        git -C $work config user.name 'Test'
        git -C $work config user.email $script:Mine
        return $work
    }
    # One commit by $Email (author and committer unless -Author overrides the author).
    function Add-Commit($Work, $Email, $Name, [string]$Author) {
        Set-Content (Join-Path $Work "$Name.txt") $Name
        git -C $Work add -A
        $gitArgs = @('-c', "user.email=$Email", 'commit', '-q', '-m', $Name)
        if ($Author) { $gitArgs += "--author=Test <$Author>" }
        & git -C $Work @gitArgs
    }
    function Push-Main($Work, [string[]]$Extra = @()) {
        $out = & git -C $Work push @Extra origin main 2>&1 | Out-String
        return @{ Code = $LASTEXITCODE; Out = $out }
    }
}

AfterAll {
    if ($null -ne $script:PrevGitConfigGlobal) { $env:GIT_CONFIG_GLOBAL = $script:PrevGitConfigGlobal } else { Remove-Item Env:\GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue }
}

Describe 'pre-push identity gate' {
    It 'refuses a commit authored by another address and names it' {
        $w = New-Pair; Add-Commit $w 'someone@example.com' 'a'
        $r = Push-Main $w
        $r.Code | Should -Not -Be 0
        $r.Out | Should -Match 'an address that is not mine'
        $r.Out | Should -Match 'author\s+s\.\.\.@example\.com'
        $r.Out | Should -Not -Match 'someone@example\.com'
        $r.Out | Should -Match '--no-verify'
    }
    It 'refuses a foreign committer behind my own author line' {
        $w = New-Pair; Add-Commit $w 'someone@example.com' 'a' -Author $script:Mine
        $r = Push-Main $w
        $r.Code | Should -Not -Be 0
        $r.Out | Should -Match 'committer\s+s\.\.\.@example\.com'
        $r.Out | Should -Not -Match 'author\s+s\.\.\.'
    }
    It 'lets my dev address, Dependabot and the GitHub web address through' {
        $w = New-Pair
        Add-Commit $w $script:Mine 'a'
        Add-Commit $w '49699333+dependabot[bot]@users.noreply.github.com' 'b'
        Add-Commit $w 'noreply@github.com' 'c'
        (Push-Main $w).Code | Should -Be 0
    }
    It 'checks only the commits the push adds' {
        $w = New-Pair; Add-Commit $w 'someone@example.com' 'a'
        (Push-Main $w @('--no-verify')).Code | Should -Be 0
        Add-Commit $w $script:Mine 'b'
        (Push-Main $w).Code | Should -Be 0
    }
    It 'lets a branch deletion through' {
        $w = New-Pair; Add-Commit $w $script:Mine 'a'; Push-Main $w | Out-Null
        git -C $w switch -q -c side; git -C $w push -q origin side 2>&1 | Out-Null
        & git -C $w push origin --delete side 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }
    It 'does not run the secret scan outside loadout' {
        # A repo without tools/scan-secrets.ps1 must pass without pwsh being involved.
        $w = New-Pair; Add-Commit $w $script:Mine 'a'
        $r = Push-Main $w
        $r.Code | Should -Be 0
        $r.Out | Should -Not -Match 'scan'
    }
}
```

Run: `pwsh -NoProfile -Command "Invoke-Pester tests/Hooks.Tests.ps1 -Output Detailed"`
Expected: the first two and the last fail (the hook today runs the secret scan on every repo and never checks addresses; on a repo without `tools/scan-secrets.ps1` it exits 1 because `pwsh` cannot find the script, or passes the foreign address).

- [ ] **Step 3: Rewrite the hook**

Replace `.githooks/pre-push` with (LF line endings, which `.gitattributes` enforces):

```sh
#!/bin/sh
# Two gates before anything leaves this machine. install.ps1 makes this folder the global
# core.hooksPath, so the identity gate sees every repo; the secret scan runs only inside loadout.
# A deliberate one-off escape is `git push --no-verify`.
#
# 1. Identity: every commit the push adds is authored and committed by my dev address, Dependabot
#    or GitHub's web address. By the time CI's identity job sees a commit it is already public, so
#    this is the gate that keeps a private address off GitHub (Ward spec, Security of Ward itself).
allowed=" malinfossum.dev@proton.me 49699333+dependabot[bot]@users.noreply.github.com noreply@github.com "
zero=0000000000000000000000000000000000000000
refused=0
# The address as the CI identity job shows it: first character and domain, enough to recognise
# it, not enough to copy it into a transcript (a Claude Code session sees this output too).
redact() { case "$1" in *@*) printf '%s...@%s' "${1%"${1#?}"}" "${1##*@}" ;; *) printf '...' ;; esac; }
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue # a deletion adds no commits
  if [ "$remote_sha" = "$zero" ]; then range="$local_sha --not --remotes"; else range="$remote_sha..$local_sha"; fi
  # shellcheck disable=SC2086
  offenders=$(git log --format='%h %ae %ce' $range 2>/dev/null | while read -r sha author committer; do
    case "$allowed" in *" $author "*) ;; *) echo "  $sha author    $(redact "$author")" ;; esac
    case "$allowed" in *" $committer "*) ;; *) echo "  $sha committer $(redact "$committer")" ;; esac
  done)
  if [ -n "$offenders" ]; then
    echo "loadout pre-push: $local_ref carries commits by an address that is not mine:" >&2
    echo "$offenders" >&2
    refused=1
  fi
done
if [ "$refused" = 1 ]; then
  echo "loadout pre-push: fix with git commit --amend --reset-author (or a rebase), or push with --no-verify on purpose." >&2
  exit 1
fi

# 2. Secrets, in loadout itself: tools/scan-secrets.ps1 finds no secret or private content.
root="$(git rev-parse --show-toplevel)"
[ -f "$root/tools/scan-secrets.ps1" ] && [ -f "$root/lib/Loadout.psm1" ] || exit 0
if ! command -v pwsh >/dev/null 2>&1; then
  echo "loadout pre-push: pwsh not on PATH, cannot run the secret scan. Install PowerShell 7 or push with --no-verify at your own risk." >&2
  exit 1
fi
exec pwsh -NoProfile -File "$root/tools/scan-secrets.ps1" -Root "$root"
```

The loop reads the hook's stdin (one line per ref), not a pipe, so `refused` survives it. `redact` uses parameter expansion only: `${1#?}` drops the first character, `${1%"${1#?}"}` keeps it, `${1##*@}` is the domain. `git log` with a range the local repo cannot resolve (a stale remote-tracking ref) prints nothing and the ref passes; the identity job on the PR is the second net. No tool but `git` and `sh` built-ins, because GitHub Desktop's bundled `sh` is minimal.

Run: `pwsh -NoProfile -Command "Invoke-Pester tests/Hooks.Tests.ps1 -Output Detailed"`
Expected: PASS, 6 tests. If `git push` in the tests cannot find `sh`, the test machine has no Git for Windows on PATH; that is a machine problem, not a hook problem, and the plan stops here until it is fixed.

- [ ] **Step 4: Install, uninstall and health**

In `lib/Loadout.psm1`, add after `Test-LoadoutSamePath`:

```powershell
# The clone's .githooks as git wants it in config: absolute, forward slashes.
function Get-LoadoutHooksPath {
    param([string]$Source)
    return ((Join-Path (Resolve-Path -LiteralPath $Source).Path '.githooks') -replace '\\', '/')
}
```

Replace step 5 of `Install-Loadout` (from the comment `# 5. git identity` to the closing `else { Write-LoadoutStatus -Level SKIP -Item 'git' ... }`) with:

```powershell
    # 5. git identity and the two pre-push gates. The identity gate must see every repo on this
    #    machine, so .githooks becomes the global core.hooksPath; the clone keeps its own local
    #    setting too, so loadout's secret scan survives a firm's global path. Never override a
    #    global path that is not ours: a firm that mandates one would read that as evasion.
    if (Test-Path (Join-Path $Source '.git')) {
        & git -C $Source config user.name 'Malin Fossum'
        & git -C $Source config user.email 'malinfossum.dev@proton.me'
        Write-LoadoutStatus -Level OK -Item 'git' -Reason 'dev identity set on the clone'
        $ours = Get-LoadoutHooksPath -Source $Source
        $globalHooks = & git config --global --get core.hooksPath 2>$null
        if ($globalHooks -and -not (Test-LoadoutSamePath $globalHooks $ours)) {
            Write-LoadoutStatus -Level SKIP -Item 'hooks' -Reason "global core.hooksPath is $globalHooks; not overriding it, both pre-push gates are off on this machine"
        } else {
            & git -C $Source config core.hooksPath '.githooks'
            & git config --global core.hooksPath $ours
            Write-LoadoutStatus -Level OK -Item 'hooks' -Reason "pre-push gates on: global core.hooksPath -> $ours"
        }
    } else { Write-LoadoutStatus -Level SKIP -Item 'git' -Reason 'source is not a git clone' }
```

In `Uninstall-Loadout`, replace the git block with:

```powershell
    if (Test-Path (Join-Path $Source '.git')) {
        foreach ($k in 'user.name', 'user.email', 'core.hooksPath') { & git -C $Source config --unset $k 2>$null }
        $globalHooks = & git config --global --get core.hooksPath 2>$null
        if ($globalHooks -and (Test-LoadoutSamePath $globalHooks (Get-LoadoutHooksPath -Source $Source))) { & git config --global --unset core.hooksPath }
        Write-LoadoutStatus -Level OK -Item 'git' -Reason 'repo-local identity and both hooks paths unset'
    }
```

In `Test-LoadoutHealth`, replace the hooks block (from the comment `# the pre-push secret gate` to the end of its `else`) with:

```powershell
        # the two pre-push gates: our .githooks as the global hooks path, or a mandated one install.ps1 left alone
        $ours = Get-LoadoutHooksPath -Source $Source
        $globalHooks = & git config --global --get core.hooksPath 2>$null
        if ($globalHooks -and (Test-LoadoutSamePath $globalHooks $ours)) { Write-LoadoutStatus -Level OK -Item 'hooks' -Reason "pre-push gates on (global core.hooksPath -> $ours)" }
        elseif ($globalHooks) { Write-LoadoutStatus -Level SKIP -Item 'hooks' -Reason "global core.hooksPath is $globalHooks; both pre-push gates are off on this machine" }
        else { Write-LoadoutStatus -Level WARN -Item 'hooks' -Reason 'pre-push gates off (global core.hooksPath unset); rerun install.ps1' }
```

Add `Get-LoadoutHooksPath` to the module's `Export-ModuleMember` list if the module has one (check the tail of the file; if it exports with a wildcard, nothing to do).

- [ ] **Step 5: Update the install and verify tests**

In `tests/Install.Tests.ps1`, change the test `'sets my dev identity and the hooks path on the source clone'` to also assert the global path:

```powershell
    It 'sets my dev identity, the clone hooks path and the global hooks path' {
        git -C $src config user.email | Should -Be 'malinfossum.dev@proton.me'
        git -C $src config core.hooksPath | Should -Be '.githooks'
        git config --global core.hooksPath | Should -Be (Get-LoadoutHooksPath -Source $src)
    }
```

In the test `'does not override a global core.hooksPath (a company may mandate one)'`, keep its assertions and add after the local one: `git -C $src2 config --global core.hooksPath | Should -Be 'C:/corp/hooks'` (it runs with the corp gitconfig still active only inside the `try`; put the assertion inside the `try` before `finally`). Add one test to the same `Describe`:

```powershell
    It 'unsets the global hooks path on remove only when it is ours' {
        $src2 = New-TestSource; $cd2 = New-TestClaudeDir
        Reset-LoadoutStatus; Install-Loadout -ClaudeDir $cd2 -Source $src2 6>$null
        Reset-LoadoutStatus; Uninstall-Loadout -ClaudeDir $cd2 -Source $src2 6>$null
        git config --global core.hooksPath | Should -BeNullOrEmpty
    }
```

In `tests/Verify.Tests.ps1`, replace the expected strings at lines 55 to 60: the unset case now expects `'WARN    hooks  pre-push gates off (global core.hooksPath unset); rerun install.ps1'` after `git config --global --unset core.hooksPath` (not the local unset; read the test's setup and adjust the command it runs), and the mandated case expects a line matching `'^SKIP    hooks  global core\.hooksPath is .*both pre-push gates are off'`.

Run: `pwsh -NoProfile -Command "Invoke-Pester tests -Output Detailed"`
Expected: PASS, every file. If an Install or Verify test fails on the message text, align the test to the strings in Step 4, not the other way round.

- [ ] **Step 6: README**

In `README.md`, change the bullet `- Sets my dev git identity and the pre-push secret gate on the clone.` to `- Sets my dev git identity on the clone and the two pre-push gates: the identity gate on every repo on this machine (the clone's .githooks becomes the global core.hooksPath) and the secret scan on the clone.` In "Tests", change `a pre-push hook runs the same scan` to `a pre-push hook runs the same scan inside loadout, and refuses a push from any repo whose new commits carry an address that is not mine`.

- [ ] **Step 7: Commit**

```bash
git add .githooks/pre-push lib/Loadout.psm1 tests/Hooks.Tests.ps1 tests/Install.Tests.ps1 tests/Verify.Tests.ps1 README.md
git commit -m "Pre-push identity gate on every repo: .githooks becomes the global hooks path"
```

---

### Task 8: Loadout: the `ward` skill, manifest and version 0.5.0

**Files (loadout clone, branch `skills/ward`):**
- Create: `skills/ward/SKILL.md`, `skills/ward/references/commands.md`
- Modify: `lib/Loadout.psm1` (lines 5 and 7: `$script:SkillNames`, `$script:Heading`), `tests/Manifest.Tests.ps1` (lines 8 and 9, the manifest `$expected` list, line 24), `tests/Verify.Tests.ps1` (line 21: 17 becomes 18), `CLAUDE.md` (the H1 version and one line under "Stack & Standards"), `README.md` ("nine professional skills" becomes "ten")

**Interfaces:**
- Consumes: `tools/apply.mjs` at the released `v1` (Task 6).
- Produces: the skill `~/.claude/skills/ward` once `install.ps1` runs (Task 9).

- [ ] **Step 1: Update the manifest tests first**

In `tests/Manifest.Tests.ps1`: the skill list test expects `'ward'` appended after `'taste-pass'` and its name becomes `'lists the eleven shipped folders, _coding-shared first'`; `$expected` gains `'skills/ward/references/commands.md'` (the `SKILL.md` comes from the loop); the heading test expects `'# Loadout: my portable Claude standards (v0.5.0)'`. In `tests/Verify.Tests.ps1` line 21, `17` becomes `18` and the comment `11 skills`.

Run: `pwsh -NoProfile -Command "Invoke-Pester tests/Manifest.Tests.ps1, tests/Verify.Tests.ps1"`
Expected: FAIL on the list, the manifest, the heading and the count.

- [ ] **Step 2: Write the skill**

Create `skills/ward/SKILL.md`:

```markdown
---
name: ward
description: Put a repo on Ward, my CI, security and accessibility standard: detect its stacks, write the caller, Dependabot config and Directory.Build.props, add missing npm scripts, then set the GitHub settings, ruleset and auto-merge through Ward's own apply.mjs, each change shown first. Fires on "apply ward", "ward this repo", after project-init scaffolds a repo, or when a new framework lands in a repo.
---

# Ward

Ward (`github.com/malinfossum/ward`) holds the standard every repo of mine runs: one caller workflow,
one required check `ward / gate`, Dependabot with auto-merge for safe bumps, secret scanning, CodeQL
and a ruleset on `main`. This skill applies it with Ward's own `tools/apply.mjs` at the released tag,
so what it applies is the standard, never a copy kept here.

## When to fire
- "apply ward", "ward this repo", "put this repo on Ward", "is this repo on Ward"
- Right after `project-init` has scaffolded a repo, before its first push
- A new framework or language lands in a repo already on Ward (a `wrangler.jsonc`, a `.csproj`, a `pyproject.toml`)

## What to do
1. **Get Ward at the released tag.** `WARD="${WARD_DIR:-$(mktemp -d)/ward}"`; unless `WARD_DIR` is set, `git clone -q --depth 1 --branch v1 https://github.com/malinfossum/ward.git "$WARD"`. Never a clone on `main`: that is development, not the standard.
2. **Plan the files.** From the repo root: `node "$WARD/tools/apply.mjs" files`. Show me the lines as they are. `stop` is mine to answer (two candidates at one depth: I name the input). `warn` names a stack Ward has no module for: finish the covered part, then step 8. `drift` is a hand edit or an old choice: I settle it, the script never overwrites.
3. **Write them on my yes.** `node "$WARD/tools/apply.mjs" files --apply`. Then the `ask` lines (a `test` script is my choice of runner) and the `note` lines (a package to add; I install it, never you).
4. **Branch, commit, PR.** `chore/ward` off `main`, one commit `Add the Ward caller and Dependabot config`, the plan output in the PR body. I merge.
5. **Settings.** `GITHUB_TOKEN=$(gh auth token) node "$WARD/tools/apply.mjs" settings <owner/repo>`; show the `set` lines; on my yes add `--apply`. Safe at any time.
6. **Ruleset, after CodeQL has analysed main.** Same with `ruleset`. A `wait` line means CodeQL has not finished its first analysis: say so and rerun later (minutes, up to an hour). `--no-codeql` only when `settings` noted that CodeQL has no language here, together with a dated `ruleset` exception in Ward's `stacks.json`. `--bypass-admin` only for a repo a token of mine pushes to directly, with the reason in the exception's PR.
7. **Auto-merge, last.** `automerge`: it refuses until `main` requires `ward / gate`. On a joint repo, stop here until the co-owner has agreed.
8. **Report and follow up.** `status <owner/repo>` as the last line. A module kept off on purpose, or a stack Ward lacks, becomes a PR to Ward: a dated `exceptions` entry in `stacks.json`, or a new module (detection files in `stacks.json`, a job in `ci.yml`, a passing and a rejecting fixture).

## Output format
- The script's lines verbatim under one heading per command, then one line per decision that is mine
- Never the token; never an address other than my dev address

## Don't
- Don't run a Ward clone on `main`, and don't copy `stacks.json` or the templates into this skill
- Don't overwrite an existing caller, `dependabot.yml` or `Directory.Build.props`; drift is mine
- Don't install packages, guess a `test` runner, merge a PR, or run `--apply` before I have seen the plan
- Don't run `ruleset` past a `stop` (classic protection, two rulesets): the script stops, I clean up

## References
- `references/commands.md`: every command, flag, output word and exit code
```

Create `skills/ward/references/commands.md` with the two tables from `docs/apply.md` (Commands; Output) copied verbatim, a line above them `Source: docs/apply.md in malinfossum/ward at v1; the tables are the same text.`, and the exit-code sentence. No other content: the skill owns the flow, Ward owns the vocabulary.

- [ ] **Step 3: Manifest, heading, CLAUDE.md, README**

In `lib/Loadout.psm1`: `$script:SkillNames` gains `'ward'` at the end; `$script:Heading` becomes `'# Loadout: my portable Claude standards (v0.5.0)'` (it was two versions stale; the smoke test compares against it). In `CLAUDE.md`: the H1 becomes `# Loadout: my portable Claude standards (v0.5.0)`; under "Stack & Standards", after the mobile-first bullet, add: `**CI, security and repo settings come from Ward** (\`malinfossum/ward\`): one caller, one required check, Dependabot auto-merge for safe bumps, secret scanning, CodeQL, a ruleset. The \`ward\` skill applies it to a repo.` In `README.md`: `nine professional skills` becomes `ten professional skills`.

Run: `pwsh -NoProfile -Command "Invoke-Pester tests -Output Detailed"`
Expected: PASS, every file.

- [ ] **Step 4: Commit, push, open the PR**

```bash
git add skills/ward lib/Loadout.psm1 tests/Manifest.Tests.ps1 tests/Verify.Tests.ps1 CLAUDE.md README.md
git commit -m "ward skill: apply the standard through Ward's apply.mjs at the released tag; loadout 0.5.0"
git push -u origin skills/ward
gh pr create --title "ward skill and the pre-push identity gate" --body-file - <<'BODY'
Plan 3 of the CI standard, loadout side (`ward/docs/plans/2026-10-08-ward-apply-skill.md`).

- `.githooks/pre-push` becomes the global `core.hooksPath` on install, so every push from this machine is refused when a new commit carries an address that is not mine (dev address, Dependabot and GitHub's web address pass); `git push --no-verify` is the deliberate escape. The secret scan still runs only inside loadout. A foreign global hooks path is never overridden; `verify.ps1` says which case applies.
- New `ward` skill: clones Ward at `v1` and runs `tools/apply.mjs` (files, settings, ruleset, auto-merge), each change shown before `--apply`.
- Pester: `tests/Hooks.Tests.ps1` pushes to a bare remote through the real hook; the install, verify and manifest tests follow. Version 0.5.0.

After merging: `git pull` in the clone, then `.\install.ps1` and `.\verify.ps1` (hooks line reads `pre-push gates on`).
BODY
```

---
### Task 9: End to end on two throwaway repos, the hook from the CLI and from GitHub Desktop, and the `project-init` hand-off (Malin's gate)

**Files:**
- Modify: `~/.claude/skills/project-init/SKILL.md` (step 8), on her go
- Nothing in Ward or loadout; the results go in this task's report under `.superpowers/sdd/`

**Interfaces:**
- Consumes: Ward `v1.3.0` (Task 6), loadout merged and installed (Tasks 7 and 8).
- Produces: the spec's rollout exit for item 3: "applied to one web repo and one C# repo end to end".

- [ ] **Step 1: Malin installs** (her machine, her commands)

```powershell
cd ~\.claude\loadout; git switch main; git pull --ff-only; .\install.ps1; .\verify.ps1
```

Expected: `OK      hooks  pre-push gates on (global core.hooksPath -> C:/Users/Nugget/Documents/Development/GitHub/repos/loadout/.githooks)`, and `skill:ward` linked. From here every push from this machine runs the gate.

- [ ] **Step 2: Malin creates the two throwaway repos** (public, empty, no README): `malinfossum/ward-test-web` and `malinfossum/ward-test-dotnet`, in the browser or with her go for `gh repo create malinfossum/ward-test-web --public` and the same for `-dotnet`.

- [ ] **Step 3: The web repo, and the hook from the CLI**

```bash
scaffold=~/Documents/Development/GitHub/repos/workbench/scaffolds/web-react-ts
cd "$(mktemp -d)" && git clone -q https://github.com/malinfossum/ward-test-web.git && cd ward-test-web
cp -r "$scaffold"/. . && rm -rf node_modules dist test-results && mv .github .github.scaffold
git add -A && git -c user.email=someone@example.com commit -q -m "Scaffold" && git push -u origin main
```

Expected: the push is refused with `loadout pre-push: refs/heads/main carries commits by an address that is not mine:` and the `s...@example.com` line. Then `git commit --amend --reset-author --no-edit && git push -u origin main` succeeds. The scaffold's own `.github` is set aside as `.github.scaffold` (untracked by the first commit: add it to `.git/info/exclude` first) so `files` has something to `create` and something to diff against.

Then the skill, exactly as written, with `WARD_DIR` unset: `files` must print `inputs  node="." dotnet="" dotnet-os="ubuntu-latest" dotnet-ef-project=""`, `create` for the caller and the Dependabot config, `keep` for `package.json` (the scaffold has `lint`, `test` and `typecheck`). After `--apply`, `diff .github/workflows/ward.yml .github.scaffold/workflows/ward.yml` must show no difference in the five input lines (the scaffold's caller was written by hand in Plan 5 Task 11; a difference is a finding about either side, and goes in the report). Remove `.github.scaffold`, commit on `main` directly (a throwaway, no PR), push. Then `settings --apply`, wait for CodeQL (`status` shows `analysed=true`), `ruleset --apply`, `automerge --apply`, `status`.

- [ ] **Step 4: The C# repo**

Same shape with `csharp-api`: copy the scaffold minus `.github` (set aside), `git init`-free since the clone exists, first commit with my address, push. `files` must print `inputs  node="" dotnet="App.slnx" dotnet-os="ubuntu-latest" dotnet-ef-project="App.Data"` and `create` for the caller, the Dependabot config (github-actions, nuget, dotnet-sdk) and `Directory.Build.props` (the scaffold carries one: expect `keep` for it, `create` for the other two). The scaffold's hand-written caller says `dotnet: "."`; the diff against the written one must show only that line, which `sameInput` reads as the same choice. Then settings, the CodeQL wait, ruleset, automerge, status.

- [ ] **Step 5: Both Ward runs green, and the audit sees nothing**

```bash
gh run list --repo malinfossum/ward-test-web --workflow ward.yml --limit 1 --json conclusion
gh run list --repo malinfossum/ward-test-dotnet --workflow ward.yml --limit 1 --json conclusion
cd ~/Documents/Development/GitHub/repos/ward && GITHUB_TOKEN=$(gh auth token) WARD_AUDIT_TOKEN=$(gh auth token) node tools/repo-audit.mjs --owner malinfossum --mode strict
```

Expected: `success` twice; the audit lists both test repos with no finding (the whole run may still be red for an unrelated repo; only the two sections matter here).

- [ ] **Step 6: The hook from GitHub Desktop** (Malin)

In the `ward-test-web` clone, on a branch, because by now the ruleset lets `main` take only PRs and a ruleset rejection would be mistaken for the hook: `git switch -c desktop-check && git config user.email someone@example.com`, then in GitHub Desktop change a line in `README.md`, commit, and publish the branch. Expected: Desktop shows the push failure with the hook's message (`loadout pre-push: ... an address that is not mine`; a ruleset rejection names the rule instead). Then `git config --unset user.email`, `git commit --amend --reset-author --no-edit`, publish again from Desktop: succeeds. Delete the branch. This is the only step that proves Desktop runs the gate; if it does not (no error, the commit lands), the record says so and the gate covers CLI pushes only until a fix.

- [ ] **Step 7: `project-init` hands over** (her go; a harness edit)

In `~/.claude/skills/project-init/SKILL.md`, step 8 becomes: `8. Report: which scaffold was picked, why, and the next concrete step. Then run the \`ward\` skill ("apply ward") so the repo carries its caller and Dependabot config before its first push; the settings, ruleset and auto-merge follow once the repo exists on GitHub.` Commit in the harness repo as Plan 5 did for the morning skill.

- [ ] **Step 8: Record and clean up**

The task report lists: the exact `files` output for both repos, the diffs against the scaffold callers, the hook refusals (CLI and Desktop), the status lines, the two run conclusions, the audit sections. Then Malin deletes both throwaway repos in the browser (Settings, Danger zone; `gh repo delete` needs the `delete_repo` scope her token lacks). Plan 3 is closed when both repos are gone and the record is in.

---

## Follow-ups (dated)

- **2026-10-28:** Node 26 becomes Active LTS; raise `node-version`'s default in `ci.yml` from 24 and the `engines` floor (spec, dated follow-up).
- **Plan 4:** `ward-a11y` and `test:a11y`; until then `a11y` stays `"off"` in every caller `files` writes.
- **Plan 6:** `python`, `powershell`, `docker` modules; today they are `warn` lines from `files` and `uncovered` warnings in the audit (hugin, devops-course).
- **Loadout smoke test:** `$script:Heading` was two versions stale (`v0.3.0` against a `v0.4.0` CLAUDE.md), so `verify.ps1 -Smoke` would have reported the standards missing; Task 8 aligns it at `v0.5.0`. Worth one `-Smoke` run after install.
- **wend:** the caller, ruleset and auto-merge still wait for the co-owner; the skill's step 7 stops there on purpose.

## Considered and rejected

- A per-repo hook installed by the skill, or `init.templateDir`: both miss repos the skill never touched or clones made before the install (D1).
- `npx github:malinfossum/ward#v1` for the skill: an npm cache whose refresh for a moving tag I have not verified; the shallow clone is explicit (D2).
- The skill using the local Ward clone on `main`: development, not the standard (D2).
- A hard stop on an uncovered stack: refuses repos the audit accepts today (D3).
- Reading `allowed-emails` from the caller in the hook: the multi-line YAML form defeats `sh`, and `--no-verify` covers the rare case (D5).
- A PowerShell hook: GitHub Desktop's bundled git has `sh`, not `pwsh` on its PATH; the secret scan keeps `pwsh` because it only runs inside loadout.
- Rewriting an existing caller with the computed inputs: loses hand edits (D8).
- Guessing a `test` runner from the dependencies: a wrong runner is a green that tests nothing (D6).
- One `apply all` command: the CodeQL wait and the auto-merge order need a human between the steps; the skill is that sequence.
- Keeping `task-10.sh`: it is gitignored and its knowledge now lives in `docs/apply.md`; the file stays on disk until the SDD folder is cleaned, nothing references it.
- A finer-grained or long-lived token for the skill: `gh auth token` is already on the machine and the skill runs only with me present.

## Self-review (2026-10-08)

Spec coverage: the skill (Capturing new stacks 1), the unknown-stack rule (2, softened by D3), `apply.mjs` with each change shown first, the pre-push hook (Security of Ward itself, Account), the exit for rollout item 3 (Task 9); each has a task. Placeholder scan: none. Names and signatures: `planInputs`, `renderCaller`, `renderDependabot`, `planFiles`, `writeFiles`, `readState`, `planSettings`, `planRuleset`, `planAutomerge`, `runApply` are used in later tasks exactly as the task that defines them spells them; the test helper `stubFetch` in `apply.test.mjs` is its own copy, with a method-aware fourth element the audit's copy lacks. Three fixes before the stress test: the automerge test lacked a route for the rebase comment (the stub would have answered 599 and `request` thrown); the Pester helper shadowed the automatic `$args`; Task 9's copy step mixed `robocopy` with Git Bash.

## Stress test (2026-10-08)

Five passes over this plan: security, privacy, accessibility, legal, loopholes. Every finding is folded in above.

- 🟠 **Privacy: the hook printed the whole offending address.** A refusal reaches a Claude Code session's tool output, and a co-owner's personal address is a named third party's data. Adapted, not applied as written: the hook prints the address the way the identity job already does (first character, `...`, domain), in `sh` parameter expansion only, so Desktop's minimal shell needs no `cut`. Task 7 hook and tests, D5, Global Constraints, Task 9 Step 3. Proof: `Hooks.Tests.ps1` matches `s...@example.com` and refuses `someone@example.com` in the output.
- 🟠 **Loophole: the Desktop hook check pushed to `main` after the ruleset was on.** By then `main` takes only PRs, so the ruleset would reject the push and look like the hook. Applied: Task 9 Step 6 runs on a branch `desktop-check` and tells the two rejections apart by their text. Proof: manual, Malin, Task 9.
- 🟠 **Loophole: a rerun of `automerge --apply` re-asked Dependabot to rebase every open PR.** Idempotency of repeated events. Adapted: the rebase nudge exists for PRs that stalled before auto-merge; `planAutomerge` returns no rebase list once auto-merge is on, which is one line less than tracking what was asked before. Proof: the `planAutomerge` test with auto-merge on and one open PR expects `rebase: []`.
- 🟠 **Loophole: Dependabot blocks all said `directory: /`.** Dependabot looks only where a block points, so varde's `api/global.json` and any nested Dockerfile got no updates. Applied: one block per directory found, nuget beside the solution. Task 1 code and test (`nested` case). Proof: the unit test.
- 🟡 **Security (A10): a rulesets list the token could not read was planned as `create`.** A 403 gave an empty list and a `create` line, then a failed POST. Applied: `readState` records `rulesetsRead`, `planRuleset` stops on it. Proof: the `planRuleset` stops test.
- 🟡 **Security (A10): an API failure in the middle of `--apply` lost the lines before it.** `runApply`'s catch replaced the whole output with one error line, so the operator could not see which changes had landed. Applied: `attempt` wraps each write, keeps the `done` lines, appends `error` and stops; a rerun is idempotent. Proof: the "API failure mid-apply" test with a method-aware stub route.
- 🟡 **Loophole: a repo CodeQL has no language for waited for ever.** `ruleset` printed the same `wait` line every time. Applied: the wait names `--no-codeql` and the dated exception when `languages` is empty. Proof: the `noLanguage` assertion.
- 🟡 **Loophole: an unreadable `--dir` or a `package.json` that is not JSON crashed with a stack trace.** Applied: both are `stop` lines. Proof: the two assertions at the end of the files-command test.
- 🟡 **Loophole: `request` errors said only the status.** A 422 on a ruleset PUT carries the reason in the body. Applied: the first 200 characters of the body join the message; the audit's pinned messages are unchanged because its error stubs have no body. Proof: the mid-apply test pins `: {"message":"nope"}`.
- ✅ **Security, the rest.** The skill runs code from a tag only an admin can move (tag ruleset 24164641); the token is read from the environment and never printed; writes are argument-free `fetch` calls with fixed bodies; the hook adds no command but `git`; the global hooks path is never set over a foreign one.
- ✅ **Accessibility.** No user interface; the output is words, not colours.
- ✅ **Legal.** Loadout is private and copies two tables of my own text; the throwaway repos hold my scaffolds under my MIT licence; no third party is named anywhere public.

**Considered and rejected**
- **A hook that falls back to refusing when `git log` cannot resolve the range** (a stale remote-tracking ref). It would refuse every push after a fetch race until the user understood why; the identity job on the PR is the second net, and the case is rare.
- **Method-aware routes in the audit's own `stubFetch`.** The audit never writes; its stub stays as it is.
- **Parsing `directories:` (plural) in an existing `dependabot.yml`.** No repo of mine uses it; `planDependabot` would report a false `drift`, which I would see and settle by hand.
- **A YAML-safe quoting of directory names in the caller.** A folder with `#` or `:` in its name breaks the template; none of mine has one, and the caller is read back through `parseCaller` in the round-trip test.
- **Writing `.github.scaffold` to `.git/info/exclude` for her.** Task 9 says it; one line of hers.

> Stress-tested 2026-10-08 (skill a06dd56): 7 applied, 2 adapted, 0 decided by me.
