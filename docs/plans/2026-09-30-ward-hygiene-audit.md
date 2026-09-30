# Ward hygiene and audit migration (Plan 2 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the README-drift checker and the weekly repo audit out of workbench into Ward, and give the audit its Plan 2 checks: baseline settings, caller on `@v1`, caller inputs against the repo's stacks, dated NuGet audit suppressions, runtimes near end of life, and the canary watchdog. The `/morning` briefing gets the outside watchdog.

**Architecture:** `tools/repo-hygiene.mjs` moves as-is (Node 24, Biome-clean, Ward's annotation and exit conventions) and stays focused on README drift. A new `tools/repo-audit.mjs` holds one pure exported function per check, all taking fetched JSON and returning `[kind, message]` findings, plus a thin API layer that only fetches. `stacks.json` at the root carries the detection rules both the audit and Plan 3's skill read. `repo-hygiene.yml` becomes a reusable workflow that fetches Ward's `tools/` at `job.workflow_sha`, exactly as `ci.yml` does; `repo-audit.yml` is Ward's weekly scheduled sweep running both scripts in strict mode. After the `v1.1.0` release, workbench keeps a forwarder for one release and the six scaffolds and five consumer repos switch their `uses:` line.

**Tech Stack:** GitHub Actions (reusable and scheduled workflows), Node 24 ESM scripts with no dependencies, `node:test`, Biome 2.5.14, GitHub REST API.

**Spec:** `docs/specs/2026-09-25-ci-standard-design.md` (rollout item 2; sections Architecture, Baseline, Security of Ward itself, Capturing new stacks item 3, Migration from workbench, Testing Ward itself, Rollout, Versions).

## Global Constraints

- English, first person, short direct sentences. No em dashes anywhere: not in code comments, docs, commit messages, PR bodies or this plan. Never a `Co-Authored-By` trailer or AI attribution in commits.
- Node **24** in every workflow and as the local floor (`engines: >=24`); scripts use the Node standard library only. Biome **2.5.14**: `npm run lint` is `biome ci .` and must exit 0 with clean output. Unit tests: `node --test "tools/*.test.mjs"` (`npm test`). Fixture tests: `npm run test:fixtures`. Both stay green; new totals are stated as "previous count + N", never invented.
- Every `uses:` of an action is pinned to a full 40-character commit SHA with a `# vX.Y.Z` comment. Both actions this plan needs already appear in `ci.yml`; reuse their SHAs (tag refs re-verified 2026-09-30 as commit objects):
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
  - `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`
- `pull_request`, never `pull_request_target`. No input, event field, `github.head_ref` or `secrets.*` inline in `run:`; values reach a script through `env:`. Scripts start processes as argument arrays (`spawnSync(cmd, [args])`), never shell strings.
- Every workflow sets `permissions: contents: read` at the top level. Every job that runs steps has `timeout-minutes`: 30 for `node`, `dotnet` and `fixtures`, 10 for everything else. Every workflow that runs steps sets `DOTNET_CLI_TELEMETRY_OPTOUT: "1"`, `ASTRO_TELEMETRY_DISABLED: "1"` and `WRANGLER_SEND_METRICS: "false"`.
- Every new module has a canned input it rejects (mutation rule). Public CI logs never print an email address unredacted; the audit prints repo names, paths, advisory URLs and run URLs only.
- Findings are `[kind, message]` pairs, the shape `repo-hygiene.mjs` already uses. Annotations are `::error::` (strict, fails) and `::warning::` (never fails). A script that fails sets `process.exitCode = 1`; nothing calls `process.exit`.
- Branch `feat/hygiene-audit` off `main`. Commit after every task. Commit author `malinfossum.dev@proton.me`. Merging, tagging, releasing, and any change to `.claude/` are Malin's calls.
- Any edit outside Ward (workbench, the five consumer repos, the morning skill) opens a PR or is gated on her explicit go; the agent never merges.

## Review Focus

Each line names an input the spec implies but no existing test covers, and the task whose tests now pin it.

1. A caller input written with quotes and a trailing comment (`node: "web" # the site`) must parse as `web`, not `"web" # the site`; a caller in an unknown layout reads as absent rather than crashing the run. Pinned in Task 4 (`parseCaller` tests).
2. A token without admin read on a repo (403 on the four settings endpoints) must report a `token` warning, never a silent pass or a false "off". Pinned in Task 4 (`checkBaseline` with `null` inputs).
3. The example `<NuGetAuditSuppress>` inside the comment block of `templates/Directory.Build.props` must not count as a suppression; a real one with a comment on the line above must. Pinned in Task 5 (`findSuppressions` reads the template).
4. `<TargetFrameworks>net8.0;net10.0-windows</TargetFrameworks>` (multi-target, OS suffix) must report net8.0 once and pass net10.0; `netstandard2.0` and `net472` are skipped, not flagged as unknown. Pinned in Task 5 (`checkRuntimes` tests).
5. A `canary.yml` that exists but has no completed run yet is a finding, while a missing workflow is only a warning. Pinned in Task 5 (`checkCanary` tests).
6. A caller whose `automerge` job points at `dependabot-automerge.yml@v1`, or at `./`, instead of a full commit SHA of Ward is a `caller` finding: that job holds write access. Pinned in Task 4 (`checkCaller` automerge test).
7. CodeQL default setup off is a finding only when the API lists a language to analyse; a docs-only repo with `languages: []` passes, and a response without the list still fails. Branch rules the token cannot read are a `token` warning, never an empty rule list that reads as a missing ruleset. Pinned in Task 4 (`checkBaseline` tests).
8. A `token` finding on one of my own repos, or on an org that has its own token, fails the run; without that, an expired audit token would turn every settings check into a silent pass. Pinned in Task 6 (`expectsAdminRead` test).
9. A kind named in `--warn-kinds` (today `caller`, until Plan 5) never counts toward the hard total, and the same kind without the flag does. Pinned in Task 6 (`warnKindsFor` test).

## Reference facts (verified 2026-09-30)

- Ward unit tests today: 68 pass. Fixture tests: 10 pass. `main` is at `c86b6c3` and later; `v1.0.0` and `v1` both dereference to commit `2939fee7aac178f0fdbc4ee9505a3e0464314e0c` (the tag objects themselves are `6a24009...` and `b819771...`, which is the trap: pin commits, not tag objects).
- Workbench `origin/main` is `e50aa30d6e25eb79015c7431829cb5390a0f77d0`; it holds PR #36's fix (the `/user` 403 catch), which Task 2 removes along with the `/user` probe: the sweep lists public repos through `/users/{owner}/repos`, which answers for an org login too and never returns a private repo (verified 2026-09-30: 51 listed under `malinfossum`, 46 non-fork, 0 private). The local workbench checkout is 4 commits behind: pull first.
- Consumers on `malinfossum/workbench/.github/workflows/repo-hygiene.yml@main`: the six scaffolds and the repos hugin, malinfossum, profile-dashboard, spindle, varde (all on `main`, none archived). Line 3 of each consumer file is the comment `# The checker lives in malinfossum/workbench` followed by an em dash and `docs/repo-hygiene.md.`; line 18 is the `uses:` line. Workbench has no caller of its own (its `.github/workflows/` holds `ci.yml`, `repo-audit.yml`, `repo-hygiene.yml`).
- `PROFILE_README_TOKEN` exists only on `malinfossum/profile-dashboard` (created 2026-07-17) and is used to push the profile README, so it holds Contents write on `malinfossum/malinfossum` and nothing the audit needs. Neither Ward nor workbench has any secret.
- Endpoints and what they need, probed on `malinfossum/ward`: `GET /repos/{r}/automated-security-fixes` (200 `{enabled, paused}`), `GET /repos/{r}/vulnerability-alerts` (204 on, 404 off) and `GET /repos/{r}/code-scanning/default-setup` (200 `{state: "configured", ...}`) all return 401 without a token and are documented as "admin read access": fine-grained permission **Administration (read)**. `security_and_analysis` on `GET /repos/{r}` is absent without admin access. `rules/branches/{branch}`, `actions/workflows/{file}/runs`, `contents/{path}` and `git/trees/{branch}?recursive=1` answer unauthenticated on a public repo (Metadata / Contents read). A fine-grained token is scoped to one resource owner, so one token cannot cover `malinfossum`, `rookdex` and `wendhq`. `GET /repos/{r}/code-scanning/default-setup` lists `languages` even when `state` is `not-configured` (the profile repo answers `["actions"]`), so a repo with nothing to analyse can be told from one with CodeQL off.
- Canary: `GET /repos/malinfossum/ward/actions/workflows/canary.yml/runs` is 404 today; `gh run list --workflow canary.yml` exits 1 with `HTTP 404: workflow canary.yml not found`. A completed run looks like `{"conclusion":"success","updatedAt":"2026-09-30T10:00:34Z"}` in `gh run list --json conclusion,updatedAt`.
- End of life (endoflife.date): .NET 8 and 9 on 2026-11-10, .NET 10 on 2028-11-14; Node 20 on 2026-04-30, Node 22 on 2027-04-30, Node 24 on 2028-04-30, Node 26 on 2029-04-30.
- The morning skill lives at `~/.claude/skills/morning/SKILL.md`. It is a plain directory, not a junction into loadout; `~/.claude` is itself a git repo (my private harness repo) that tracks `skills/morning/SKILL.md`. Edits there are committed in that repo.
- Running Ward's Biome over the workbench files: `npx biome check --write` fixes import order and formatting; two `useOptionalChain` warnings remain (`!data || !data.content` and the `process.argv[1] &&` main guard), both replaced by Task 2.

## File map

| File | Responsibility |
|---|---|
| `stacks.json` | Detection rules: which files mean which module, and the caller input each module needs |
| `tools/stacks.mjs` + `.test.mjs` | `loadStacks()`, `detectStacks(paths, stacks)` |
| `tools/repo-hygiene.mjs` + `.test.mjs` | README drift checker, migrated from workbench |
| `tools/repo-audit.mjs` + `.test.mjs` | Baseline, caller, inputs, suppressions, runtimes, canary; thin API layer; CLI |
| `tools/workflows.test.mjs` | Extended: permissions, timeouts, telemetry, secret-holding triggers, `job.workflow_sha` fetch |
| `.github/workflows/repo-hygiene.yml` | Reusable hygiene workflow |
| `.github/workflows/repo-audit.yml` | Weekly sweep: hygiene `--all` + audit, strict |
| `.github/workflows/ward.yml` | Ward's own caller gains the hygiene job |
| `docs/repo-hygiene.md`, `docs/repo-audit.md` | What each check does and how to run it |
| `README.md`, `package.json`, spec | Layout rows, version 1.1.0, Plan 2 deviations |
| `LICENSE` | MIT, the same text as workbench's |
| workbench: `.github/workflows/repo-hygiene.yml` (forwarder), 6 scaffold callers, README | After the release |
| 5 consumer repos: `.github/workflows/repo-hygiene.yml` | One PR each |
| `~/.claude/skills/morning/SKILL.md` | Monday watchdog line (gated) |

---

### Task 1: Branch, `stacks.json` and stack detection

**Files:**
- Create: `stacks.json`, `tools/stacks.mjs`
- Test: `tools/stacks.test.mjs`

**Interfaces:**
- Produces: `loadStacks() → { ignore: string[], modules: { name, input, status: "shipped"|"planned", files: string[] }[] }`; `detectStacks(paths: string[], stacks) → { name, input, status, files: string[] }[]` (only modules with at least one matching path, in `stacks.json` order). Task 4 consumes both.

- [ ] **Step 1: Branch**

```bash
git switch main && git pull --ff-only && git switch -c feat/hygiene-audit
npm ci && npm test && npm run test:fixtures && npm run lint
```
Expected: 68 unit tests and 10 fixture tests pass, lint exits 0. Note both numbers; later tasks add to them.

- [ ] **Step 2: Write the failing tests**

`tools/stacks.test.mjs`:
```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectStacks, loadStacks } from "./stacks.mjs";

const stacks = loadStacks();
const names = (paths) => detectStacks(paths, stacks).map((s) => s.name);

test("stacks.json lists node and dotnet as shipped, with the caller input each needs", () => {
  const shipped = stacks.modules.filter((m) => m.status === "shipped");
  assert.deepEqual(
    shipped.map((m) => [m.name, m.input]),
    [
      ["node", "node"],
      ["dotnet", "dotnet"],
    ],
  );
  for (const module of stacks.modules) {
    assert.ok(["shipped", "planned"].includes(module.status), module.name);
    assert.ok(module.files.length > 0, `${module.name} has no detection files`);
  }
});

test("a package.json at the root or in a folder means node", () => {
  assert.deepEqual(names(["package.json", "src/app.js"]), ["node"]);
  assert.deepEqual(names(["web/package.json"]), ["node"]);
  assert.deepEqual(detectStacks(["web/package.json"], stacks)[0].files, ["web/package.json"]);
});

test("a solution or project file means dotnet", () => {
  assert.deepEqual(names(["App.slnx", "src/App/App.csproj"]), ["dotnet"]);
  assert.deepEqual(names(["Legacy.sln"]), ["dotnet"]);
});

test("files under node_modules, bin and obj are ignored, but a folder named cabin is not", () => {
  assert.deepEqual(names(["node_modules/x/package.json", "src/bin/Debug/App.csproj"]), []);
  assert.deepEqual(names(["cabin/package.json"]), ["node"]);
});

test("a stack no module covers is reported as planned", () => {
  const [python] = detectStacks(["pyproject.toml"], stacks);
  assert.equal(python.name, "python");
  assert.equal(python.status, "planned");
  assert.equal(python.input, "");
});

test("a repo with only docs has no stacks", () => {
  assert.deepEqual(names(["README.md", "docs/a.md"]), []);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test tools/stacks.test.mjs`
Expected: FAIL, `Cannot find module` for `./stacks.mjs`.

- [ ] **Step 4: Write `stacks.json`**

```json
{
  "$comment": "Detection rules for Ward's stack modules. A path matches a module when its basename equals a pattern, or ends with the pattern's suffix when the pattern starts with `*`, and no ignore prefix appears as a path segment. status shipped: ci.yml has the module and the caller input named here must be set. status planned: files are reported as an uncovered stack until the module ships (Plan 6). Plan 3's skill reads the same file to write a caller.",
  "ignore": ["node_modules/", "bin/", "obj/", ".git/"],
  "modules": [
    { "name": "node", "input": "node", "status": "shipped", "files": ["package.json"] },
    {
      "name": "dotnet",
      "input": "dotnet",
      "status": "shipped",
      "files": ["*.sln", "*.slnx", "*.csproj"]
    },
    {
      "name": "python",
      "input": "",
      "status": "planned",
      "files": ["pyproject.toml", "requirements.txt"]
    },
    { "name": "powershell", "input": "", "status": "planned", "files": ["*.ps1", "*.psm1"] },
    { "name": "docker", "input": "", "status": "planned", "files": ["Dockerfile", "*.Dockerfile"] }
  ]
}
```

- [ ] **Step 5: Write `tools/stacks.mjs`**

```js
// Reads stacks.json, the rules that say which Ward module a repo's files need.
// The audit compares a repo's tree against them; Plan 3's skill will use the
// same rules to write a caller. An uncovered stack is reported, never guessed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function loadStacks() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "stacks.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

// A pattern is a basename, or a suffix when it starts with `*`.
function matches(pattern, basename) {
  return pattern.startsWith("*") ? basename.endsWith(pattern.slice(1)) : basename === pattern;
}

// Ignore prefixes match whole path segments: `bin/` skips `src/bin/x` but not `cabin/x`.
function ignored(path, prefixes) {
  const segmented = `/${path}`;
  return prefixes.some((prefix) => segmented.includes(`/${prefix}`));
}

// paths are repo-relative with forward slashes, as the git tree lists them.
export function detectStacks(paths, stacks) {
  const kept = paths.filter((path) => !ignored(path, stacks.ignore));
  return stacks.modules
    .map((module) => ({
      name: module.name,
      input: module.input,
      status: module.status,
      files: kept.filter((path) => {
        const basename = path.slice(path.lastIndexOf("/") + 1);
        return module.files.some((pattern) => matches(pattern, basename));
      }),
    }))
    .filter((module) => module.files.length > 0);
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test tools/stacks.test.mjs` → 6 pass. Run: `npx biome check --write stacks.json tools/stacks.mjs tools/stacks.test.mjs && npm run lint` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add stacks.json tools/stacks.mjs tools/stacks.test.mjs
git commit -m "Add stacks.json and the stack detection the audit and the skill share"
```

---

### Task 2: Migrate the README drift checker

**Files:**
- Create: `tools/repo-hygiene.mjs`, `tools/repo-hygiene.test.mjs`, `docs/repo-hygiene.md`

**Interfaces:**
- Produces (unchanged from workbench): `tokenize`, `overlap`, `readmeIntro`, `readmeTitle`, `manifestDeps`, `manifestVersion`, `compareVersions`, `extractLinks`, `extractLocalRefs`, `liveUrlInReadme`, `checkMetadata`, `checkStack`, `checkVersions`, `checkLinks`.
- Produces (new exports Task 6 consumes): `contentsPath(path: string): string`; `api(path: string, token: string): Promise<object|null>` (null on 404, throws on other errors); `fetchFile(repo: string, path: string, token: string): Promise<string|null>`; `listRepos(owners: string[], token: string): Promise<object[]>` (public, non-fork, non-`.github`, sorted by `full_name`, paged in hundreds).
- CLI: `node tools/repo-hygiene.mjs --repo owner/name [--path .] [--mode warn|strict]` or `--all --owner a,b [--include-archived] [--mode strict]`. Token from `GITHUB_TOKEN` only (the sweep reads public data). Findings on a non-archived repo print as `::error::` in strict mode and `::warning::` otherwise; exit code 1 only in strict mode with findings.

- [ ] **Step 1: Copy the files from workbench at `origin/main`**

```bash
git -C ../workbench fetch --quiet origin
git -C ../workbench show e50aa30d6e25eb79015c7431829cb5390a0f77d0:tools/repo-hygiene.mjs > tools/repo-hygiene.mjs
git -C ../workbench show e50aa30d6e25eb79015c7431829cb5390a0f77d0:tools/repo-hygiene.test.mjs > tools/repo-hygiene.test.mjs
npx biome check --write tools/repo-hygiene.mjs tools/repo-hygiene.test.mjs
node --test tools/repo-hygiene.test.mjs
```
Expected: 20 tests pass before any edit. Biome rewrote import order and formatting only.

- [ ] **Step 2: Add the failing test for the new helper**

Append to `tools/repo-hygiene.test.mjs`, and add `contentsPath` to the import list:
```js
test("contentsPath encodes each segment and keeps the slashes", () => {
  assert.equal(contentsPath(".github/workflows/ward.yml"), ".github/workflows/ward.yml");
  assert.equal(contentsPath("src/My App/App.csproj"), "src/My%20App/App.csproj");
});
```
Run: `node --test tools/repo-hygiene.test.mjs` → FAIL, `contentsPath` is not exported.

- [ ] **Step 3: Apply the Ward conventions to `tools/repo-hygiene.mjs`**

Make exactly these edits; everything else stays as copied.

1. Imports (top of file) become:
```js
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
```
2. The file holds three em dashes (U+2014; in Git Bash `grep -n $'\xe2\x80\x94' tools/repo-hygiene.mjs` lists them: two in `report()`, one in the archived `<details>` summary in `main()`). The two in `report()` are replaced by the new `report()` in item 5 below. The summary line becomes `Archived repos (read-only, unarchive to fix)`.
3. `api` and `fetchFile` become exports, and `fetchFile` encodes per segment so nested paths work:
```js
export const contentsPath = (path) => path.split("/").map(encodeURIComponent).join("/");

export async function api(path, token) {
  // body unchanged
}

export async function fetchFile(repo, path, token) {
  const data = await api(`/repos/${repo}/contents/${contentsPath(path)}`, token);
  if (!data?.content) return null;
  return Buffer.from(data.content, "base64").toString("utf8");
}
```
4. Lift the repo listing out of `main()` into an export placed right after `fetchFile`, so the audit can reuse it. It lists through the public endpoint only, paged, so the sweep's scope is public repos by construction and no token that can list private repos is ever needed:
```js
// Every public, non-fork repo the owners have, sorted, paged in hundreds. The
// public listing is the sweep's scope by construction: private repos keep
// Actions off and sit outside the standard, so no token that can list them is
// needed. /users/{owner}/repos answers for an org login too. An org's .github
// repo keeps its README at profile/README.md and has no public face of its own.
export async function listRepos(owners, token) {
  const repos = [];
  for (const owner of owners) {
    for (let page = 1; ; page++) {
      const batch =
        (await api(`/users/${owner}/repos?per_page=100&type=owner&page=${page}`, token)) ?? [];
      repos.push(...batch.filter((r) => r.owner.login.toLowerCase() === owner.toLowerCase()));
      if (batch.length < 100) break;
    }
  }
  return repos
    .filter((r) => !r.fork && r.name !== ".github")
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}
```
In `main()`, the `--all` branch then reads:
```js
    const includeArchived = argv.includes("--include-archived");
    let archivedSummary = "";
    for (const meta of await listRepos(owners, token)) {
      // Private repos sit outside the standard (spec, Out of scope). The public
      // listing never returns one; kept so that a token or endpoint change can
      // never widen the sweep.
      if (meta.private) continue;
      if (meta.archived && !includeArchived) continue;
      const files = {};
      // ... the rest of the loop body unchanged (fetchFile per name, auditRepo, report)
```
and the old `me`, `repos`, `.sort(...)`, `if (meta.fork) continue;` and `if (meta.name === ".github") continue;` lines are gone, together with the `/user` probe and its 403 catch.
5. `report()` takes a level and annotates, so a finding shows on the PR and the run summary:
```js
// level: "error" fails the job (strict), "warning" does not, "" prints plainly (archived).
function report(name, findings, level) {
  if (!findings.length) {
    console.log(`OK   ${name}`);
    return "";
  }
  console.log(`DRIFT ${name}: ${findings.length} finding(s)`);
  const lines = [`### ${name}`, ""];
  for (const [kind, message] of findings) {
    const first = message.split("\n")[0];
    console.log(level ? `::${level}::${name} [${kind}] ${first}` : `  [${kind}] ${first}`);
    lines.push(`- **${kind}**: ${first}`);
  }
  lines.push("");
  return lines.join("\n");
}
```
Callers: `report(\`${meta.full_name} (archived)\`, findings, "")`, `report(meta.full_name, findings, strict ? "error" : "warning")`, and in the `--repo` branch `report(repo, findings, strict ? "error" : "warning")`. The multi-line `description` finding now shows its first line only, in the console as well as the summary; the repo description and README intro it quoted are both public and one click away.
6. The token line in `main()` becomes
```js
  // The sweep reads public data only, so the Actions token is all it needs.
  const token = process.env.GITHUB_TOKEN || "";
```
(the profile-dashboard secret name is gone from this file).
7. Exit and error handling at the bottom of the file:
```js
  if (process.env.GITHUB_STEP_SUMMARY && summary) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Repo hygiene\n\n${summary}`);
  }
  console.log(total ? `${total} finding(s).` : "No findings.");
  process.exitCode = total && strict ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
```
(the dynamic `await import("node:fs")` is gone; `appendFileSync` is imported at the top.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tools/repo-hygiene.test.mjs` → 21 pass. Run: `npx biome check --write tools/repo-hygiene.mjs && npm run lint` → exit 0 with no `useOptionalChain` warning left.
Run (Git Bash, a live smoke test on Ward itself): `GITHUB_TOKEN=$(gh auth token) node tools/repo-hygiene.mjs --repo malinfossum/ward --path .`
Expected (verified 2026-09-30 against the migrated code): `DRIFT malinfossum/ward: 1 finding(s)` with `::warning::malinfossum/ward [stack] In the manifests but never named in the README: xunit.`, then `1 finding(s).`, exit 0 (warn mode). The checker reads every `.csproj`, fixtures included, and the dotnet fixtures are xUnit projects. Fix it in `README.md`: the `fixtures/`, `tests/` row of the Layout table becomes
```markdown
| `fixtures/`, `tests/` | Known-good and known-broken projects (the C# ones are xUnit) and the tests that run them |
```
Rerun the command: `OK   malinfossum/ward` and `No findings.`. Any other `stack`, `version`, `title` or `links` finding is fixed in the README the same way; a `description`, `topics` or `homepage` finding is a repo setting, so report it to Malin instead (Task 8's weekly strict run would otherwise go red on it). Run `--mode strict` once too: exit 1 while the finding exists, exit 0 after the fix. Add `README.md` to the commit below.

- [ ] **Step 5: Write `docs/repo-hygiene.md`**

````markdown
# Repo hygiene

A README goes stale quietly. The description still describes last year's idea, the Stack section
never heard about the framework I switched to, the live link 404s. This check reads a repo's public
face and compares it against what is actually in the repo.

The checker is [`tools/repo-hygiene.mjs`](../tools/repo-hygiene.mjs). It has no dependencies and
runs on Node 24. It moved here from workbench in Ward 1.1.0.

## What it checks

| Check | Fails when |
|---|---|
| `description` | The GitHub description and the README's opening line have drifted apart, or the description is empty |
| `topics` | Fewer than three topics |
| `homepage` | The README links a deployed site (Pages, Cloudflare, Azure, Vercel, Netlify) but the repo has no homepage set |
| `title` | The H1 is the lowercase repo slug instead of the project's name |
| `stack` | A notable dependency in `package.json` or a `.csproj` is never named in the README |
| `version` | The manifest version is behind the latest release, or the README quotes an older version as current |
| `links` | A relative link points at a file that isn't there, or an external link returns an error |

`stack` only looks at dependencies worth naming: frameworks, build tools, test runners, ORMs. The
list is `NOTABLE` at the top of the checker; add to it when something belongs in a README.

## Running it

```bash
# One repo, from its checkout
node tools/repo-hygiene.mjs --repo malinfossum/spindle --path ../spindle

# Every repo I own, archived included. --owner takes a list, for my orgs.
GITHUB_TOKEN=$(gh auth token) node tools/repo-hygiene.mjs --all --owner malinfossum,rookdex,wendhq --include-archived
```

`--mode strict` exits 1 on findings and annotates them as errors; the default `warn` annotates them
as warnings and exits 0.

## Wiring a repo into it

Drop this in `.github/workflows/repo-hygiene.yml`. Every workbench scaffold ships it.

```yaml
name: Repo hygiene

on:
  push:
    branches: [main]
    paths: ["README.md"]
  pull_request:
    paths: ["README.md"]
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  hygiene:
    uses: malinfossum/ward/.github/workflows/repo-hygiene.yml@v1
    with:
      mode: ${{ (github.event_name == 'push' || github.event_name == 'pull_request') && 'warn' || 'strict' }}
```

Touching a README warns; a release fails the run. **GitHub has no pre-release hook**: `release:
published` fires the moment the release goes live, not before it. To gate a release properly, run
the check by hand (`workflow_dispatch`, or the command above) before cutting the tag; the automatic
run is the net that catches what I forget.

Org `.github` repos are skipped: their README lives at `profile/README.md` and describes the org,
not the repo.

## Archived repos

Archived repos are read-only: their topics, description and files cannot change until they are
unarchived. The weekly audit ([`docs/repo-audit.md`](repo-audit.md)) reports them in a collapsed
section and never fails on them.
````

- [ ] **Step 6: Commit**

```bash
git add tools/repo-hygiene.mjs tools/repo-hygiene.test.mjs docs/repo-hygiene.md README.md
git commit -m "Move the README drift checker in from workbench"
```

---

### Task 3: The reusable hygiene workflow and the workflow guards

**Files:**
- Create: `.github/workflows/repo-hygiene.yml`
- Modify: `tools/workflows.test.mjs` (append four tests and two helpers; Task 7 appends a fifth test)

**Interfaces:**
- Consumes: `tools/repo-hygiene.mjs` CLI from Task 2.
- Produces: reusable workflow `malinfossum/ward/.github/workflows/repo-hygiene.yml` with input `mode` (`warn` default, or `strict`), job `hygiene` (check name `<caller job> / hygiene`). Tasks 7, 8, 10 and 11 call it. Helpers `workflows` (file list) and `readWorkflow(file)` in `tools/workflows.test.mjs`, which Task 7's test uses.

- [ ] **Step 1: Write the failing tests**

Append to `tools/workflows.test.mjs`:
```js
// The rest of this file guards what Global Constraints promise for every
// workflow, so a new workflow cannot quietly drop them.
const workflows = readdirSync(".github/workflows").map((f) => join(".github/workflows", f));
const readWorkflow = (file) => readFileSync(file, "utf8");

// The jobs: block as { name, body } pairs; body holds the job's indented lines.
function jobsOf(file) {
  const section = readWorkflow(file).split(/^jobs:\r?\n/m)[1] ?? "";
  const out = [];
  for (const line of section.split(/\r?\n/)) {
    const head = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (head) out.push({ name: head[1], body: "" });
    else if (out.length) out.at(-1).body += `${line}\n`;
  }
  return out;
}

test("every workflow grants only contents: read at the top level", () => {
  // The line after `contents: read` must not be another permission.
  for (const file of workflows) {
    assert.match(readWorkflow(file), /^permissions:\r?\n {2}contents: read\r?\n(?! )/m, file);
  }
});

test("every job that runs steps has a 10 or 30 minute timeout", () => {
  let checked = 0;
  for (const file of workflows) {
    for (const job of jobsOf(file)) {
      if (!/^ {4}runs-on:/m.test(job.body)) continue;
      checked++;
      assert.match(job.body, /^ {4}timeout-minutes: (10|30)$/m, `${file}: job ${job.name}`);
    }
  }
  assert.ok(checked > 0, "no job with runs-on was scanned");
});

test("every workflow that runs steps turns telemetry off", () => {
  for (const file of workflows) {
    if (!/^ {4}runs-on:/m.test(readWorkflow(file))) continue;
    for (const name of ["DOTNET_CLI_TELEMETRY_OPTOUT", "ASTRO_TELEMETRY_DISABLED", "WRANGLER_SEND_METRICS"]) {
      assert.match(readWorkflow(file), new RegExp(`^\\s+${name}:`, "m"), `${file}: ${name}`);
    }
  }
});

test("every reusable workflow fetches Ward's tools at its own commit", () => {
  let checked = 0;
  for (const file of workflows) {
    if (!/^ {2}workflow_call:/m.test(readWorkflow(file))) continue;
    checked++;
    assert.match(readWorkflow(file), /repository: \$\{\{ job\.workflow_repository \}\}/, file);
    assert.match(readWorkflow(file), /ref: \$\{\{ job\.workflow_sha \}\}/, file);
  }
  assert.equal(checked, 3, "ci.yml, dependabot-automerge.yml and repo-hygiene.yml");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tools/workflows.test.mjs`
Expected: "every reusable workflow" fails (2 reusable workflows, not 3). The other three new tests pass on the existing workflows.

- [ ] **Step 3: Write `.github/workflows/repo-hygiene.yml`**

```yaml
# Reusable: checks a repo's public face (description, topics, homepage, Stack
# section, versions, links) against its README. A repo calls this from its own
# repo-hygiene.yml; the caller in docs/repo-hygiene.md shows the triggers.
name: Repo hygiene

on:
  workflow_call:
    inputs:
      mode:
        description: warn (report only) or strict (fail the job on drift)
        type: string
        default: warn

permissions:
  contents: read

env:
  DOTNET_CLI_TELEMETRY_OPTOUT: "1"
  ASTRO_TELEMETRY_DISABLED: "1"
  WRANGLER_SEND_METRICS: "false"

jobs:
  hygiene:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Fetch Ward's tools at this workflow's commit
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: ${{ job.workflow_repository }}
          ref: ${{ job.workflow_sha }}
          path: .ward
          sparse-checkout: tools
          persist-credentials: false
      - run: mv .ward "$RUNNER_TEMP/ward"
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
      - name: The README matches the repo
        env:
          GITHUB_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          MODE: ${{ inputs.mode }}
        run: node "$RUNNER_TEMP/ward/tools/repo-hygiene.mjs" --repo "$REPO" --mode "$MODE"
```

- [ ] **Step 4: Run the tests**

Run: `node --test tools/workflows.test.mjs` → 6 + 4 = 10 pass. `npm run lint` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/repo-hygiene.yml tools/workflows.test.mjs
git commit -m "Add the reusable hygiene workflow and guard every workflow's permissions, timeouts and telemetry"
```

---

### Task 4: Audit checks, part one: caller, inputs, baseline

**Files:**
- Create: `tools/repo-audit.mjs`
- Test: `tools/repo-audit.test.mjs`

**Interfaces:**
- Consumes: `requiredChecksFrom` from `tools/automerge.mjs`; `detectStacks`, `loadStacks` from Task 1.
- Produces: constants `WARD = "malinfossum/ward"`, `REQUIRED_USES = "malinfossum/ward/.github/workflows/ci.yml@v1"`, `SELF_USES = "./.github/workflows/ci.yml"`, `REQUIRED_CHECK = "ward / gate"`, `WARN_KINDS: Set<string>` (`uncovered`, `canary-missing`, `token`); `parseCaller(text: string) → { uses: string, inputs: Record<string, string>, automerge: string } | null`; `checkCaller(text: string | null, { self: boolean }) → [kind, message][]`; `checkInputs(inputs: Record<string,string> | null, detected: ReturnType<detectStacks>, paths: string[]) → findings`; `checkBaseline({ securityUpdates, alerts, analysis, codeScanning, rules }) → findings` (each field `null` when the token could not read it, `rules` included). Task 5 appends to the same file; Task 6 adds the API layer and CLI.

- [ ] **Step 1: Write the failing tests**

`tools/repo-audit.test.mjs`:
```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBaseline, checkCaller, checkInputs, parseCaller, WARN_KINDS } from "./repo-audit.mjs";
import { detectStacks, loadStacks } from "./stacks.mjs";

const stacks = loadStacks();
const kinds = (findings) => findings.map(([kind]) => kind);

const CALLER = `name: Ward
on:
  pull_request:
permissions:
  contents: read
jobs:
  ward:
    uses: malinfossum/ward/.github/workflows/ci.yml@v1
    with:
      node: "web" # the site
      a11y: 'warn'
      dotnet: api/App.slnx
      dotnet-ef-project: ""

  automerge:
    if: github.event_name == 'pull_request'
    uses: malinfossum/ward/.github/workflows/dependabot-automerge.yml@2939fee7aac178f0fdbc4ee9505a3e0464314e0c # v1.0.0
    with:
      required-check: ward / gate
`;

test("parseCaller reads the ci.yml ref and its inputs, stripping quotes and comments", () => {
  const caller = parseCaller(CALLER);
  assert.equal(caller.uses, "malinfossum/ward/.github/workflows/ci.yml@v1");
  assert.deepEqual(caller.inputs, {
    node: "web",
    a11y: "warn",
    dotnet: "api/App.slnx",
    "dotnet-ef-project": "",
  });
});

test("parseCaller reads a caller with no with: block, and none for a file that never calls ci.yml", () => {
  const bare = "jobs:\n  ward:\n    uses: malinfossum/ward/.github/workflows/ci.yml@v1\n";
  assert.deepEqual(parseCaller(bare), {
    uses: "malinfossum/ward/.github/workflows/ci.yml@v1",
    inputs: {},
    automerge: "",
  });
  assert.equal(parseCaller("jobs:\n  build:\n    runs-on: ubuntu-latest\n"), null);
});

test("checkCaller wants ward.yml present and on @v1", () => {
  assert.deepEqual(kinds(checkCaller(null, { self: false })), ["caller"]);
  assert.deepEqual(
    kinds(checkCaller("jobs:\n  x:\n    runs-on: ubuntu-latest\n", { self: false })),
    ["caller"],
  );
  const pinned = CALLER.replace("ci.yml@v1", "ci.yml@2939fee7aac178f0fdbc4ee9505a3e0464314e0c");
  const [finding] = checkCaller(pinned, { self: false });
  assert.equal(finding[0], "caller");
  assert.match(finding[1], /must be malinfossum\/ward\/\.github\/workflows\/ci\.yml@v1/);
  assert.deepEqual(checkCaller(CALLER, { self: false }), []);
});

test("Ward itself may call ci.yml by local path; nobody else may", () => {
  const local = "jobs:\n  ward:\n    uses: ./.github/workflows/ci.yml\n    with:\n      node: .\n";
  assert.deepEqual(checkCaller(local, { self: true }), []);
  assert.deepEqual(kinds(checkCaller(local, { self: false })), ["caller"]);
  assert.deepEqual(parseCaller(local).inputs, { node: "." });
});

test("the automerge job must point at Ward's dependabot-automerge.yml at a full commit SHA", () => {
  const sha = "2939fee7aac178f0fdbc4ee9505a3e0464314e0c";
  assert.equal(
    parseCaller(CALLER).automerge,
    `malinfossum/ward/.github/workflows/dependabot-automerge.yml@${sha}`,
  );
  const floating = CALLER.replace(
    `dependabot-automerge.yml@${sha} # v1.0.0`,
    "dependabot-automerge.yml@v1",
  );
  const [finding] = checkCaller(floating, { self: false });
  assert.equal(finding[0], "caller");
  assert.match(finding[1], /automerge job uses .*@v1; it must be .* at a full commit SHA/);
  const local = CALLER.replace(
    `malinfossum/ward/.github/workflows/dependabot-automerge.yml@${sha} # v1.0.0`,
    "./.github/workflows/dependabot-automerge.yml",
  );
  assert.deepEqual(kinds(checkCaller(local, { self: true })), ["caller"]);
  assert.deepEqual(checkCaller(CALLER, { self: false }), []);
});

test("a stack whose module is off in the caller is a finding", () => {
  const paths = ["package.json", "api/App.slnx", "api/App/App.csproj"];
  const detected = detectStacks(paths, stacks);
  const findings = checkInputs({ node: "." }, detected, paths);
  assert.deepEqual(kinds(findings), ["inputs"]);
  assert.match(
    findings[0][1],
    /dotnet files .*api\/App\.slnx.* but the caller's dotnet input is empty/,
  );
  assert.equal(checkInputs({ node: ".", dotnet: "" }, detected, paths).length, 1);
  assert.deepEqual(checkInputs({ node: ".", dotnet: "api/App.slnx" }, detected, paths), []);
});

test("an input that points at nothing on the default branch is a finding", () => {
  const paths = ["web/package.json", "src/App/App.csproj"];
  const detected = detectStacks(paths, stacks);
  const findings = checkInputs({ node: "site", dotnet: "src/Old.slnx" }, detected, paths);
  assert.deepEqual(kinds(findings), ["inputs", "inputs"]);
  assert.match(findings[0][1], /site\/package\.json is not on the default branch/);
  assert.match(findings[1][1], /src\/Old\.slnx, which is not on the default branch/);
  assert.deepEqual(checkInputs({ node: "web", dotnet: "src/App" }, detected, paths), []);
});

test("a planned stack is an uncovered warning, with or without a caller", () => {
  const paths = ["pyproject.toml", "package.json"];
  const detected = detectStacks(paths, stacks);
  const withCaller = checkInputs({ node: "." }, detected, paths);
  assert.deepEqual(kinds(withCaller), ["uncovered"]);
  assert.ok(WARN_KINDS.has("uncovered"));
  assert.deepEqual(kinds(checkInputs(null, detected, paths)), ["uncovered"]);
});

const baseline = {
  securityUpdates: { enabled: true, paused: false },
  alerts: true,
  analysis: {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  },
  codeScanning: { state: "configured" },
  rules: [
    { type: "deletion" },
    { type: "pull_request", parameters: { required_approving_review_count: 0 } },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "ward / gate" }] },
    },
  ],
};

test("the full baseline passes", () => {
  assert.deepEqual(checkBaseline(baseline), []);
});

test("each baseline setting that is off is its own finding", () => {
  const off = {
    securityUpdates: { enabled: false, paused: false },
    alerts: false,
    analysis: {
      secret_scanning: { status: "disabled" },
      secret_scanning_push_protection: { status: "disabled" },
    },
    codeScanning: { state: "not-configured" },
    rules: [],
  };
  const findings = checkBaseline(off);
  assert.deepEqual(kinds(findings), [
    "baseline",
    "baseline",
    "baseline",
    "baseline",
    "baseline",
    "ruleset",
    "ruleset",
  ]);
  assert.match(findings[5][1], /does not require a pull request/);
  assert.match(findings[6][1], /"ward \/ gate"/);
});

test("paused security updates and a ruleset without the gate are findings", () => {
  const paused = { ...baseline, securityUpdates: { enabled: true, paused: true } };
  assert.deepEqual(kinds(checkBaseline(paused)), ["baseline"]);
  const noGate = { ...baseline, rules: baseline.rules.slice(0, 2) };
  assert.deepEqual(kinds(checkBaseline(noGate)), ["ruleset"]);
});

test("CodeQL off is a finding only where CodeQL has a language to analyse", () => {
  const docsOnly = { ...baseline, codeScanning: { state: "not-configured", languages: [] } };
  assert.deepEqual(checkBaseline(docsOnly), []);
  const withCode = {
    ...baseline,
    codeScanning: { state: "not-configured", languages: ["actions"] },
  };
  assert.deepEqual(kinds(checkBaseline(withCode)), ["baseline"]);
});

test("a setting the token cannot read is a token warning, not a pass and not a false red", () => {
  const unreadable = {
    securityUpdates: null,
    alerts: null,
    analysis: null,
    codeScanning: null,
    rules: null,
  };
  const findings = checkBaseline(unreadable);
  assert.deepEqual(kinds(findings), ["token"]);
  assert.match(findings[0][1], /Administration \(read\)/);
  assert.match(findings[0][1], /branch rules/);
  assert.ok(WARN_KINDS.has("token"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tools/repo-audit.test.mjs` → FAIL, `Cannot find module` for `./repo-audit.mjs`.

- [ ] **Step 3: Implement**

`tools/repo-audit.mjs` (Task 5 appends more checks below `checkBaseline`; Task 6 appends the API layer and `main`):
```js
// The weekly audit over every repo I own: the baseline settings are on, the
// caller is present on @v1 with the inputs the repo's stacks need, every NuGet
// audit suppression carries a dated reason, no runtime is near end of life,
// and Ward's canary is alive. Each check is a pure function over fetched data
// that returns [kind, message] findings; main() only fetches and reports.
import { requiredChecksFrom } from "./automerge.mjs";

export const WARD = "malinfossum/ward";
export const REQUIRED_USES = "malinfossum/ward/.github/workflows/ci.yml@v1";
export const SELF_USES = "./.github/workflows/ci.yml";
export const REQUIRED_CHECK = "ward / gate";

// The auto-merge job holds write access, so its ref is a full commit SHA that
// I move by hand; a tag or branch would let that code change under the repo.
const AUTOMERGE_PINNED =
  /^malinfossum\/ward\/\.github\/workflows\/dependabot-automerge\.yml@[0-9a-f]{40}$/;

// Findings of these kinds are reported but never fail the run. canary-missing
// leaves this set in Plan 5, once canary.yml exists: from then on a missing
// canary is a failure, not "not yet".
export const WARN_KINDS = new Set(["uncovered", "canary-missing", "token"]);

const indentOf = (line) => line.match(/^\s*/)[0].length;
const unquote = (value) =>
  value
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");

// Reads the job that calls ci.yml out of a caller workflow: the ref it uses,
// its `with:` inputs, and the ref of the auto-merge job when there is one. The
// file is small and written by me or the skill, so a line-based parse is
// enough; a caller too odd to parse reads as absent.
export function parseCaller(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) =>
    /^\s*uses:\s*(malinfossum\/ward\/|\.\/)\.github\/workflows\/ci\.yml/.test(line),
  );
  if (at === -1) return null;
  const uses = unquote(lines[at].replace(/^\s*uses:\s*/, ""));
  const indent = indentOf(lines[at]);
  let withAt = -1;
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const depth = indentOf(lines[i]);
    if (depth < indent) break;
    if (depth === indent && /^\s*with:\s*$/.test(lines[i])) {
      withAt = i;
      break;
    }
  }
  const inputs = {};
  if (withAt !== -1) {
    for (const line of lines.slice(withAt + 1)) {
      if (line.trim() === "") continue;
      if (indentOf(line) <= indent) break;
      const match = line.match(/^\s*([\w-]+):\s*(.*)$/);
      if (match) inputs[match[1]] = unquote(match[2]);
    }
  }
  const automergeLine = lines.find((line) => /^\s*uses:\s*\S*dependabot-automerge\.yml/.test(line));
  const automerge = automergeLine ? unquote(automergeLine.replace(/^\s*uses:\s*/, "")) : "";
  return { uses, inputs, automerge };
}

// self: the repo is Ward, which dogfoods ci.yml by local path.
export function checkCaller(text, { self }) {
  if (text == null) return [["caller", "No .github/workflows/ward.yml on the default branch."]];
  const caller = parseCaller(text);
  if (!caller)
    return [["caller", "ward.yml does not call malinfossum/ward/.github/workflows/ci.yml."]];
  const findings = [];
  if (!(caller.uses === REQUIRED_USES || (self && caller.uses === SELF_USES))) {
    findings.push(["caller", `The caller uses ${caller.uses}; it must be ${REQUIRED_USES}.`]);
  }
  if (caller.automerge && !AUTOMERGE_PINNED.test(caller.automerge)) {
    findings.push([
      "caller",
      `The automerge job uses ${caller.automerge}; it must be malinfossum/ward/.github/workflows/dependabot-automerge.yml at a full commit SHA.`,
    ]);
  }
  return findings;
}

const sample = (files) => files.slice(0, 3).join(", ");

// A module the repo's files need must be on, and an input that is on must
// point at something on the default branch. A merged PR that turned a module
// off or moved a project shows up here. inputs is null when there is no caller;
// then only uncovered stacks are reported, the caller finding covers the rest.
export function checkInputs(inputs, detected, paths) {
  const findings = [];
  for (const stack of detected) {
    if (stack.status !== "shipped") {
      findings.push([
        "uncovered",
        `${stack.name} files (${sample(stack.files)}) but no Ward module covers them yet.`,
      ]);
      continue;
    }
    if (inputs && !(inputs[stack.input] ?? "")) {
      findings.push([
        "inputs",
        `${stack.name} files (${sample(stack.files)}) but the caller's ${stack.input} input is empty.`,
      ]);
    }
  }
  if (!inputs) return findings;
  const have = new Set(paths);
  const node = inputs.node ?? "";
  if (node) {
    const manifest = node === "." ? "package.json" : `${node.replace(/\/$/, "")}/package.json`;
    if (!have.has(manifest)) {
      findings.push([
        "inputs",
        `node points at ${node}, but ${manifest} is not on the default branch.`,
      ]);
    }
  }
  const dotnet = inputs.dotnet ?? "";
  if (dotnet && dotnet !== ".") {
    const target = dotnet.replace(/\/$/, "");
    const exists = have.has(target) || paths.some((path) => path.startsWith(`${target}/`));
    if (!exists) {
      findings.push(["inputs", `dotnet points at ${dotnet}, which is not on the default branch.`]);
    }
  }
  return findings;
}

// Each field is the API's answer, or null when the token could not read it
// (401/403, or anything but 200 for the branch rules). null is a warning,
// never a pass: a false green here would hide exactly what the audit exists
// to find, and an empty rule list in its place would be a false red.
export function checkBaseline({ securityUpdates, alerts, analysis, codeScanning, rules }) {
  const findings = [];
  const unreadable = [];
  if (alerts === null) unreadable.push("Dependabot alerts");
  else if (!alerts) findings.push(["baseline", "Dependabot alerts are off."]);
  if (securityUpdates === null) unreadable.push("Dependabot security updates");
  else if (!securityUpdates.enabled || securityUpdates.paused) {
    findings.push(["baseline", "Dependabot security updates are off or paused."]);
  }
  if (analysis == null) unreadable.push("secret scanning");
  else {
    if (analysis.secret_scanning?.status !== "enabled") {
      findings.push(["baseline", "Secret scanning is off."]);
    }
    if (analysis.secret_scanning_push_protection?.status !== "enabled") {
      findings.push(["baseline", "Push protection is off."]);
    }
  }
  if (codeScanning === null) unreadable.push("CodeQL default setup");
  else if (codeScanning.state !== "configured") {
    // The API lists the languages CodeQL would analyse even when setup is
    // off. A repo with none (docs only) cannot turn it on, so that is not a
    // finding; a response without the list is read as "can", to fail closed.
    const analysable = codeScanning.languages ? codeScanning.languages.length > 0 : true;
    if (analysable) findings.push(["baseline", "CodeQL default setup is not configured."]);
  }
  if (rules === null) unreadable.push("branch rules");
  else {
    const types = new Set(rules.map((rule) => rule.type));
    if (!types.has("pull_request")) {
      findings.push(["ruleset", "The default branch does not require a pull request."]);
    }
    if (!requiredChecksFrom(rules).includes(REQUIRED_CHECK)) {
      findings.push([
        "ruleset",
        `The default branch does not require the "${REQUIRED_CHECK}" check.`,
      ]);
    }
  }
  if (unreadable.length) {
    findings.push([
      "token",
      `The token cannot read: ${unreadable.join(", ")}. It needs Administration (read) on this repo.`,
    ]);
  }
  return findings;
}
```
Only `requiredChecksFrom` is imported here; Task 5 adds `detectStacks` and Task 6 the rest, so Biome never sees an unused import.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tools/repo-audit.test.mjs` → 13 pass. Run: `npx biome check --write tools/repo-audit.mjs tools/repo-audit.test.mjs && npm run lint` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add tools/repo-audit.mjs tools/repo-audit.test.mjs
git commit -m "Add the audit's caller, input and baseline checks"
```

---

### Task 5: Audit checks, part two: suppressions, runtimes, canary

**Files:**
- Modify: `tools/repo-audit.mjs` (append after `checkBaseline`)
- Test: `tools/repo-audit.test.mjs` (append)

**Interfaces:**
- Produces: `EOL = { dotnet: {...}, node: {...} }` (ISO dates), `EOL_WINDOW_DAYS = 90`, `MAX_AGE_DAYS = 8`, `CANARY = "canary.yml"`; `findSuppressions(files: Record<path, text>) → { file, advisory, reason, dated: boolean }[]`; `checkSuppressions(suppressions) → findings`; `targetFrameworks(files) → { file, tfm }[]`; `checkRuntimes({ frameworks, nodeVersion: string, today: "YYYY-MM-DD" }) → findings`; `checkCanary(runs: object | null, now: ISO string) → findings`; `auditRepo({ tree, caller, files, baseline, self }, { stacks, today }) → { findings, suppressions }`. Task 6's `main` calls `auditRepo` and `checkCanary`.

- [ ] **Step 1: Write the failing tests**

Append to `tools/repo-audit.test.mjs`, and extend the import from `./repo-audit.mjs` with `auditRepo, checkCanary, checkRuntimes, checkSuppressions, EOL, findSuppressions, targetFrameworks`; add `import { readFileSync } from "node:fs";` at the top:
```js
const PROPS = `<Project>
  <PropertyGroup>
    <NuGetAudit>true</NuGetAudit>
  </PropertyGroup>
  <ItemGroup>
    <!-- 2026-09-30: transitive via Foo 1.2; fixed upstream in 1.3, bump when released. -->
    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-aaaa-bbbb-cccc" />

    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-dddd-eeee-ffff" /> <!-- 2026-10-01 waiting on Bar -->
    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-gggg-hhhh-iiii" />
    <!--
      Two lines, dated 2026-08-01:
      needed until the .NET 10 bump.
    -->
    <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-jjjj-kkkk-llll" />
  </ItemGroup>
</Project>
`;

test("findSuppressions pairs each suppression with the comment beside or above it", () => {
  const found = findSuppressions({ "Directory.Build.props": PROPS });
  assert.deepEqual(
    found.map((s) => [s.advisory.slice(-19), s.dated]),
    [
      ["GHSA-aaaa-bbbb-cccc", true],
      ["GHSA-dddd-eeee-ffff", true],
      ["GHSA-gggg-hhhh-iiii", false],
      ["GHSA-jjjj-kkkk-llll", true],
    ],
  );
  assert.match(found[0].reason, /^2026-09-30: transitive/);
  assert.equal(found[2].reason, "");
  assert.match(found[3].reason, /Two lines, dated 2026-08-01: needed until/);
  assert.equal(found[0].file, "Directory.Build.props");
});

test("the template's example suppression inside a comment does not count", () => {
  const template = readFileSync("templates/Directory.Build.props", "utf8");
  assert.match(template, /NuGetAuditSuppress/, "the template still shows the example");
  assert.deepEqual(findSuppressions({ "Directory.Build.props": template }), []);
});

test("an undated suppression is a finding; a dated one is only listed", () => {
  const findings = checkSuppressions(findSuppressions({ "api/App.csproj": PROPS }));
  assert.deepEqual(kinds(findings), ["suppression"]);
  assert.match(findings[0][1], /api\/App\.csproj: .*GHSA-gggg-hhhh-iiii has no dated reason \(YYYY-MM-DD\)/);
});

test("the EOL table holds the dates verified on endoflife.date", () => {
  assert.equal(EOL.dotnet["net8.0"], "2026-11-10");
  assert.equal(EOL.dotnet["net9.0"], "2026-11-10");
  assert.equal(EOL.node["20"], "2026-04-30");
  assert.equal(EOL.node["22"], "2027-04-30");
});

test("targetFrameworks reads single and multi-target projects", () => {
  const files = {
    "a/A.csproj": "<TargetFramework>net8.0</TargetFramework>",
    "b/B.csproj": "<TargetFrameworks>net8.0;net10.0-windows</TargetFrameworks>",
  };
  assert.deepEqual(targetFrameworks(files), [
    { file: "a/A.csproj", tfm: "net8.0" },
    { file: "b/B.csproj", tfm: "net8.0" },
    { file: "b/B.csproj", tfm: "net10.0-windows" },
  ]);
});

test("a runtime within 90 days of end of life, or past it, is a finding", () => {
  const frameworks = [
    { file: "a/A.csproj", tfm: "net8.0" },
    { file: "b/B.csproj", tfm: "net10.0-windows" },
    { file: "c/C.csproj", tfm: "netstandard2.0" },
    { file: "d/D.csproj", tfm: "net472" },
  ];
  const near = checkRuntimes({ frameworks, nodeVersion: "", today: "2026-09-30" });
  assert.deepEqual(kinds(near), ["runtime"]);
  assert.match(near[0][1], /a\/A\.csproj: net8\.0 reaches end of life on 2026-11-10/);
  const past = checkRuntimes({ frameworks, nodeVersion: "", today: "2026-12-01" });
  assert.match(past[0][1], /reached end of life/);
  const far = checkRuntimes({ frameworks, nodeVersion: "", today: "2026-06-01" });
  assert.deepEqual(far, []);
});

test("the caller's node-version is checked the same way; an unknown major is a finding", () => {
  const today = "2026-09-30";
  assert.deepEqual(checkRuntimes({ frameworks: [], nodeVersion: "24", today }), []);
  const old = checkRuntimes({ frameworks: [], nodeVersion: "20.x", today });
  assert.match(old[0][1], /Node 20 reached end of life on 2026-04-30/);
  const soon = checkRuntimes({ frameworks: [], nodeVersion: "22", today: "2027-03-01" });
  assert.match(soon[0][1], /Node 22 reaches end of life/);
  const unknown = checkRuntimes({ frameworks: [], nodeVersion: "18", today });
  assert.match(unknown[0][1], /not in the EOL table/);
});

test("a healthy canary run passes", () => {
  const runs = {
    total_count: 3,
    workflow_runs: [{ conclusion: "success", updated_at: "2026-09-28T06:00:00Z", html_url: "u" }],
  };
  assert.deepEqual(checkCanary(runs, "2026-09-30T08:00:00Z"), []);
});

test("a red, stale or never-run canary is a finding; a missing canary is only a warning", () => {
  const red = { workflow_runs: [{ conclusion: "failure", updated_at: "2026-09-29T06:00:00Z", html_url: "u" }] };
  assert.match(checkCanary(red, "2026-09-30T08:00:00Z")[0][1], /ended failure: u/);
  const stale = { workflow_runs: [{ conclusion: "success", updated_at: "2026-09-20T06:00:00Z", html_url: "u" }] };
  assert.match(checkCanary(stale, "2026-09-30T08:00:00Z")[0][1], /10 days old/);
  assert.match(checkCanary({ total_count: 0, workflow_runs: [] }, "2026-09-30T08:00:00Z")[0][1], /never completed/);
  const missing = checkCanary(null, "2026-09-30T08:00:00Z");
  assert.deepEqual(kinds(missing), ["canary-missing"]);
  assert.ok(WARN_KINDS.has("canary-missing"));
  for (const findings of [checkCanary(red, "x"), checkCanary(stale, "2026-09-30T08:00:00Z")]) {
    assert.ok(!WARN_KINDS.has(findings[0][0]));
  }
});

test("auditRepo runs every check over one repo's data", () => {
  const data = {
    self: false,
    tree: ["package.json", "api/App.slnx", "api/App/App.csproj", "api/Directory.Build.props"],
    caller: CALLER.replace('node: "web" # the site', "node: .").replace("dotnet: api/App.slnx", "dotnet: api/App.slnx\n      node-version: '20'"),
    files: { "api/Directory.Build.props": PROPS, "api/App/App.csproj": "<TargetFramework>net8.0</TargetFramework>" },
    baseline,
  };
  const { findings, suppressions } = auditRepo(data, { stacks, today: "2026-09-30" });
  assert.deepEqual(kinds(findings).sort(), ["runtime", "runtime", "suppression"]);
  assert.equal(suppressions.length, 4);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tools/repo-audit.test.mjs` → FAIL, the new names are not exported.

- [ ] **Step 3: Implement**

Add `import { detectStacks } from "./stacks.mjs";` after the `./automerge.mjs` import at the top of `tools/repo-audit.mjs`, then append after `checkBaseline`:
```js
export const CANARY = "canary.yml";
export const MAX_AGE_DAYS = 8;
export const EOL_WINDOW_DAYS = 90;

// Verified on endoflife.date on 2026-09-30. Add a line when a runtime ships.
export const EOL = {
  dotnet: { "net8.0": "2026-11-10", "net9.0": "2026-11-10", "net10.0": "2028-11-14" },
  node: { 20: "2026-04-30", 22: "2027-04-30", 24: "2028-04-30", 26: "2029-04-30" },
};

const DATED = /\b\d{4}-\d{2}-\d{2}\b/;
const COMMENT = /<!--([\s\S]*?)-->/;

// The comment block that ends on the nearest non-blank line above `index`.
// Only a block that is comment from its first line to its last counts: a
// suppression with its own inline comment on the line above is not a reason
// for the next one.
function commentAbove(lines, index) {
  let end = index - 1;
  while (end >= 0 && lines[end].trim() === "") end--;
  if (end < 0 || !lines[end].trim().endsWith("-->")) return "";
  let start = end;
  while (start >= 0 && !lines[start].trim().startsWith("<!--")) {
    if (lines[start].includes("<!--")) return "";
    start--;
  }
  if (start < 0) return "";
  return lines
    .slice(start, end + 1)
    .join(" ")
    .replace(/<!--|-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Every <NuGetAuditSuppress> outside a comment, with the reason beside it: a
// comment on the same line, or the comment block directly above. The template
// shows an example inside a comment, which must not count, so matching runs on
// a copy with comment contents blanked (line structure kept).
export function findSuppressions(files) {
  const found = [];
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split(/\r?\n/);
    const blanked = text
      .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "))
      .split(/\r?\n/);
    blanked.forEach((line, i) => {
      const match = line.match(/<NuGetAuditSuppress\s+Include="([^"]+)"/);
      if (!match) return;
      const inline = lines[i].match(COMMENT);
      const reason = inline ? inline[1].replace(/\s+/g, " ").trim() : commentAbove(lines, i);
      found.push({ file, advisory: match[1], reason, dated: DATED.test(reason) });
    });
  }
  return found;
}

export function checkSuppressions(suppressions) {
  return suppressions
    .filter((s) => !s.dated)
    .map((s) => ["suppression", `${s.file}: ${s.advisory} has no dated reason (YYYY-MM-DD).`]);
}

export function targetFrameworks(files) {
  const found = [];
  for (const [file, text] of Object.entries(files)) {
    for (const match of text.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/g)) {
      for (const tfm of match[1].split(";")) {
        if (tfm.trim()) found.push({ file, tfm: tfm.trim() });
      }
    }
  }
  return found;
}

const DAY = 86_400_000;
const daysUntil = (date, today) => Math.round((Date.parse(date) - Date.parse(today)) / DAY);

function eolFinding(label, eol, today) {
  const days = daysUntil(eol, today);
  if (days > EOL_WINDOW_DAYS) return null;
  return ["runtime", `${label} ${days < 0 ? "reached" : "reaches"} end of life on ${eol}.`];
}

// frameworks from targetFrameworks(); nodeVersion is the caller's node-version
// input ("" when the node module is off). Only netX.Y runtimes are dated;
// netstandard and .NET Framework monikers are skipped. An OS suffix
// (net10.0-windows) is the same runtime.
export function checkRuntimes({ frameworks, nodeVersion, today }) {
  const findings = [];
  const seen = new Set();
  for (const { file, tfm } of frameworks) {
    const runtime = tfm.split("-")[0];
    if (!/^net\d+\.\d+$/.test(runtime) || seen.has(`${file}:${runtime}`)) continue;
    seen.add(`${file}:${runtime}`);
    const eol = EOL.dotnet[runtime];
    if (!eol) {
      findings.push(["runtime", `${file}: ${runtime} is not in the EOL table; add it to tools/repo-audit.mjs.`]);
      continue;
    }
    const finding = eolFinding(`${file}: ${runtime}`, eol, today);
    if (finding) findings.push(finding);
  }
  if (nodeVersion) {
    const major = nodeVersion.match(/^v?(\d+)/)?.[1] ?? "";
    const eol = EOL.node[major];
    if (!eol) {
      findings.push(["runtime", `node-version ${nodeVersion} is not in the EOL table; add it to tools/repo-audit.mjs.`]);
    } else {
      const finding = eolFinding(`Node ${major}`, eol, today);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

// runs: null when Ward has no canary.yml yet (the API answers 404), else the
// workflow-runs response for the latest completed run. The canary arrives in
// Plan 5; until then a missing workflow is a warning, not a failure.
export function checkCanary(runs, now) {
  if (runs === null) return [["canary-missing", `No ${CANARY} in ${WARD} yet (Plan 5).`]];
  const run = runs.workflow_runs?.[0];
  if (!run) return [["canary", `${CANARY} has never completed a run.`]];
  if (run.conclusion !== "success") {
    return [["canary", `The latest canary run ended ${run.conclusion}: ${run.html_url}`]];
  }
  const days = Math.floor((Date.parse(now) - Date.parse(run.updated_at)) / DAY);
  if (days > MAX_AGE_DAYS) {
    return [
      [
        "canary",
        `The latest canary run is ${days} days old (${run.updated_at}); GitHub may have disabled the schedule.`,
      ],
    ];
  }
  return [];
}

// One repo, all checks. tree: blob paths on the default branch; caller: the
// text of .github/workflows/ward.yml or null; files: Directory.Build.props and
// .csproj texts by path; baseline: see checkBaseline; self: the repo is Ward.
export function auditRepo({ tree, caller, files, baseline, self }, { stacks, today }) {
  const findings = [...checkBaseline(baseline), ...checkCaller(caller, { self })];
  const parsed = caller == null ? null : parseCaller(caller);
  const inputs = parsed?.inputs ?? null;
  findings.push(...checkInputs(inputs, detectStacks(tree, stacks), tree));
  const suppressions = findSuppressions(files);
  findings.push(...checkSuppressions(suppressions));
  const nodeVersion = inputs?.node ? inputs["node-version"] || "24" : "";
  findings.push(...checkRuntimes({ frameworks: targetFrameworks(files), nodeVersion, today }));
  return { findings, suppressions };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tools/repo-audit.test.mjs` → 13 + 10 = 23 pass. Run: `npx biome check --write tools/repo-audit.mjs tools/repo-audit.test.mjs && npm run lint` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add tools/repo-audit.mjs tools/repo-audit.test.mjs
git commit -m "Add the audit's suppression, runtime and canary checks"
```

---

### Task 6: Audit API layer, CLI and the live test

**Files:**
- Modify: `tools/repo-audit.mjs` (append), `tools/repo-audit.test.mjs` (append), `docs/repo-audit.md` (create)

**Interfaces:**
- Consumes: `api`, `fetchFile`, `listRepos` from Task 2; everything from Tasks 4 and 5.
- Produces: `tokenFor(owner: string, env: object): string` (the admin token for an owner); `expectsAdminRead(owner, env): boolean`; `warnKindsFor(owner, env, extra: string[]): Set<string>`; `hardCount(findings, warnKinds): number`; `request(path, token) → Promise<{ status: number, body: object | null }>`; `fetchRepoData(meta: object, { admin, read }) → Promise<{ tree, caller, files, baseline, self }>`. CLI: `node tools/repo-audit.mjs --owner a,b [--include-archived] [--mode warn|strict] [--warn-kinds k1,k2]`; env `GITHUB_TOKEN` (the public reads, required), `WARD_AUDIT_TOKEN` (the settings reads), optional `AUDIT_TOKEN_<OWNER>`; exit 1 in strict mode when any non-warning finding exists on a non-archived repo or the canary, and a `token` finding counts as non-warning where admin read is promised. One repo's API error is that repo's `error` finding; the sweep goes on. Task 7's workflow runs it.

- [ ] **Step 1: Write the failing tests**

Append to `tools/repo-audit.test.mjs`, extending the import with `expectsAdminRead, fetchRepoData, hardCount, request, tokenFor, WARD, warnKindsFor`:
```js
test("tokenFor prefers an owner-specific token, then the audit token, then the Actions token", () => {
  const env = {
    GITHUB_TOKEN: "actions",
    WARD_AUDIT_TOKEN: "audit",
    AUDIT_TOKEN_ROOKDEX: "org",
  };
  assert.equal(tokenFor("rookdex", env), "org");
  assert.equal(tokenFor("wendhq", env), "audit");
  assert.equal(tokenFor("malinfossum", { GITHUB_TOKEN: "actions" }), "actions");
  assert.equal(tokenFor("funn-team", { AUDIT_TOKEN_FUNN_TEAM: "t" }), "t");
  assert.equal(tokenFor("x", {}), "");
});

// The one test that touches the network. Skipped without a token, so `npm test`
// in CI and on a fresh clone stays offline; run it locally with
// GITHUB_TOKEN=$(gh auth token) npm test.
test("a token finding fails the run where admin read is promised", () => {
  assert.equal(expectsAdminRead("malinfossum", {}), true);
  assert.equal(expectsAdminRead("rookdex", {}), false);
  assert.equal(expectsAdminRead("rookdex", { AUDIT_TOKEN_ROOKDEX: "t" }), true);
});

test("a kind named in --warn-kinds is a warning; the same kind without the flag is a failure", () => {
  const findings = [
    ["caller", "x"],
    ["baseline", "y"],
    ["uncovered", "z"],
  ];
  assert.equal(hardCount(findings, warnKindsFor("malinfossum", {})), 2);
  assert.equal(hardCount(findings, warnKindsFor("malinfossum", {}, ["caller"])), 1);
  assert.ok(!warnKindsFor("malinfossum", {}).has("token"));
  assert.ok(warnKindsFor("rookdex", {}).has("token"));
});

const liveToken = process.env.GITHUB_TOKEN || "";
test("live: Ward itself passes the baseline, caller and input checks", {
  skip: !liveToken && "no GITHUB_TOKEN in the environment",
}, async () => {
  const meta = (await request(`/repos/${WARD}`, liveToken)).body;
  assert.equal(meta.full_name, WARD);
  const data = await fetchRepoData(meta, { admin: liveToken, read: liveToken });
  assert.equal(data.self, true);
  assert.ok(data.tree.includes("package.json"));
  assert.match(data.caller, /uses: \.\/\.github\/workflows\/ci\.yml/);
  const { findings } = auditRepo(data, { stacks, today: new Date().toISOString().slice(0, 10) });
  const hard = findings.filter(([kind]) =>
    ["baseline", "ruleset", "caller", "inputs"].includes(kind),
  );
  assert.deepEqual(hard, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tools/repo-audit.test.mjs` → FAIL, `tokenFor` is not exported (the live test is skipped or fails on the missing export).

- [ ] **Step 3: Implement the API layer and CLI**

Replace the import block at the top of `tools/repo-audit.mjs` with:
```js
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { requiredChecksFrom } from "./automerge.mjs";
import { fetchFile, listRepos } from "./repo-hygiene.mjs";
import { detectStacks, loadStacks } from "./stacks.mjs";
```
Then append to the end of the file:
```js
const API = "https://api.github.com";

const auditKey = (owner) => `AUDIT_TOKEN_${owner.toUpperCase().replaceAll("-", "_")}`;

// The admin token for an owner. A fine-grained token is scoped to one resource
// owner, so an org can carry its own in AUDIT_TOKEN_<OWNER>. Without one,
// WARD_AUDIT_TOKEN is tried and the settings reads report a token warning for
// that org's repos. Everything else the audit reads is public and goes through
// the Actions token, so the admin token needs Administration (read) and
// nothing else: if it leaks, it can read settings, never code.
export function tokenFor(owner, env) {
  return env[auditKey(owner)] || env.WARD_AUDIT_TOKEN || env.GITHUB_TOKEN || "";
}

// Where admin read is promised (my own repos, and an org with its own token),
// a token finding is a failure: a missing or expired token must not turn the
// settings checks into a silent pass. Another org without a token keeps the
// warning.
export function expectsAdminRead(owner, env) {
  return owner.toLowerCase() === WARD.split("/")[0] || Boolean(env[auditKey(owner)]);
}

// The warning set for one owner: WARN_KINDS, minus token where admin read is
// promised, plus the kinds --warn-kinds names for this run (caller until Plan
// 5 rolls the caller out, so a red run means new drift, not the rollout).
export function warnKindsFor(owner, env, extra = []) {
  const kinds = new Set([...WARN_KINDS, ...extra]);
  if (expectsAdminRead(owner, env)) kinds.delete("token");
  return kinds;
}

// Status plus parsed body. 401, 403 and 404 come back as a status with a null
// body, because for the settings endpoints they mean "cannot read" or "off",
// which the checks decide. Anything else 4xx or 5xx is a real failure.
export async function request(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ward-repo-audit",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const silent = res.status === 204 || [401, 403, 404].includes(res.status);
  if (res.status >= 400 && !silent) throw new Error(`GitHub API ${res.status} on ${path}`);
  return { status: res.status, body: silent ? null : await res.json() };
}

const PROPS_OR_PROJECT = /(^|\/)(Directory\.Build\.props|[^/]+\.csproj)$/;
const BUILD_OUTPUT = /(^|\/)(bin|obj|node_modules)\//;

// admin: the token for the four settings endpoints; read: the token for the
// public reads (tree, caller, project files, branch rules).
export async function fetchRepoData(meta, { admin, read }) {
  const repo = meta.full_name;
  const branch = encodeURIComponent(meta.default_branch);
  const tree = await request(`/repos/${repo}/git/trees/${branch}?recursive=1`, read);
  // A tree on a public repo answers without a token, so anything but 200 is a
  // real failure (a rate limit, or a repo with no commits yet), never "no files".
  if (tree.status !== 200) throw new Error(`GitHub API ${tree.status} on the tree of ${repo}`);
  if (tree.body.truncated) {
    console.log(`::warning::${repo}: the tree is truncated, stack detection may miss files`);
  }
  const paths = tree.body.tree.filter((e) => e.type === "blob").map((e) => e.path);
  const caller = await fetchFile(repo, ".github/workflows/ward.yml", read);
  const files = {};
  for (const path of paths.filter((p) => PROPS_OR_PROJECT.test(p) && !BUILD_OUTPUT.test(p))) {
    const text = await fetchFile(repo, path, read);
    if (text) files[path] = text;
  }
  const [updates, alerts, codeScanning, rules] = await Promise.all([
    request(`/repos/${repo}/automated-security-fixes`, admin),
    request(`/repos/${repo}/vulnerability-alerts`, admin),
    request(`/repos/${repo}/code-scanning/default-setup`, admin),
    request(`/repos/${repo}/rules/branches/${branch}`, read),
  ]);
  const readable = (res) => (res.status === 200 ? res.body : null);
  return {
    self: repo === WARD,
    tree: paths,
    caller,
    files,
    baseline: {
      securityUpdates: readable(updates),
      alerts: alerts.status === 204 ? true : alerts.status === 404 ? false : null,
      analysis: meta.security_and_analysis ?? null,
      codeScanning: readable(codeScanning),
      rules: readable(rules),
    },
  };
}

// level: "error" fails the job (strict), "warning" never does, "" prints
// plainly (archived repos). warnKinds stay warnings in every mode.
function report(name, findings, level, warnKinds = WARN_KINDS) {
  if (!findings.length) {
    console.log(`OK    ${name}`);
    return "";
  }
  console.log(`AUDIT ${name}: ${findings.length} finding(s)`);
  const lines = [`### ${name}`, ""];
  for (const [kind, message] of findings) {
    const shown = level && warnKinds.has(kind) ? "warning" : level;
    console.log(shown ? `::${shown}::${name} [${kind}] ${message}` : `  [${kind}] ${message}`);
    lines.push(`- **${kind}**: ${message}`);
  }
  lines.push("");
  return lines.join("\n");
}

export const hardCount = (findings, warnKinds = WARN_KINDS) =>
  findings.filter(([kind]) => !warnKinds.has(kind)).length;

async function main(argv) {
  const arg = (flag, fallback = "") => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  const owners = arg("--owner", "malinfossum")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const includeArchived = argv.includes("--include-archived");
  const strict = arg("--mode", "warn") === "strict";
  const level = strict ? "error" : "warning";
  // Kinds demoted to warnings for this run: `--warn-kinds caller` until Plan 5.
  const extraWarn = arg("--warn-kinds", "")
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  const env = process.env;
  // Public reads: the Actions token in CI, `gh auth token` locally.
  const read = env.GITHUB_TOKEN || "";
  const stacks = loadStacks();
  const today = new Date().toISOString().slice(0, 10);

  let summary = "";
  let archivedSummary = "";
  let failures = 0;
  const suppressions = [];
  for (const owner of owners) {
    const admin = tokenFor(owner, env);
    const warnKinds = warnKindsFor(owner, env, extraWarn);
    for (const listed of await listRepos([owner], read)) {
      // Private repos keep Actions off and sit outside the standard (spec, Out
      // of scope). The public listing never returns one; kept so that a token
      // or endpoint change can never widen the sweep.
      if (listed.private) continue;
      if (listed.archived && !includeArchived) continue;
      // One repo's API error is that repo's finding, so the others still
      // report and the summary survives; the run still fails on it.
      try {
        // The list omits security_and_analysis; the single-repo call has it.
        const meta = (await request(`/repos/${listed.full_name}`, admin)).body ?? listed;
        const data = await fetchRepoData(meta, { admin, read });
        const result = auditRepo(data, { stacks, today });
        suppressions.push(...result.suppressions.map((s) => ({ repo: meta.full_name, ...s })));
        // Archived repos are read-only on GitHub: reported, never failing.
        if (meta.archived) {
          archivedSummary += report(`${meta.full_name} (archived)`, result.findings, "");
        } else {
          summary += report(meta.full_name, result.findings, level, warnKinds);
          failures += hardCount(result.findings, warnKinds);
        }
      } catch (error) {
        summary += report(listed.full_name, [["error", error.message]], level, warnKinds);
        failures += 1;
      }
    }
  }

  const canary = await request(
    `/repos/${WARD}/actions/workflows/${CANARY}/runs?per_page=1&status=completed`,
    read,
  );
  const canaryFindings = checkCanary(
    canary.status === 404 ? null : canary.body,
    new Date().toISOString(),
  );
  summary += report(`${WARD} canary`, canaryFindings, level);
  failures += hardCount(canaryFindings);

  if (suppressions.length) {
    summary +=
      "### NuGet audit suppressions\n\n| Repo | File | Advisory | Reason |\n|---|---|---|---|\n";
    for (const s of suppressions) {
      summary += `| ${s.repo} | ${s.file} | ${s.advisory} | ${s.reason || "(none)"} |\n`;
    }
    summary += "\n";
  }
  if (archivedSummary) {
    summary += `\n<details><summary>Archived repos (read-only, unarchive to fix)</summary>\n\n${archivedSummary}</details>\n`;
  }
  if (env.GITHUB_STEP_SUMMARY && summary) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## Repo audit\n\n${summary}`);
  }
  console.log(failures ? `${failures} finding(s).` : "No findings.");
  process.exitCode = failures && strict ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run to verify it passes, offline and live**

Run: `node --test tools/repo-audit.test.mjs` → 26 pass, 1 skipped (the live test). Run: `npm run lint` → exit 0.
Run (Git Bash): `GITHUB_TOKEN=$(gh auth token) node --test tools/repo-audit.test.mjs` → 27 pass, 0 skipped.
Run (Git Bash, the whole sweep in warn mode): `GITHUB_TOKEN=$(gh auth token) node tools/repo-audit.mjs --owner malinfossum,rookdex,wendhq --include-archived`
Expected: one `OK`/`AUDIT` line per repo (46 non-fork under malinfossum, one each under rookdex and wendhq, `.github` skipped), `::warning::` annotations for the findings, a `canary-missing` warning for `malinfossum/ward canary`, `N finding(s).`, exit 0. Every repo but Ward reports `caller` today: that is the expected state before Plan 5, and the workflow passes `--warn-kinds caller` so it stays a warning in strict mode until then. Run the sweep once more with `--mode strict --warn-kinds caller` and once with `--mode strict`: the `N finding(s).` total drops by exactly the number of `::error::` `caller` lines the second run prints. A repo whose API call fails (`GitHub API 5xx`, or a repo with no commits yet) shows as one `error` finding and the sweep goes on; rerun once, and if it repeats, note the repo and message in the task report.

- [ ] **Step 5: Write `docs/repo-audit.md`**

````markdown
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
````

- [ ] **Step 6: Commit**

```bash
git add tools/repo-audit.mjs tools/repo-audit.test.mjs docs/repo-audit.md
git commit -m "Add the audit's API layer, CLI and docs"
```

---

### Task 7: The weekly audit workflow

**Files:**
- Create: `.github/workflows/repo-audit.yml`
- Modify: `tools/workflows.test.mjs` (append one test)

**Interfaces:**
- Consumes: the CLIs from Tasks 2 and 6; `workflows` and `readWorkflow` from Task 3's additions to `tools/workflows.test.mjs`.
- Produces: workflow `Repo audit` (file `repo-audit.yml`), job `audit`, on `schedule` (Mondays 06:17 UTC) and `workflow_dispatch`. The `/morning` watchdog (Task 12) reads its runs by file name.

- [ ] **Step 1: Write the failing test**

A workflow that reads a secret must never run on `pull_request`, or a PR could exfiltrate it. Append to `tools/workflows.test.mjs`:
```js
test("a workflow that reads a secret runs only on a schedule or by hand", () => {
  let checked = 0;
  for (const file of workflows) {
    if (!/secrets\./.test(readWorkflow(file))) continue;
    checked++;
    const on = readWorkflow(file).match(/^on:\r?\n((?: {2}.*\r?\n?)+)/m)?.[1] ?? "";
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(triggers, ["schedule", "workflow_dispatch"], file);
  }
  assert.equal(checked, 1, "repo-audit.yml is the one workflow that reads a secret");
});
```
Run: `node --test tools/workflows.test.mjs` → the new test fails (`checked` is 0).

- [ ] **Step 2: Write the workflow**

```yaml
# Weekly sweep over every repo I own, archived ones included: README drift,
# baseline settings, caller on @v1, caller inputs against the repo's stacks,
# NuGet audit suppressions, runtimes near end of life, and Ward's canary.
# Strict: a finding on a non-archived repo fails the run, and a failed
# scheduled run emails me. Never on pull_request: this workflow reads a secret.
name: Repo audit

on:
  schedule:
    - cron: "17 6 * * 1"
  workflow_dispatch:

permissions:
  contents: read

env:
  DOTNET_CLI_TELEMETRY_OPTOUT: "1"
  ASTRO_TELEMETRY_DISABLED: "1"
  WRANGLER_SEND_METRICS: "false"

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
      - name: README drift in every repo
        # Public repos only: the Actions token is enough, and the admin token
        # never reaches a step that does not need it.
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: node tools/repo-hygiene.mjs --all --owner malinfossum,rookdex,wendhq --include-archived --mode strict
      - name: Baseline, caller, inputs, suppressions, runtimes, canary
        # Runs even when the README step failed, so one run shows everything.
        if: ${{ !cancelled() }}
        env:
          GITHUB_TOKEN: ${{ github.token }}
          WARD_AUDIT_TOKEN: ${{ secrets.WARD_AUDIT_TOKEN }}
          AUDIT_TOKEN_ROOKDEX: ${{ secrets.AUDIT_TOKEN_ROOKDEX }}
          AUDIT_TOKEN_WENDHQ: ${{ secrets.AUDIT_TOKEN_WENDHQ }}
        # --warn-kinds caller: a missing caller is a warning until Plan 5 rolls
        # the caller out (decided 2026-09-30), so a red run means new drift.
        # Plan 5 removes the flag.
        run: node tools/repo-audit.mjs --owner malinfossum,rookdex,wendhq --include-archived --mode strict --warn-kinds caller
```

- [ ] **Step 3: Run the tests**

Run: `npm test` → every test passes, including the new one (now `checked` is 1). Total: 68 + 6 (stacks) + 21 (hygiene) + 5 (workflows) + 27 (audit, one skipped offline) = previous count + 59. Run: `npm run test:fixtures` → 10 pass. Run: `npm run lint` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/repo-audit.yml tools/workflows.test.mjs
git commit -m "Add the weekly repo audit workflow"
```

---

### Task 8: Ward's own caller, README, version, licence, spec, and the PR

**Files:**
- Create: `LICENSE`
- Modify: `.github/workflows/ward.yml`, `README.md`, `package.json`, `docs/specs/2026-09-25-ci-standard-design.md`

- [ ] **Step 1: Add the hygiene job to `.github/workflows/ward.yml`**

Append after the `fixtures` job:
```yaml

  hygiene:
    uses: ./.github/workflows/repo-hygiene.yml
    with:
      mode: ${{ (github.event_name == 'pull_request' || github.event_name == 'push') && 'warn' || 'strict' }}
```
Ward dogfoods the hygiene workflow by local path, as it does `ci.yml`: the workflow holds no write access, so a PR head running it is harmless. Check name: `hygiene / hygiene`; it is not required by the ruleset (warn by default, per the spec's baseline).

- [ ] **Step 2: Bump the version**

In `package.json`, `"version": "1.0.0"` becomes `"version": "1.1.0"`. The hygiene `version` check compares the manifest with the latest release: a manifest ahead of the release is fine, a manifest behind it is a finding, so the bump lands before the tag.

- [ ] **Step 3: Update `README.md`**

In the "Use it" section, after the module table, add:
```markdown
Two more checks live outside `ci.yml`. [`repo-hygiene.yml`](.github/workflows/repo-hygiene.yml) is a
reusable workflow that checks a repo's public face against its README ([docs](docs/repo-hygiene.md)).
[`repo-audit.yml`](.github/workflows/repo-audit.yml) sweeps every repo I own each Monday: baseline
settings, caller on `@v1`, caller inputs against the repo's stacks, dated NuGet audit suppressions,
runtimes near end of life, and the canary ([docs](docs/repo-audit.md)).
```
In the "Layout" table, replace the `.github/workflows/` row and add a `stacks.json` row and a `docs/` row:
```markdown
| `.github/workflows/` | `ci.yml` (entry point), `dependabot-automerge.yml`, `repo-hygiene.yml`, the weekly `repo-audit.yml`, Ward's own `ward.yml` |
| `stacks.json` | Which files mean which module, read by the audit and by the `ward` skill |
| `docs/` | The spec, the plans, `repo-hygiene.md` and `repo-audit.md` |
```

- [ ] **Step 4: Add the MIT licence, in its own commit**

Ward is public and other owners' repos run it, and without a licence file it is all rights reserved. MIT, the same text as workbench's `LICENSE`, so the code that moves in keeps the licence it left with. Write `LICENSE` at the repo root with exactly this content:
```text
MIT License

Copyright (c) 2026 Malin Fossum

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
Then:
```bash
diff LICENSE ../workbench/LICENSE && echo same
git add LICENSE
git commit -m "Add the MIT licence"
```
Expected: `same` (workbench sits next to Ward in the same parent folder; if not, compare against `https://github.com/malinfossum/workbench/blob/main/LICENSE`). `npm run lint` is unaffected: Biome ignores a file with no extension.

- [ ] **Step 5: Record the Plan 2 deviations in the spec**

In `docs/specs/2026-09-25-ci-standard-design.md`, append this paragraph to the Architecture section, right after the "Deviations recorded 2026-09-25 (Plan 1)" paragraph:
```markdown
**Deviations recorded 2026-09-30 (Plan 2):** `stacks.json` arrived with the audit, one plan early,
because the caller-input comparison needs the detection rules; python, powershell and docker are
listed there as `planned` and reported as `uncovered` warnings until Plan 6. The hygiene check
stays a reusable workflow of its own with its own caller file, so `templates/ward.yml` is unchanged;
folding it into the caller is a Plan 5 rollout question. The audit token is a fine-grained token
with Administration (read) only; every other read is public and goes through the Actions token, so
the secret on Ward can read settings, never code. A fine-grained token covers one owner: org repos
get their settings read only through `AUDIT_TOKEN_ROOKDEX` and `AUDIT_TOKEN_WENDHQ`, and without
those the audit reports a `token` warning for them, while a `token` finding on my own repos fails
the run. Until Plan 5 rolls the caller out, `repo-audit.yml` passes `--warn-kinds caller`, so a
missing caller is a warning and a red audit means a baseline, ruleset or other drift, not the
rollout itself; Plan 5 removes the flag. Ward is MIT-licensed, the same text as workbench, so the
code that moved in keeps the licence it left with.
```
In "Migration from workbench", replace the sentence that starts `The weekly audit needs the` (it ends `I set that by hand.`) with:
```markdown
The weekly audit needs the `WARD_AUDIT_TOKEN` secret set on Ward, which I set by hand: a new
fine-grained token with Administration (read) on all my repositories and nothing else. It is not
named `PROFILE_README_TOKEN` as first planned: that name holds a write token on profile-dashboard,
and sharing it invited setting the wrong one.
```
In "Security of Ward itself", the Account bullet's first sentence `2FA stays on; Ward holds no secrets except the audit token, which is read-only.` becomes:
```markdown
2FA stays on; Ward holds no secrets except `WARD_AUDIT_TOKEN`, which is read-only (Administration
read, nothing else).
```

- [ ] **Step 6: Verify, commit, push, open the PR**

Run: `npm test && npm run test:fixtures && npm run lint` → all exit 0.
```bash
git add .github/workflows/ward.yml README.md package.json docs/specs/2026-09-25-ci-standard-design.md
git commit -m "Run the hygiene check on Ward itself, bump to 1.1.0 and record the Plan 2 deviations"
git push -u origin feat/hygiene-audit
gh pr create --base main --head feat/hygiene-audit --title "Move repo hygiene and the weekly audit in from workbench" --body-file - <<'EOF'
Plan 2 of the CI standard: the README drift checker and the weekly audit move here from workbench.

- `tools/repo-hygiene.mjs` as it was, on Node 24 with Ward's annotations and exit codes
- `tools/repo-audit.mjs`: baseline settings, caller on `@v1`, caller inputs against `stacks.json`, dated NuGet audit suppressions, runtimes near end of life, and the canary watchdog; every check is a pure function with canned-input tests
- `repo-hygiene.yml` as a reusable workflow that fetches Ward's tools at its own commit, and `repo-audit.yml` as the Monday sweep in strict mode
- `workflows.test.mjs` now guards permissions, timeouts, telemetry, secret-holding triggers and the `job.workflow_sha` fetch for every workflow
- Ward runs the hygiene check on itself; version 1.1.0
- `LICENSE`: MIT, the same text as workbench and my other public repos

A missing caller is a warning until Plan 5 rolls the caller out (`--warn-kinds caller`), so a red audit means new drift. The `WARD_AUDIT_TOKEN` secret on Ward is set by hand before the first scheduled run.
EOF
```
Expected: `ward / gate`, `ward-windows / gate`, `fixtures` and `hygiene / hygiene` green on the PR (read CI through the app's PR monitor or `gh run view --log-failed` once a run finishes; do not poll). Report the PR URL. Merging is Malin's call.

---

### Task 9: Malin's manual steps: the secret, the merge, the release

Written as her steps with exact commands. The agent runs nothing here; it hands her this task and waits.

- [ ] **Step 1: Create the audit token and store it on Ward**

At GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token:
- Name `ward-audit`, resource owner `malinfossum`, expiry 1 year, repository access "All repositories".
- Repository permissions: **Administration: Read-only** (Metadata read is added automatically). Nothing else, not Contents: the audit reads code through the Actions token, so this token can never read a private repo's files.

Verify the token before storing it (Git Bash; paste the token when prompted, it is never written to a file):
```bash
read -rs -p "token: " T; echo
for p in automated-security-fixes vulnerability-alerts code-scanning/default-setup; do
  printf '%-32s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/malinfossum/ward/$p"
done
curl -s -H "Authorization: Bearer $T" -H "Accept: application/vnd.github+json" https://api.github.com/repos/malinfossum/ward | grep -c secret_scanning_push_protection
printf '%s' "$T" | gh secret set WARD_AUDIT_TOKEN --repo malinfossum/ward
unset T
```
Expected: `200`, `204`, `200`, then `1`. Any `403` means a permission is missing: the response's `X-Accepted-GitHub-Permissions` header names it (`curl -si ... | grep -i accepted`); add it to the token and rerun. Then write the token's expiry date into the Follow-ups list at the end of this plan.

Optional, for the org repos: repeat with resource owner `rookdex`, secret `AUDIT_TOKEN_ROOKDEX`, and owner `wendhq`, secret `AUDIT_TOKEN_WENDHQ`. Without them the audit reports one `token` warning per org repo and everything else runs.

- [ ] **Step 2: Merge the PR**

Merge the Task 8 PR on GitHub (squash or merge, your choice). If the `code_scanning` rule blocks a green PR, merge `main` into the branch, push, and wait for CodeQL on the new merge commit (the Plan 1 tidy-up trap).

- [ ] **Step 3: Run the audit once by hand**

```bash
gh workflow run repo-audit.yml --repo malinfossum/ward
```
Read the run summary on GitHub once it finishes. Expected: `## Repo hygiene` and `## Repo audit` sections, every repo listed, `caller` on every repo but Ward as a warning (`--warn-kinds caller`), a `canary-missing` warning, and the run red on the `baseline` and `ruleset` findings of the repos that do not carry the baseline yet (Plan 3's `apply.mjs` puts it there; the 2026-09-30 strict sweep counted 19 `baseline`, 30 `ruleset` and 1 `suppression` on non-archived repos, and 17 `caller` warnings). That is Plan 2's exit criterion: the audit runs from Ward and reports every repo.

- [ ] **Step 4: Tag `v1.1.0` and move `v1`**

The pin is the **commit** SHA, never the tag object's SHA. The `v*` tag ruleset (24164641) blocks tag creation and updates for everyone but a repository admin, which is you.
```bash
git switch main && git pull --ff-only
git tag -a v1.1.0 -m "Ward 1.1.0: repo hygiene and the weekly audit"
git tag -fa v1 -m "Ward v1: currently v1.1.0" v1.1.0^{commit}
git push origin v1.1.0
git push --force origin v1
git rev-parse v1.1.0^{commit}
gh release create v1.1.0 --verify-tag --title "v1.1.0" --latest --notes "Repo hygiene and the weekly audit move in from workbench. Callers on @v1 get repo-hygiene.yml; repo-audit.yml sweeps every repo each Monday. No change to ci.yml's inputs or checks."
gh api repos/malinfossum/ward/git/ref/tags/v1 --jq '.object.sha' | xargs -I{} gh api repos/malinfossum/ward/git/tags/{} --jq '.object.sha'
```
Expected: the last two commands print the same 40-character commit SHA, which is `main`'s tip. `templates/ward.yml` keeps its `v1.0.0` auto-merge pin: `dependabot-automerge.yml` did not change in this release, and Dependabot proposes the bump on each repo when it does.

- [ ] **Step 5: Tell the agent to continue**

Tasks 10 and 11 need the release to exist, so they start only after this step.

---

### Task 10: Workbench: forwarder, removals, scaffolds (PR; Malin merges)

Runs in the workbench checkout next to Ward, outside Ward; gated by the go-ahead that comes with Task 9's completion.

**Files (workbench):**
- Modify: `.github/workflows/repo-hygiene.yml` (becomes a forwarder), `README.md` (one row), `scaffolds/{csharp-api,csharp-console,csharp-layered,csharp-wpf,web-react-ts,web-vite}/.github/workflows/repo-hygiene.yml` (lines 3 and 18)
- Delete: `.github/workflows/repo-audit.yml`, `tools/repo-hygiene.mjs`, `tools/repo-hygiene.test.mjs`, `docs/repo-hygiene.md`

- [ ] **Step 1: Branch from a fresh `main`**

```bash
cd ../workbench
git switch main && git pull --ff-only && git switch -c chore/hygiene-to-ward
node --test "tools/*.test.mjs" && node tools/check-links.mjs
```
Expected: the current suite green before any change (note the count).

- [ ] **Step 2: Rewrite `.github/workflows/repo-hygiene.yml` as the forwarder**

```yaml
# Forwarder, kept for one release: the checker moved to malinfossum/ward in
# Ward 1.1.0. Callers still on this file keep working; point them at
# malinfossum/ward/.github/workflows/repo-hygiene.yml@v1 directly (docs in
# Ward's docs/repo-hygiene.md). Remove this file after the next workbench
# release.
name: Repo hygiene

on:
  workflow_call:
    inputs:
      mode:
        description: warn (report only) or strict (fail the job on drift)
        type: string
        default: warn

permissions:
  contents: read

jobs:
  hygiene:
    uses: malinfossum/ward/.github/workflows/repo-hygiene.yml@v1
    with:
      mode: ${{ inputs.mode }}
```

- [ ] **Step 3: Remove the moved files and update the README row**

```bash
git rm -q .github/workflows/repo-audit.yml tools/repo-hygiene.mjs tools/repo-hygiene.test.mjs docs/repo-hygiene.md
```
In `README.md`, the `tools/` row of the Structure table becomes:
```markdown
| [`tools/`](./tools) | `extract.mjs` plus the test suite CI runs (extract, structure, scaffold drift, links). The repo-hygiene checker moved to [Ward](https://github.com/malinfossum/ward/blob/main/docs/repo-hygiene.md) |
```

- [ ] **Step 4: Switch the six scaffolds**

```bash
for s in csharp-api csharp-console csharp-layered csharp-wpf web-react-ts web-vite; do
  f="scaffolds/$s/.github/workflows/repo-hygiene.yml"
  sed -i -e 's#^\# The checker lives in malinfossum/workbench .*$#\# The checker lives in malinfossum/ward: docs/repo-hygiene.md.#' \
         -e 's#uses: malinfossum/workbench/.github/workflows/repo-hygiene.yml@main#uses: malinfossum/ward/.github/workflows/repo-hygiene.yml@v1#' "$f"
done
grep -rn "workbench/.github/workflows/repo-hygiene" scaffolds .github README.md docs guide index.html; echo "exit=$?"
```
Expected: the grep prints nothing and `exit=1`. Each scaffold file's line 3 now reads `# The checker lives in malinfossum/ward: docs/repo-hygiene.md.` and line 18 `    uses: malinfossum/ward/.github/workflows/repo-hygiene.yml@v1`.

- [ ] **Step 5: Test and open the PR**

```bash
node --test "tools/*.test.mjs" && node tools/check-links.mjs
git add .github/workflows/repo-hygiene.yml README.md scaffolds
git -c user.name="Malin Fossum" -c user.email=malinfossum.dev@proton.me commit -m "Hand the repo-hygiene check over to Ward and keep a forwarder for one release"
git push -u origin chore/hygiene-to-ward
gh pr create --base main --head chore/hygiene-to-ward --title "Hand the repo-hygiene check over to Ward" --body-file - <<'EOF'
The README drift checker and the weekly audit now live in malinfossum/ward (1.1.0).

- `repo-hygiene.yml` is a forwarder to `malinfossum/ward/.github/workflows/repo-hygiene.yml@v1`, kept for one release so callers still on this file keep working
- `repo-audit.yml`, `tools/repo-hygiene.mjs`, its tests and `docs/repo-hygiene.md` are removed; the README row points at Ward's docs
- the six scaffolds call Ward directly

Follow-up, after the next workbench release: remove the forwarder.
EOF
```
Expected: the test count is the previous count minus 20 (the hygiene tests left), links green, workbench CI green on the PR (`git rm` staged the deletions, so the explicit `git add` above stages everything the task changed and nothing that happens to sit in the checkout). Report the PR URL; Malin merges. The workbench release that follows is hers, and the forwarder's removal is a dated follow-up after it.

- [ ] **Step 6: Prove the forwarder path once Malin has merged**

Consumers sit on `workbench@main` until their Task 11 PR merges, so the nested call (consumer → workbench forwarder → Ward, with Ward's `job.workflow_sha` fetch inside) must work in that window. Nothing else exercises it. Before any Task 11 PR merges:
```bash
gh workflow run repo-hygiene.yml --repo malinfossum/varde
gh run list --repo malinfossum/varde --workflow repo-hygiene.yml --limit 1 --json databaseId,status,conclusion,url
```
Check again later for `status` `completed`; do not poll in a loop. Expected: the run's `hygiene` job checks out `malinfossum/ward` at the `v1` commit and runs `repo-hygiene.mjs` (`gh run view <id> --log`). Findings on varde's README make the run red in strict mode; that is a README matter, not the forwarder. A job that never reaches the checker (a `workflow_sha` or nesting error) means the forwarder does not work: report it, and Malin merges the Task 11 PRs before anything relies on it.

---

### Task 11: The five consumer repos (one PR each; Malin merges)

Outside Ward; gated like Task 10. Each repo gets the same two-line change in `.github/workflows/repo-hygiene.yml`: the comment on line 3 and the `uses:` on line 18. Spindle's `commit-identity.yml` stays as it is (Plan 5 retires it).

- [ ] **Step 1: Open the PRs**

Run in Git Bash from any folder; clones go to a temp directory, never into `repos/`:
```bash
tmp="$(mktemp -d)"
for r in hugin malinfossum profile-dashboard spindle varde; do
  if ! git clone --quiet --depth 1 "https://github.com/malinfossum/$r" "$tmp/$r"; then
    echo "SKIP $r: clone failed"
    continue
  fi
  f="$tmp/$r/.github/workflows/repo-hygiene.yml"
  git -C "$tmp/$r" switch -c chore/hygiene-via-ward
  sed -i -e 's#^\# The checker lives in malinfossum/workbench .*$#\# The checker lives in malinfossum/ward: docs/repo-hygiene.md.#' \
         -e 's#uses: malinfossum/workbench/.github/workflows/repo-hygiene.yml@main#uses: malinfossum/ward/.github/workflows/repo-hygiene.yml@v1#' "$f"
  if git -C "$tmp/$r" diff --quiet; then
    echo "SKIP $r: nothing changed; line 18 is: $(sed -n 18p "$f")"
    continue
  fi
  git -C "$tmp/$r" diff --stat
  git -C "$tmp/$r" -c user.name="Malin Fossum" -c user.email=malinfossum.dev@proton.me commit -qam "Call the repo-hygiene check from Ward"
  git -C "$tmp/$r" push -q -u origin chore/hygiene-via-ward
  gh pr create --repo "malinfossum/$r" --base main --head chore/hygiene-via-ward --title "Call the repo-hygiene check from Ward" --body "The checker moved from workbench to malinfossum/ward (1.1.0). Same triggers, same modes; only the \`uses:\` line changes."
done
rm -rf "$tmp"
```
Expected: each repo prints `1 file changed, 2 insertions(+), 2 deletions(-)` and a PR URL. A `SKIP` line names a repo whose clone failed or whose file differs from the scaffold copy (its line 18 is printed), and the loop goes on to the next repo; report every `SKIP` instead of guessing. The push goes over HTTPS through `gh`'s credential helper; if it prompts for a password, stop and run `gh auth setup-git` first. A rerun after a failed push finds the branch from the first attempt on the remote: delete it first (`gh api -X DELETE repos/malinfossum/<repo>/git/refs/heads/chore/hygiene-via-ward`).

- [ ] **Step 2: Report**

List the five PR URLs. Malin merges them; on each merge, the `hygiene / hygiene` check on the next README change or release proves the switch.

---

### Task 12: The `/morning` outside watchdog (gated on Malin's plan approval)

**Files:**
- Modify: `~/.claude/skills/morning/SKILL.md` (a plain directory under `.claude`, tracked by the git repo at `~/.claude`, my private harness repo; the edit is committed there, not in loadout and not in Ward)

This edits a skill inside `.claude/`, which the standing rule forbids without explicit instruction. Malin's approval of this plan is that instruction for this one file; the agent still shows the diff before committing.

- [ ] **Step 1: Add the Monday gather step**

In step 2's gather list, directly after the "**Mondays only** (or when the "Baseline fingerprint" ...)" bullet, insert:
```markdown
   - **Mondays only, Ward watchdog:** `gh run list --repo malinfossum/ward --workflow repo-audit.yml --status completed --limit 1 --json conclusion,updatedAt`
     and the same with `--workflow canary.yml`. Healthy = `conclusion` is `success` and `updatedAt`
     is within the last 8 days. A `HTTP 404: workflow canary.yml not found` means the canary does
     not exist yet (Plan 5), not a failure. An empty list (`[]`) means the workflow exists but has
     never completed a run: report it as `never ran`.
```

- [ ] **Step 2: Add the Repos line**

In step 3's **Repos** bullet, after the sentence that ends `bold means *my* action, nothing else.`, insert:
```markdown
     Ward watchdog ran (Mondays) → one line: `Ward watchdog: audit ok (dd.mm), canary ok (dd.mm)`.
     A red or stale run makes it `**Fix** Ward watchdog: audit failure (dd.mm)` or
     `**Fix** Ward watchdog: audit stale (N days)` or `**Fix** Ward watchdog: audit never ran`; a
     missing canary reads `canary: not yet (Plan 5)`.
```
The line counts against the Repos section's cap of 5 and the briefing's 30; nothing else grows.

- [ ] **Step 3: Verify and commit in the harness repo**

Run: `wc -l ~/.claude/skills/morning/SKILL.md` and read the two edited spots back to check the indentation matches the surrounding bullets (3 spaces for the gather list, 5 for the Repos sub-lines). Then:
```bash
cd ~/.claude
git status --short skills/morning
git add skills/morning/SKILL.md
git -c user.name="Malin Fossum" -c user.email=malinfossum.dev@proton.me commit -m "Morning briefing: watch Ward's audit and canary on Mondays"
```
Pushing the harness repo is Malin's call; say so in the report.

---

## Follow-ups (dated)

- After the next workbench release (the first one after Task 10 merges): delete workbench's `.github/workflows/repo-hygiene.yml` forwarder.
- Plan 5: the canary workflow. Once `canary.yml` exists, remove `canary-missing` from `WARN_KINDS` in `tools/repo-audit.mjs` and the `assert.ok(WARN_KINDS.has("canary-missing"))` line in its test, so that a deleted or renamed canary fails the audit instead of reading as "not yet" for ever, and drop `--warn-kinds caller` from `repo-audit.yml`, so a missing caller fails the audit again. Consider folding the hygiene job into `templates/ward.yml` at rollout.
- Plan 6: python, powershell and docker move from `planned` to `shipped` in `stacks.json` with their caller inputs.
- 2026-10-28: Node 26 becomes Active LTS; bump the `node-version` default in `ci.yml` and the `"24"` fallback in `auditRepo`.
- `WARD_AUDIT_TOKEN` on Ward expires one year after Task 9 Step 1 (I write the date here at that step). The Monday after, the audit is red with a `token` finding on every repo of mine; I make a new token the same way.

## Considered and rejected (stress test 2026-09-30)

- **"Only select repositories" for the audit token.** With Contents off the token, an "All repositories" token can read the settings of a private repo, never its files. Select repositories would make every new public repo a token edit, and the audit would report it as a `token` failure until I did. Not worth the upkeep.
- **Per-repo error handling in the hygiene sweep.** `repo-hygiene.mjs` moves as-is, so one 5xx still aborts the README sweep; the audit step runs anyway (`!cancelled()`) and the audit, which is new code, catches per repo.
- **Ward's own hygiene job in strict mode on the schedule.** Ward's `ward.yml` runs weekly, so a README drift on Ward makes that run red on top of the audit. The mode expression stays the one every caller uses; the fix is one line in one README.
- **External links fetched by `checkLinks` on a fork PR.** The reusable hygiene workflow fetches every external URL in the README under test, from a runner with a read-only token and no secrets. Existing behaviour, nothing to exfiltrate, left alone.
- **Markdown in the step summary.** Advisory URLs and reasons come from my own repos' `Directory.Build.props`; a `|` in a reason would break that table row, not the run. Not sanitised.
- **A rate-limit check on the Actions token.** The sweep makes about ten calls per repo against a limit of 1,000 an hour. A limit hit throws on the tree call and shows as that repo's `error` finding, which is signal enough.
- **A date-based switch for `canary-missing`.** Turning the warning into a failure on a fixed date is a time bomb if Plan 5 slips; the dated follow-up names the code change instead.
- **Apache 2.0 for Ward.** Considered for its explicit patent grant and contribution terms. MIT chosen to match workbench and every other public repo of mine; I can swap it before merge.

> Stress-tested 2026-09-30 (skill 1fc847e) — 12 applied, 3 adapted, 3 decided by me.
