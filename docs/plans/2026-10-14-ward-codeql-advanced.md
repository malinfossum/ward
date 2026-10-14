# Ward: CodeQL as a workflow, so fork pull requests get scanned (v1.4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution:** subagent-driven (locked for Ward). A fresh implementer per task, a fresh reviewer per task, then one whole-branch review before Task 8.

**Goal:** Replace CodeQL's default setup with a pinned reusable workflow that every caller runs as a `codeql` job on `pull_request`, so a fork's pull request gets analysed and the `code_scanning` rule never has to be turned off by hand again.

**Architecture:** `tools/codeql-languages.mjs` maps the tracked files to CodeQL languages; `.github/workflows/codeql.yml` runs it in a `languages` job and fans out one buildless `analyze` leg per language. The caller template gains a `codeql` job pinned to a full commit SHA, Ward's own `ward.yml` calls it by `./`. `apply.mjs files` adds the job to an older caller, `apply.mjs settings` turns default setup off only once the job is visible and covers every language default setup scans, and the audit flips: default setup on is a finding, a caller without a pinned `codeql` job is one too.

**Tech Stack:** Node 24 ESM scripts with no dependencies, `node:test`, `node:assert/strict`, Biome 2.5.15, GitHub Actions reusable workflows, `github/codeql-action` v4.38.3, GitHub REST API via `fetch`.

**Spec:** `docs/specs/2026-10-14-codeql-advanced-design.md` (approved and stress-tested 2026-10-14). Read it end to end before Task 1.

## Global Constraints

Copied from the spec:

- "Its own reusable workflow, pinned by SHA." The `codeql` job "holds `security-events: write`, and a write-holding job never follows the moving `v1` tag. Still one caller file per repo."
- "Languages are found at runtime, not set as an input." No new caller input.
- "`build-mode: none` for every language." "No `run:` step and no autobuild in this job: the only steps are checkout, init and analyze."
- "As little fork code as possible runs in the job that can write." No build step and no npm hook. "C# buildless extraction still runs `dotnet restore`"; "the real protection is the fork run's read-only token and my 'Approve and run'."
- "The array only ever holds names from the table below, whatever the file names are." `git ls-files -z`, NUL-separated.
- "Every action is pinned to a full SHA with a version comment, as `workflows.test.mjs` already demands."
- "the `code_scanning` rule stays in `templates/ruleset.json`, and a fork's workflow runs still wait for my 'Approve and run'."
- "Ward PRs are merged with a merge commit, never squashed, so the branch commit stays reachable from `main` and from `v1.4.0`. Any later change to either file on the branch means a new pin before merge."
- "`--dir` has no default." "A `--dir` whose origin is a different repo than the argument is a `stop`."
- "A repo is never left unscanned by accident."
- "`package.json` version to `1.4.0`; the tag and release are a separate step on my go."

Mine, for every task:

- No em dashes anywhere: code comments, docs, commit messages, the PR body, this plan. Rewrite the sentence instead.
- Commits are authored as the repo's configured git user (`Malin Fossum <malinfossum.dev@proton.me>`). Never a `Co-Authored-By` trailer or any AI attribution in a commit or the PR.
- Ward PRs are merged with a merge commit, never squash.
- Every action is pinned to a full commit SHA with a version comment. No workflow uses `pull_request_target`.
- Branch `feat/codeql-advanced` is already checked out; never switch branches. Commit after every task.
- Node 24, standard library only. Scripts start processes as argument arrays, never shell strings. A failing script sets `process.exitCode = 1`; nothing calls `process.exit`. `apply.mjs` output lines stay `<word padded to 7> <text>` with the existing words.
- `npm test` (`node --test "tools/*.test.mjs"`) and `npm run lint` (`biome ci .`) are green at the end of every task. Test totals are stated as "previous count + N" and read off the run, never invented. Run `npm test` without `GITHUB_TOKEN` in the environment: the one live test reads Ward's default branch, which lacks the `codeql` job until this PR merges.
- Biome formats at 100 columns. After writing code, run `npx biome check --write <the files you touched>` and then `npm run lint`.
- No tag, no release, no merge in this plan. Those sit in "Release (owner's go)".

## Review Focus

Each line is an input the spec implies but does not spell out as a test, with the behaviour a reasonable person expects, most likely first. The test that pins it is in the named task.

1. **A repo whose default setup scans something the workflow would not** (C or C++ with only headers in the tree, or a language outside the table such as `go`). Expected: `settings` stops, names the language, and leaves default setup on. Pinned in Task 5 (coverage stop over the API and over `planSettings`).
2. **`settings --dir .` run from a Ward clone for another repo**, or from a folder with no GitHub origin. Expected: a `stop` naming both repos, nothing written; an origin that differs only in case is the same repo. Pinned in Task 5 (`--dir` tests).
3. **A caller from before v1.4.0 that is not the template byte for byte**: CRLF, a hand edit (`a11y: "warn"`), no `automerge` job, or jobs indented four spaces. Expected: the edit only inserts the block and keeps everything else, and an indentation it cannot match is `drift`, never broken YAML. Pinned in Task 4.
4. **A tracked file name built to mislead the language list** (a newline inside the name, such as `docs/a.py\nb.txt`). Expected: it stays one path, counts by its real extension, and `$GITHUB_OUTPUT` only ever receives names from the table. Pinned in Task 1 (`trackedFiles` and CLI tests).
5. **Default setup that answers `configured` without a `languages` list.** Expected: a `stop`, never a blind "off", because the coverage guard cannot run. Pinned in Task 5 (`planSettings` test).

## Reference facts (verified 2026-10-14)

- Ward `feat/codeql-advanced` is at `aaa61f8` (the spec commit) on top of `main` `3ec0a57`. `npm test`: 220 tests, 219 pass, 1 skipped (the live audit test). `npm run lint`: 32 files, clean. No open PRs on `malinfossum/ward`; the repo is public.
- `github/codeql-action`: the latest action release is `v4.38.3` (2026-10-08), commit `24c54180a607b1449ed407dd24f251e4e9147c8d` (`gh api repos/github/codeql-action/commits/v4.38.3 -q .sha`; the annotated tag object is `cee97f86...`, which is not what a pin uses). `v4` points at the same commit. There is no `v5`. `releases/latest` answers with a `codeql-bundle-v2.27.2` release, which is the CLI bundle, not the action. `init` takes `languages` and `build-mode` (single language per job); `analyze` takes `category`.
- Pins already in use: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`.
- `GET /repos/malinfossum/ward/code-scanning/default-setup` today: `configured`, languages `actions, csharp, javascript, javascript-typescript, typescript`. Folded, that is `actions, csharp, javascript-typescript`, which is exactly what `languagesFor` gives over Ward's tracked files (`.mjs` and `.js` tools, `.cs` fixtures).
- `ci.yml` and `repo-hygiene.yml` fetch Ward's tools with `sparse-checkout: tools` at `job.workflow_sha`. Cone mode (the checkout default) always includes the files at the root, so `stacks.json` is there for `loadStacks()`.
- `.gitattributes` is `* text=auto eol=lf`, so the templates and workflows are LF in the working tree.
- `writeFiles` in `apply.mjs` writes an `edit` without the `wx` flag, so an edited caller overwrites the old one; a `create` still never overwrites.
- `fetchRepoData` already returns `tree` (every blob path on the default branch) and `caller` (the text of `.github/workflows/ward.yml` or `null`); `readState` keeps only `baseline` today.
- Windows refuses a file name with a newline on disk, and git refuses one in the index unless `core.protectNTFS=false`. With that flag, `git update-index --add --cacheinfo 100644,<blob>,"src/a.py\nb.txt"` works here, and `git ls-files -z` returns it as one entry.
- `spawnSync`'s default `maxBuffer` is 1 MiB; `trackedFiles` raises it so a large repo's file list is not cut off.
- Every warded repo is public today; CodeQL on a private repo needs GitHub Advanced Security, which I do not have.

## File map

| Path | Task | What |
|---|---|---|
| `tools/codeql-languages.mjs`, `tools/codeql-languages.test.mjs` | 1 | `LANGUAGES`, `languagesFor(paths, ignore)`, `trackedFiles(dir)`, the CLI |
| `.github/workflows/codeql.yml`, `.github/workflows/ward.yml`, `tools/workflows.test.mjs` | 2 | The workflow, Ward's own `codeql` job, the workflow guards |
| `templates/ward.yml`, `tools/templates.test.mjs` | 2, 7 | The template's `codeql` job (interim pin in 2, final pin in 7) |
| `tools/repo-audit.mjs`, `tools/repo-audit.test.mjs` | 3 | `parseCaller().codeql`, `CODEQL_PINNED`, `SELF_CODEQL`, `checkCaller`, `checkBaseline` flip |
| `tools/apply.mjs`, `tools/apply.test.mjs` | 4, 5, 6 | `addCodeqlJob` and the caller edit (4); `readState`, `planSettings`, `settingsCommand`, `statusLine`, `USAGE` (5) |
| `docs/apply.md`, `docs/repo-audit.md`, `README.md`, `package.json`, `package-lock.json` | 6 | Docs and version 1.4.0 |

---

### Task 1: Which CodeQL languages a tree needs

**Files:**
- Create: `tools/codeql-languages.mjs`
- Test: `tools/codeql-languages.test.mjs`

**Interfaces:**
- Consumes: `ignored(path, prefixes)` and `loadStacks()` from `tools/stacks.mjs`.
- Produces: `LANGUAGES: string[]` (the table in output order: `actions`, `csharp`, `javascript-typescript`, `python`, `c-cpp`); `languagesFor(paths: string[], ignore: string[]) → string[]` (always starts with `actions`, then the table rows that match, in table order); `trackedFiles(dir: string) → string[] | null` (`git -C dir ls-files -z`, `null` when git fails). The CLI (`node tools/codeql-languages.mjs`, run in a checkout) prints `languages=<json>` and appends the same line to `$GITHUB_OUTPUT` when it is set. Task 2's workflow runs the CLI; Task 5's `settings` calls `languagesFor` and `trackedFiles`.

The output order is the spec's table order: `actions`, `csharp`, `javascript-typescript`, `python`, `c-cpp`. It never depends on the order git lists the files.

- [ ] **Step 1: Write the failing tests**

Create `tools/codeql-languages.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LANGUAGES, languagesFor, trackedFiles } from "./codeql-languages.mjs";
import { loadStacks } from "./stacks.mjs";

const { ignore } = loadStacks();
const langs = (...paths) => languagesFor(paths, ignore);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "codeql-languages.mjs");

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "ward-codeql-"));
  made.push(dir);
  return dir;
};

// A git work tree with the given files staged, as a checkout would have them tracked.
function staged(files) {
  const dir = scratch();
  spawnSync("git", ["-C", dir, "init", "-q"]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  spawnSync("git", ["-C", dir, "add", "."]);
  return dir;
}

test("actions is always there, even in a tree with no code", () => {
  assert.deepEqual(langs(), ["actions"]);
  assert.deepEqual(langs(".github/workflows/ward.yml", "README.md"), ["actions"]);
});

test("each row of the table: C#, JavaScript and TypeScript, Python, C and C++", () => {
  assert.deepEqual(langs("src/App/Program.cs"), ["actions", "csharp"]);
  for (const ext of ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"]) {
    assert.deepEqual(langs(`src/a.${ext}`), ["actions", "javascript-typescript"], ext);
  }
  assert.deepEqual(langs("tools/build.py"), ["actions", "python"]);
  for (const ext of ["c", "cc", "cpp", "cxx", "c++"]) {
    assert.deepEqual(langs(`src/a.${ext}`), ["actions", "c-cpp"], ext);
  }
});

test("the order is the table's, whatever order the files come in", () => {
  const all = ["main.c", "app.py", "web/app.ts", "src/A.cs"];
  const expected = ["actions", "csharp", "javascript-typescript", "python", "c-cpp"];
  assert.deepEqual(languagesFor(all, ignore), expected);
  assert.deepEqual(languagesFor([...all].reverse(), ignore), expected);
  assert.deepEqual(LANGUAGES, expected);
});

test("ignored folders, minified scripts, HTML and lone headers never count", () => {
  assert.deepEqual(langs("node_modules/x/index.js", "bin/Debug/a.cs", "src/obj/b.cs"), ["actions"]);
  assert.deepEqual(langs("wwwroot/lib/jquery.min.js", "vendor/A.MIN.JS"), ["actions"]);
  assert.deepEqual(langs("index.html", "styles.css"), ["actions"]);
  assert.deepEqual(langs("include/lib.h", "include/lib.hpp"), ["actions"]);
  // A .d.ts-only tree is TypeScript, and an ignore prefix matches whole segments only.
  assert.deepEqual(langs("types/index.d.ts"), ["actions", "javascript-typescript"]);
  assert.deepEqual(langs("cabin/a.cs"), ["actions", "csharp"]);
});

test("trackedFiles reads git's NUL-separated list, so a name with a newline is one path", () => {
  const dir = staged({ "src/app.ts": "" });
  const blob = spawnSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], {
    input: "x\n",
    encoding: "utf8",
  }).stdout.trim();
  // Windows cannot hold such a file on disk, but an index can, as a fork's tree could.
  const added = spawnSync("git", [
    "-C",
    dir,
    "-c",
    "core.protectNTFS=false",
    "update-index",
    "--add",
    "--cacheinfo",
    `100644,${blob},docs/a.py\nb.txt`,
  ]);
  assert.equal(added.status, 0, String(added.stderr));
  const paths = trackedFiles(dir);
  assert.deepEqual([...paths].sort(), ["docs/a.py\nb.txt", "src/app.ts"]);
  assert.deepEqual(languagesFor(paths, ignore), ["actions", "javascript-typescript"]);
  assert.equal(trackedFiles(join(dir, "no-such-dir")), null);
});

test("the CLI appends languages=<json> to GITHUB_OUTPUT, built only from the table's names", () => {
  const dir = staged({ "app.py": "", "web/index.html": "", "lib/a.cs": "" });
  const out = join(scratch(), "output");
  writeFileSync(out, "earlier=1\n");
  const run = spawnSync(process.execPath, [CLI], {
    cwd: dir,
    env: { ...process.env, GITHUB_OUTPUT: out },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const line = 'languages=["actions","csharp","python"]';
  assert.equal(readFileSync(out, "utf8"), `earlier=1\n${line}\n`);
  assert.ok(run.stdout.includes(line));
  const written = readFileSync(out, "utf8").trim().split("\n").at(-1);
  const listed = JSON.parse(written.slice("languages=".length));
  assert.ok(listed.every((name) => LANGUAGES.includes(name)));
});

test("the CLI outside a git work tree fails with an error annotation and writes nothing", () => {
  const plain = scratch();
  const out = join(scratch(), "output");
  writeFileSync(out, "");
  const run = spawnSync(process.execPath, [CLI], {
    cwd: plain,
    // Stops git from finding a repository above the scratch folder.
    env: { ...process.env, GITHUB_OUTPUT: out, GIT_CEILING_DIRECTORIES: tmpdir() },
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^::error::/);
  assert.equal(readFileSync(out, "utf8"), "");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tools/codeql-languages.test.mjs`
Expected: FAIL, `Cannot find module` for `./codeql-languages.mjs`.

- [ ] **Step 3: Write the implementation**

Create `tools/codeql-languages.mjs`:

```js
// The CodeQL languages a repo needs, from the files git tracks. The codeql
// workflow's first job runs this and hands the list to the analyze matrix, so
// a new language in a repo is picked up on its next run with nothing to set.
// apply.mjs runs the same function over a checkout before it turns default
// setup off, so the workflow never scans less than default setup did. Any
// change here means a new pin for the codeql job in templates/ward.yml.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ignored, loadStacks } from "./stacks.mjs";

// In output order, after actions, which is always there: every warded repo
// has its caller. A header alone is not code CodeQL can extract, and a run with
// nothing to extract fails, so .h and .hpp never count.
const RULES = [
  ["csharp", /\.cs$/i],
  ["javascript-typescript", /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i],
  ["python", /\.py$/i],
  ["c-cpp", /\.(?:c|cc|cpp|cxx|c\+\+)$/i],
];

export const LANGUAGES = ["actions", ...RULES.map(([name]) => name)];

// CodeQL's extractor skips minified code, so a tree with only vendored .min.js
// files would get a JavaScript run with nothing to extract, which fails.
const MINIFIED = /\.min\.js$/i;

// paths are repo-relative with forward slashes; ignore is stacks.json's list.
// The result only ever holds names from LANGUAGES, whatever the paths are.
export function languagesFor(paths, ignore) {
  const kept = paths.filter((path) => !ignored(path, ignore) && !MINIFIED.test(path));
  const found = RULES.filter(([, pattern]) => kept.some((path) => pattern.test(path)));
  return ["actions", ...found.map(([name]) => name)];
}

// The files git tracks under dir, split on NUL so a name with a newline in it
// stays one path. null when git fails there (not a work tree). The buffer is
// raised from 1 MiB so a large repo's list is never cut short.
export function trackedFiles(dir) {
  const listed = spawnSync("git", ["-C", dir, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) return null;
  return listed.stdout.split("\0").filter(Boolean);
}

function main() {
  const paths = trackedFiles(".");
  if (!paths) {
    console.log("::error::git ls-files failed here; run this inside a checkout.");
    process.exitCode = 1;
    return;
  }
  const line = `languages=${JSON.stringify(languagesFor(paths, loadStacks().ignore))}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test tools/codeql-languages.test.mjs`
Expected: 7 tests, 7 pass.

- [ ] **Step 5: Format, lint, full suite**

Run: `npx biome check --write tools/codeql-languages.mjs tools/codeql-languages.test.mjs && npm run lint && npm test`
Expected: lint clean (32 + 2 files); `npm test` 220 + 7 = 227 tests, 226 pass, 1 skipped.

- [ ] **Step 6: Commit**

```bash
git add tools/codeql-languages.mjs tools/codeql-languages.test.mjs
git commit -m "Map a repo's tracked files to CodeQL languages"
```

---

### Task 2: The `codeql.yml` workflow, Ward's own `codeql` job, and the template's job

**Files:**
- Create: `.github/workflows/codeql.yml`
- Modify: `.github/workflows/ward.yml` (a `codeql` job between `hygiene` and `automerge`), `tools/workflows.test.mjs` (the timeout test, the reusable-workflow count, three new tests), `templates/ward.yml` (the `codeql` job between `ward` and `automerge`), `tools/templates.test.mjs` (one new test)

**Interfaces:**
- Consumes: the CLI from Task 1 (`node "$RUNNER_TEMP/ward/tools/codeql-languages.mjs"` writes `languages` to `$GITHUB_OUTPUT`).
- Produces: `.github/workflows/codeql.yml` (`on: workflow_call`, no inputs; jobs `languages` and `analyze`). `templates/ward.yml` holds this exact block before `automerge:`, which Task 4 copies into older callers and Task 7 repins:

```yaml
  # CodeQL on every pull request, forks included; the main ruleset waits for its results.
  codeql:
    permissions:
      actions: read
      contents: read
      security-events: write
    uses: malinfossum/ward/.github/workflows/codeql.yml@<40-hex SHA> # v1.4.0
```

This task makes two commits: the workflow first, then the template pinned to that first commit, which is the first commit that holds both `codeql.yml` and `tools/codeql-languages.mjs`. Task 7 checks the pin again at the end.

- [ ] **Step 1: Write the failing workflow tests**

In `tools/workflows.test.mjs`, replace the test `every job that runs steps has a 10 or 30 minute timeout` with:

```js
test("every job that runs steps has a 10 or 30 minute timeout; CodeQL's analyze gets 60", () => {
  let checked = 0;
  for (const file of workflows) {
    for (const job of jobsOf(file)) {
      if (!/^ {4}runs-on:/m.test(job.body)) continue;
      checked++;
      // A cold CodeQL analysis of a C# tree can outrun 30 minutes; the spec gives it 60.
      const minutes = file.endsWith("codeql.yml") && job.name === "analyze" ? "60" : "(10|30)";
      assert.match(
        job.body,
        new RegExp(`^ {4}timeout-minutes: ${minutes}$`, "m"),
        `${file}: job ${job.name}`,
      );
    }
  }
  assert.ok(checked > 0, "no job with runs-on was scanned");
});
```

In the test `every reusable workflow fetches Ward's tools at its own commit`, change the last line to:

```js
  assert.equal(checked, 4, "ci.yml, codeql.yml, dependabot-automerge.yml and repo-hygiene.yml");
```

Append to the end of `tools/workflows.test.mjs`:

```js
const CODEQL = ".github/workflows/codeql.yml";

test("codeql.yml analyses every language buildless and runs nothing else where it can write", () => {
  const text = readWorkflow(CODEQL);
  const inits = text.split(/^ {6}- /m).filter((step) => /codeql-action\/init@/.test(step));
  assert.ok(inits.length > 0, "no init step found");
  for (const step of inits) assert.match(step, /^ {10}build-mode: none$/m);
  const analyze = jobsOf(CODEQL).find((job) => job.name === "analyze");
  assert.ok(analyze, "no analyze job in codeql.yml");
  assert.doesNotMatch(analyze.body, /^\s*(- )?run:/m);
  assert.doesNotMatch(analyze.body, /autobuild/);
  const steps = [...analyze.body.matchAll(/^ {6}- (\S+):\s*([^@\s]+)/gm)].map(
    (m) => `${m[1]} ${m[2]}`,
  );
  assert.deepEqual(steps, [
    "uses actions/checkout",
    "uses github/codeql-action/init",
    "uses github/codeql-action/analyze",
  ]);
  assert.match(analyze.body, /^ {10}persist-credentials: false$/m);
  assert.match(analyze.body, /^ {10}category: "\/language:\$\{\{ matrix\.language \}\}"$/m);
  // init and analyze must run the same CodeQL; Dependabot bumps them together.
  const pins = [...text.matchAll(/github\/codeql-action\/\w+@([0-9a-f]{40})/g)].map((m) => m[1]);
  assert.equal(pins.length, 2);
  assert.equal(new Set(pins).size, 1, "init and analyze pin different commits");
});

test("codeql.yml holds security-events: write on analyze alone, fed by the languages job", () => {
  const text = readWorkflow(CODEQL);
  assert.match(text, /^ {2}workflow_call:\s*$/m);
  assert.doesNotMatch(text, /^ {4}inputs:/m, "codeql.yml takes no inputs");
  // Comments may name the permission; only YAML lines grant it.
  const code = (yaml) => yaml.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(code(text.split(/^jobs:/m)[0]), /security-events/);
  const jobs = jobsOf(CODEQL);
  assert.deepEqual(
    jobs.map((job) => job.name),
    ["languages", "analyze"],
  );
  const [languages, analyze] = jobs;
  assert.doesNotMatch(code(languages.body), /security-events/);
  assert.match(languages.body, /^ {6}languages: \$\{\{ steps\.detect\.outputs\.languages \}\}$/m);
  assert.match(languages.body, /run: node "\$RUNNER_TEMP\/ward\/tools\/codeql-languages\.mjs"/);
  assert.match(
    analyze.body,
    /^ {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}security-events: write\n(?! {6})/m,
  );
  assert.match(analyze.body, /^ {4}needs: languages$/m);
  assert.match(analyze.body, /^ {6}fail-fast: false$/m);
  assert.match(
    analyze.body,
    /^ {8}language: \$\{\{ fromJSON\(needs\.languages\.outputs\.languages\) \}\}$/m,
  );
});

test("only Ward's own ward.yml calls codeql.yml by local path, with what analyze needs", () => {
  for (const file of files) {
    if (file.replaceAll("\\", "/") === ".github/workflows/ward.yml") continue;
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /uses:\s*\.\/\.github\/workflows\/codeql\.yml/,
      file,
    );
  }
  const job = jobsOf(".github/workflows/ward.yml").find((j) => j.name === "codeql");
  assert.ok(job, "no codeql job in ward.yml");
  assert.match(job.body, /^ {4}uses: \.\/\.github\/workflows\/codeql\.yml$/m);
  for (const line of ["actions: read", "contents: read", "security-events: write"]) {
    assert.match(job.body, new RegExp(`^ {6}${line}$`, "m"), line);
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tools/workflows.test.mjs`
Expected: FAIL. The three new tests fail with `ENOENT` for `codeql.yml` or `no codeql job in ward.yml`; the reusable count test fails with `3 !== 4`.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/codeql.yml`:

```yaml
# CodeQL as a workflow, so a pull request from a fork gets analysed too; default
# setup never analyses one. A repo calls this from its caller as the codeql job,
# pinned to a full commit SHA, because analyze holds security-events: write.
# Every language runs with build-mode none: no build step and no npm hook
# runs here. C# buildless extraction still runs dotnet restore, so the guard
# is the fork run's read-only token and the owner's Approve and run.
name: CodeQL

on:
  workflow_call:

permissions:
  contents: read

env:
  DOTNET_CLI_TELEMETRY_OPTOUT: "1"
  ASTRO_TELEMETRY_DISABLED: "1"
  WRANGLER_SEND_METRICS: "false"

jobs:
  languages:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      languages: ${{ steps.detect.outputs.languages }}
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
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "24"
      - name: Languages in this repo
        id: detect
        run: node "$RUNNER_TEMP/ward/tools/codeql-languages.mjs"

  # The category is the one default setup used, so the alerts already open
  # carry over instead of closing and reopening.
  analyze:
    needs: languages
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      actions: read
      contents: read
      security-events: write
    strategy:
      fail-fast: false
      matrix:
        language: ${{ fromJSON(needs.languages.outputs.languages) }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: github/codeql-action/init@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
        with:
          languages: ${{ matrix.language }}
          build-mode: none
      - uses: github/codeql-action/analyze@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
        with:
          category: "/language:${{ matrix.language }}"
```

In `.github/workflows/ward.yml`, insert this job between the `hygiene` job and the `automerge` job (a blank line on each side, as the other jobs have):

```yaml
  # CodeQL on every pull request, forks included. Ward calls its own copy by ./
  # so a PR tests the workflow it changes; a fork's run has a read-only token
  # and waits for my approval, so the local call gives nothing away.
  codeql:
    permissions:
      actions: read
      contents: read
      security-events: write
    uses: ./.github/workflows/codeql.yml
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test tools/workflows.test.mjs`
Expected: all pass (the existing tests plus 3 new ones). The pinning, telemetry, top-level permissions and `pull_request_target` tests now also cover `codeql.yml`.

- [ ] **Step 5: Lint, full suite, commit the workflow**

Run: `npm run lint && npm test`
Expected: lint clean; 227 + 3 = 230 tests, 229 pass, 1 skipped.

```bash
git add .github/workflows/codeql.yml .github/workflows/ward.yml tools/workflows.test.mjs
git commit -m "Run CodeQL as a reusable workflow, buildless, one leg per language"
```

- [ ] **Step 6: Write the failing template test**

Append to `tools/templates.test.mjs`:

```js
test("the caller template's codeql job is SHA-pinned and sits between ward and automerge", () => {
  const caller = read("templates/ward.yml");
  const jobs = caller.split(/^jobs:\r?\n/m)[1];
  assert.deepEqual(
    [...jobs.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)].map((m) => m[1]),
    ["ward", "codeql", "automerge"],
  );
  assert.match(
    caller,
    /^ {4}uses: malinfossum\/ward\/\.github\/workflows\/codeql\.yml@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m,
  );
  const block = jobs.split(/^ {2}codeql:\s*$/m)[1].split(/^ {2}automerge:/m)[0];
  for (const line of ["actions: read", "contents: read", "security-events: write"]) {
    assert.match(block, new RegExp(`^ {6}${line}$`, "m"), line);
  }
});
```

Run: `node --test tools/templates.test.mjs`
Expected: FAIL, the job list is `[ 'ward', 'automerge' ]`.

- [ ] **Step 7: Add the job to the template, pinned to the workflow commit**

Run `git rev-parse HEAD` and take the 40-hex SHA it prints (the commit from Step 5). In `templates/ward.yml`, insert this block between the `ward` job's last input line and the blank line before `  automerge:`, with a blank line above it, using that SHA after `codeql.yml@`:

```yaml

  # CodeQL on every pull request, forks included; the main ruleset waits for its results.
  codeql:
    permissions:
      actions: read
      contents: read
      security-events: write
    uses: malinfossum/ward/.github/workflows/codeql.yml@<the SHA from git rev-parse HEAD> # v1.4.0
```

The result reads: the `ward` job, a blank line, the comment and the `codeql` job, a blank line, the `automerge` job. Check with `grep -n "codeql.yml@" templates/ward.yml`: one line, a 40-hex SHA, `# v1.4.0`.

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm test && npm run lint`
Expected: 230 + 1 = 231 tests, 230 pass, 1 skipped; lint clean. The existing `every action is pinned to a full SHA with a version comment` test now scans the template's `codeql` line too. `apply.test.mjs` still passes: `renderCaller` leaves the block alone (none of its keys is an input).

- [ ] **Step 9: Commit**

```bash
git add templates/ward.yml tools/templates.test.mjs
git commit -m "Add the codeql job to the caller template, pinned by SHA"
```

---

### Task 3: The audit reads the `codeql` job and flips the default setup check

**Files:**
- Modify: `tools/repo-audit.mjs` (`parseCaller`, `checkCaller`, `checkBaseline`, two new exports)
- Test: `tools/repo-audit.test.mjs`

**Interfaces:**
- Consumes: `templates/ward.yml` with the `codeql` job (Task 2).
- Produces: `parseCaller(text)` returns `{ uses, inputs, automerge, codeql }` (`codeql` is the `uses:` of the `codeql.yml` call, unquoted and without its comment, or `""`). `export const CODEQL_PINNED = /^malinfossum\/ward\/\.github\/workflows\/codeql\.yml@[0-9a-f]{40}$/` and `export const SELF_CODEQL = "./.github/workflows/codeql.yml"`. Task 4 uses `CODEQL_PINNED` and `parseCaller().codeql`; Task 5 uses `parseCaller().codeql`.

- [ ] **Step 1: Update the fixtures and write the failing tests**

In `tools/repo-audit.test.mjs`:

1. Add `CODEQL_PINNED` to the import list from `./repo-audit.mjs` (alphabetical, after `checkSuppressions`).

2. Above `const CALLER = ...`, add:

```js
const CODEQL_SHA = "0123456789abcdef0123456789abcdef01234567";
```

3. In `CALLER`, insert the `codeql` job between the `ward` job and `automerge`, so the fixture reads:

```js
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

  codeql:
    permissions:
      actions: read
      contents: read
      security-events: write
    uses: malinfossum/ward/.github/workflows/codeql.yml@${CODEQL_SHA} # v1.4.0

  automerge:
    if: github.event_name == 'pull_request'
    uses: malinfossum/ward/.github/workflows/dependabot-automerge.yml@2939fee7aac178f0fdbc4ee9505a3e0464314e0c # v1.0.0
    with:
      required-check: ward / gate
`;
```

4. In `parseCaller reads a caller with no with: block, and none for a file that never calls ci.yml`, the expected object becomes:

```js
  assert.deepEqual(parseCaller(bare), {
    uses: "malinfossum/ward/.github/workflows/ci.yml@v1",
    inputs: {},
    automerge: "",
    codeql: "",
  });
```

5. In `a block scalar input is read: folded after >, line by line after |`, replace the `const folded = ...;` line with one that carries a pinned `codeql` job before `automerge`:

```js
  const folded = `jobs:\n  ward:\n    uses: malinfossum/ward/.github/workflows/ci.yml@v1\n    with:\n      a11y: "off"\n      allowed-emails: >-\n        a@example.com,\n        1+b@users.noreply.github.com # text, not a comment\n\n  codeql:\n    uses: malinfossum/ward/.github/workflows/codeql.yml@${CODEQL_SHA}\n\n  automerge:\n    uses: malinfossum/ward/.github/workflows/dependabot-automerge.yml@2939fee7aac178f0fdbc4ee9505a3e0464314e0c\n`;
```

6. Replace the test `Ward itself may call ci.yml by local path; nobody else may` with:

```js
test("Ward itself may call ci.yml and codeql.yml by local path; nobody else may", () => {
  const local =
    "jobs:\n  ward:\n    uses: ./.github/workflows/ci.yml\n    with:\n      node: .\n\n  codeql:\n    uses: ./.github/workflows/codeql.yml\n";
  assert.deepEqual(checkCaller(local, { self: true }), []);
  assert.deepEqual(kinds(checkCaller(local, { self: false })), ["caller", "caller"]);
  assert.deepEqual(parseCaller(local).inputs, { node: "." });
  assert.equal(parseCaller(local).codeql, "./.github/workflows/codeql.yml");
});
```

7. After the test `the automerge job must point at Ward's dependabot-automerge.yml at a full commit SHA`, add:

```js
test("the codeql job must be there and call Ward's codeql.yml at a full commit SHA", () => {
  assert.equal(
    parseCaller(CALLER).codeql,
    `malinfossum/ward/.github/workflows/codeql.yml@${CODEQL_SHA}`,
  );
  const withoutJob = CALLER.replace(/\n {2}codeql:\n(?: {4,}\S[^\n]*\n)+/, "");
  assert.equal(parseCaller(withoutJob).codeql, "");
  assert.deepEqual(checkCaller(withoutJob, { self: false }), [
    ["caller", "ward.yml has no codeql job; run apply.mjs files to add it."],
  ]);
  const floating = CALLER.replace(`codeql.yml@${CODEQL_SHA} # v1.4.0`, "codeql.yml@v1");
  const [unpinned] = checkCaller(floating, { self: false });
  assert.equal(unpinned[0], "caller");
  assert.match(unpinned[1], /codeql job uses .*codeql\.yml@v1; it must be .* at a full commit SHA/);
  const foreign = CALLER.replace(
    "malinfossum/ward/.github/workflows/codeql.yml",
    "someone/else/.github/workflows/codeql.yml",
  );
  assert.deepEqual(kinds(checkCaller(foreign, { self: false })), ["caller"]);
  const local = CALLER.replace(
    `malinfossum/ward/.github/workflows/codeql.yml@${CODEQL_SHA} # v1.4.0`,
    "./.github/workflows/codeql.yml",
  );
  assert.deepEqual(kinds(checkCaller(local, { self: false })), ["caller"]);
  // The template the skill copies passes its own audit.
  assert.match(parseCaller(readFileSync("templates/ward.yml", "utf8")).codeql, CODEQL_PINNED);
});
```

8. In the shared `baseline` fixture, change `codeScanning: { state: "configured" },` to:

```js
  codeScanning: { state: "not-configured" },
```

9. In `each baseline setting that is off is its own finding`, change the `off` fixture's `codeScanning: { state: "not-configured" },` to `codeScanning: { state: "configured" },`, and after `assert.match(findings[5][1], /does not require a pull request/);` add:

```js
  assert.match(findings[4][1], /CodeQL default setup is on/);
```

10. Replace the test `CodeQL off is a finding only where CodeQL has a language to analyse` with:

```js
test("CodeQL default setup on is a finding; off is clean, with or without languages", () => {
  const on = { ...baseline, codeScanning: { state: "configured", languages: ["actions"] } };
  assert.deepEqual(checkBaseline(on), [
    [
      "baseline",
      "CodeQL default setup is on; it blocks the caller's codeql job. Run apply.mjs settings.",
    ],
  ]);
  for (const languages of [undefined, [], ["actions", "csharp"]]) {
    const off = { ...baseline, codeScanning: { state: "not-configured", languages } };
    assert.deepEqual(checkBaseline(off), [], String(languages));
  }
});
```

11. In `fetchRepoData: with admin read, 200 and 204 fill every setting` and `fetchRepoData: with admin read, a 404 on either Dependabot endpoint means off`, change the route `[/\/code-scanning\/default-setup$/, 200, { state: "configured" }],` to:

```js
    [/\/code-scanning\/default-setup$/, 200, { state: "not-configured" }],
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tools/repo-audit.test.mjs`
Expected: FAIL before any test runs: `The requested module './repo-audit.mjs' does not provide an export named 'CODEQL_PINNED'`. (Once that export exists, the remaining failures are the missing `codeql` field, the missing caller findings and the flipped baseline checks.)

- [ ] **Step 3: Write the implementation**

In `tools/repo-audit.mjs`, below `AUTOMERGE_PINNED`, add:

```js
// The codeql job holds security-events: write, so it is pinned the same way.
// Ward calls its own copy by ./ so a pull request tests the workflow it changes.
export const CODEQL_PINNED = /^malinfossum\/ward\/\.github\/workflows\/codeql\.yml@[0-9a-f]{40}$/;
export const SELF_CODEQL = "./.github/workflows/codeql.yml";
```

In the comment above `parseCaller`, change "and the ref of the auto-merge job when there is one." to "and the refs of the auto-merge and codeql jobs when there are." At the end of `parseCaller`, replace the last three lines (from `const automergeLine` to the `return`) with:

```js
  const refOf = (pattern) => {
    const line = lines.find((l) => pattern.test(l));
    return line ? unquote(line.replace(/^\s*uses:\s*/, "")) : "";
  };
  const automerge = refOf(/^\s*uses:\s*\S*dependabot-automerge\.yml/);
  const codeql = refOf(/^\s*uses:\s*\S*\.github\/workflows\/codeql\.yml/);
  return { uses, inputs, automerge, codeql };
```

In `checkCaller`, before `return findings;`, add:

```js
  if (!caller.codeql) {
    findings.push(["caller", "ward.yml has no codeql job; run apply.mjs files to add it."]);
  } else if (!(CODEQL_PINNED.test(caller.codeql) || (self && caller.codeql === SELF_CODEQL))) {
    findings.push([
      "caller",
      `The codeql job uses ${caller.codeql}; it must be malinfossum/ward/.github/workflows/codeql.yml at a full commit SHA.`,
    ]);
  }
```

In `checkBaseline`, replace the whole CodeQL branch (from `if (codeScanning == null) unreadable.push("CodeQL default setup");` through the closing `}` of the `else if`) with:

```js
  if (codeScanning == null) unreadable.push("CodeQL default setup");
  else if (codeScanning.state === "configured") {
    // GitHub refuses the codeql job's uploads while default setup is on.
    findings.push([
      "baseline",
      "CodeQL default setup is on; it blocks the caller's codeql job. Run apply.mjs settings.",
    ]);
  }
```

Replace the file's opening comment (the five lines above the first `import`) with:

```js
// The weekly audit over every repo I own: the baseline settings are on (and
// CodeQL default setup off), the caller is present on @v1 with the inputs the
// repo's stacks need and a pinned codeql job, every NuGet audit suppression
// carries a dated reason, no runtime is near end of life, and Ward's canary is
// alive. Each check is a pure function over fetched data that returns
// [kind, message] findings; main() only fetches and reports.
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test tools/repo-audit.test.mjs`
Expected: all pass, 1 skipped (the live test).

- [ ] **Step 5: Format, lint, full suite**

Run: `npx biome check --write tools/repo-audit.mjs tools/repo-audit.test.mjs && npm run lint && npm test`
Expected: lint clean; 231 + 1 = 232 tests, 231 pass, 1 skipped. `apply.test.mjs` is untouched and green: it never asserts the shape of `parseCaller`'s result as a whole.

- [ ] **Step 6: Commit**

```bash
git add tools/repo-audit.mjs tools/repo-audit.test.mjs
git commit -m "Audit: a pinned codeql job is required and default setup on is a finding"
```

---

### Task 4: `apply.mjs files` adds the `codeql` job to an older caller

**Files:**
- Modify: `tools/apply.mjs` (imports, a new `addCodeqlJob`, `planCaller`)
- Test: `tools/apply.test.mjs`

**Interfaces:**
- Consumes: `parseCaller(text).codeql` and `CODEQL_PINNED` from `tools/repo-audit.mjs` (Task 3); the template block from Task 2.
- Produces: `addCodeqlJob(text: string, template: string) → string | null` (the caller with the template's `codeql` block inserted before `  automerge:` and the comment lines directly above it, or at the end; the file's own line endings; `null` when the first job under `jobs:` is not indented two spaces). `planCaller` returns `{ path, action: "edit", detail: "add the codeql job", content }` for a caller that matches its inputs but has no `codeql` job. In `apply.test.mjs`, the regexes `CODEQL_BLOCK` and `AUTOMERGE_BLOCK` (below) are available to Task 5.

- [ ] **Step 1: Write the failing tests**

In `tools/apply.test.mjs`, after the `caller` helper (`const caller = (inputs) => renderCaller(...)`), add:

```js
// The template's codeql job with the blank line above it: a caller from before
// v1.4.0 is the template without it.
const CODEQL_BLOCK = /\n {2}# CodeQL[^\n]*\n {2}codeql:\n(?: {4}[^\n]*\n)+/;
const AUTOMERGE_BLOCK = /\n {2}automerge:\n(?: {4}[^\n]*\n)+/;
const crlf = (text) => text.replaceAll("\n", "\r\n");
```

The test `a file that differs only in line endings is kept, not drift` holds the same `crlf` as a local; delete that local line so it does not shadow the module one.

After the test `a hand-edited caller (a11y in warn, an extra address) is never overwritten`, add:

```js
test("a caller without the codeql job gets it before automerge, in its own line endings", () => {
  const full = caller({ node: "." });
  const old = full.replace(CODEQL_BLOCK, "");
  assert.notEqual(old, full, "the template has no codeql block to remove");
  const dir = repo({ [CALLER]: old, "package.json": PKG });
  const edit = file(planFiles(dir, { templates }), CALLER);
  assert.deepEqual([edit.action, edit.detail], ["edit", "add the codeql job"]);
  assert.equal(edit.content, full);
  writeFileSync(join(dir, CALLER), crlf(old));
  assert.equal(file(planFiles(dir, { templates }), CALLER).content, crlf(full));
});

test("a caller without automerge gets the codeql job at the end, and a hand edit survives", () => {
  const full = caller({ node: "." })
    .replace(AUTOMERGE_BLOCK, "")
    .replace('a11y: "off"', 'a11y: "warn"');
  const old = full.replace(CODEQL_BLOCK, "");
  const dir = repo({ [CALLER]: old, "package.json": PKG });
  const plan = planFiles(dir, { templates });
  assert.equal(file(plan, CALLER).content, full);
  assert.deepEqual(writeFiles(dir, plan), [CALLER, DEPENDABOT]);
  assert.equal(readFileSync(join(dir, CALLER), "utf8"), full);
  assert.equal(file(planFiles(dir, { templates }), CALLER).action, "keep");
});

test("input drift plus a missing codeql job stays drift; an unpinned codeql job is drift", () => {
  const dir = repo({
    [CALLER]: caller({ node: "." }).replace(CODEQL_BLOCK, ""),
    "web/package.json": PKG,
  });
  const drift = file(planFiles(dir, { templates }), CALLER);
  assert.equal(drift.action, "drift");
  assert.equal(drift.detail, 'node is ".", the files say "web"; no codeql job');
  const floating = caller({ node: "." }).replace(/codeql\.yml@[0-9a-f]{40}/, "codeql.yml@v1");
  const pinless = repo({ [CALLER]: floating, "package.json": PKG });
  const unpinned = file(planFiles(pinless, { templates }), CALLER);
  assert.equal(unpinned.action, "drift");
  assert.equal(
    unpinned.detail,
    "the codeql job uses malinfossum/ward/.github/workflows/codeql.yml@v1, not a full commit SHA",
  );
});

test("a caller whose jobs are not indented two spaces is drift, never a broken edit", () => {
  const four = caller({ node: "." }).replace(CODEQL_BLOCK, "").replace(/^( +)/gm, "$1$1");
  const dir = repo({ [CALLER]: four, "package.json": PKG });
  const plan = file(planFiles(dir, { templates }), CALLER);
  assert.equal(plan.action, "drift");
  assert.equal(
    plan.detail,
    "jobs are not indented two spaces; add the codeql job from templates/ward.yml by hand",
  );
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tools/apply.test.mjs`
Expected: FAIL. The four new tests get `keep` where they expect `edit` or `drift`.

- [ ] **Step 3: Write the implementation**

In `tools/apply.mjs`, add `CODEQL_PINNED` to the import from `./repo-audit.mjs`:

```js
import {
  CODEQL_PINNED,
  exceptionsFor,
  fetchRepoData,
  indentOf,
  parseCaller,
  REQUIRED_CHECK,
  request,
} from "./repo-audit.mjs";
```

`indentOf` already lives in `tools/repo-audit.mjs` (line 41); make it `export const indentOf` there instead of copying it.

Directly after `const lf = (text) => text.replaceAll("\r\n", "\n");`, add:

```js
// The template's codeql job, with the comment lines directly above it.
function codeqlBlock(template) {
  const lines = lf(template).split("\n");
  const at = lines.findIndex((line) => /^ {2}codeql:\s*$/.test(line));
  let first = at;
  while (first > 0 && /^ {2}#/.test(lines[first - 1])) first--;
  let last = at;
  while (last + 1 < lines.length && lines[last + 1].trim() !== "") last++;
  return lines.slice(first, last + 1);
}

// A caller from before v1.4.0 with the template's codeql job added: before the
// automerge job and the comments above it, or at the end when there is none.
// Nothing else changes, and a CRLF file stays CRLF. null when the jobs are not
// indented two spaces like the template's, because the block would break the YAML.
export function addCodeqlJob(text, template) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = lf(text).split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  const firstJob = lines.slice(jobsAt + 1).find((line) => line.trim() && !/^\s*#/.test(line));
  if (jobsAt === -1 || !firstJob || indentOf(firstJob) !== 2) return null;
  const block = codeqlBlock(template);
  let at = lines.findIndex((line) => /^ {2}automerge:\s*$/.test(line));
  if (at === -1) {
    while (lines.length && lines.at(-1).trim() === "") lines.pop();
    lines.push("", ...block, "");
  } else {
    while (at > 0 && /^ {2}#/.test(lines[at - 1])) at--;
    lines.splice(at, 0, ...block, "");
  }
  return lines.join(eol);
}
```

Replace the comment above `planCaller` and the function itself with:

```js
// An input the caller leaves out counts as "", so a caller written before an
// input existed is kept while the files say "". A caller from before v1.4.0
// gets the codeql job as an edit, unless its inputs drift: then I settle the
// whole file by hand, and the detail names the missing job too.
function planCaller(text, inputs, template) {
  if (text == null)
    return { path: CALLER, action: "create", content: renderCaller(template, inputs) };
  const current = parseCaller(lf(text));
  if (!current) {
    const detail = "does not call malinfossum/ward/.github/workflows/ci.yml@v1";
    return { path: CALLER, action: "drift", detail };
  }
  const drift = Object.keys(DEFAULTS)
    .filter((key) => !sameInput(key, current.inputs[key], inputs[key]))
    .map(
      (key) =>
        `${key} is "${current.inputs[key] ?? DEFAULTS[key]}", the files say "${inputs[key]}"`,
    );
  if (!current.codeql) {
    if (drift.length) {
      return { path: CALLER, action: "drift", detail: `${drift.join("; ")}; no codeql job` };
    }
    const content = addCodeqlJob(text, template);
    if (content == null) {
      const detail =
        "jobs are not indented two spaces; add the codeql job from templates/ward.yml by hand";
      return { path: CALLER, action: "drift", detail };
    }
    return { path: CALLER, action: "edit", detail: "add the codeql job", content };
  }
  if (!CODEQL_PINNED.test(current.codeql)) {
    drift.push(`the codeql job uses ${current.codeql}, not a full commit SHA`);
  }
  if (drift.length) return { path: CALLER, action: "drift", detail: drift.join("; ") };
  return { path: CALLER, action: "keep" };
}
```

In the comment above `writeFiles`, change "An edit changes package.json scripts." to "An edit changes package.json scripts or adds the caller's codeql job."

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test tools/apply.test.mjs`
Expected: all pass. The existing caller tests (`a file that differs only in line endings is kept`, `an existing caller is kept ...`, `a hand-edited caller ...`) still read `keep`: `caller()` renders the template, which now carries the pinned job.

- [ ] **Step 5: Format, lint, full suite**

Run: `npx biome check --write tools/apply.mjs tools/apply.test.mjs && npm run lint && npm test`
Expected: lint clean; 232 + 4 = 236 tests, 235 pass, 1 skipped.

- [ ] **Step 6: Commit**

```bash
git add tools/apply.mjs tools/apply.test.mjs
git commit -m "apply files: add the codeql job to a caller that lacks it"
```

---

### Task 5: `apply.mjs settings` turns default setup off only when the job can take over

**Files:**
- Modify: `tools/apply.mjs` (imports, `readState`, `planSettings`, `statusLine`, `settingsCommand`, a new `codeqlView`, `USAGE`, `runApply`)
- Test: `tools/apply.test.mjs`

**Interfaces:**
- Consumes: `languagesFor(paths, ignore)` and `trackedFiles(dir)` from `tools/codeql-languages.mjs` (Task 1); `parseCaller(text).codeql` (Task 3); `fetchRepoData(...).tree` and `.caller` (existing); `CODEQL_BLOCK` in `apply.test.mjs` (Task 4).
- Produces: `readState(repo, token)` also returns `tree: string[]` and `caller: string | null` (the default branch's). `planSettings(baseline, { job = false, languages = [], isPrivate = false } = {}) → { stops: string[], actions, notes: string[] }`. The status line says `default-setup=` where it said `codeql=`. `settings <owner/repo> [--dir <checkout>]`.

- [ ] **Step 1: Update the existing tests**

In `tools/apply.test.mjs`:

1. After `const ENV = { GITHUB_TOKEN: "t" };`, add:

```js
const b64 = (text) => Buffer.from(text).toString("base64");
```

2. In `settings: plans the four changes a bare repo needs and makes them only with --apply`: rename it to `settings: plans the three changes a bare repo needs and makes them only with --apply`; remove `"CodeQL default setup on",` from the expected `set` list; remove `["PATCH", "/repos/malinfossum/x/code-scanning/default-setup"],` from the expected writes; delete the line `assert.deepEqual(patches[1], { state: "configured", query_suite: "default" });`; change the `done` count from `4` to `3`. (The bare repo's default setup reads `not-configured`, which is now nothing to do.)

3. In `settings: everything on is kept; ...`, change the route `[/\/code-scanning\/default-setup$/, 200, { state: "configured", languages: ["javascript"] }],` to:

```js
      [
        /\/code-scanning\/default-setup$/,
        200,
        { state: "not-configured", languages: ["javascript"] },
      ],
```

4. In `settings: a refused write (403) is an error, not done, and stops the rest`, remove the line `"set     CodeQL default setup on",` from the expected lines.

5. Delete the test `settings: a repo with no CodeQL language gets a note instead of a CodeQL action`.

6. In `status prints one line with the state, ...`, change `codeql=not-configured` in the expected string to `default-setup=not-configured`.

7. In `docs/apply.md documents every command and every output word`, nothing changes in this task (Task 6 extends it).

- [ ] **Step 2: Write the failing tests**

Append after the test `settings and status without a token or with a bad repo name are a stop`:

```js
// Everything but CodeQL already on, so the CodeQL line is the only decision left.
const SET_ON = {
  ...META,
  security_and_analysis: { secret_scanning: ON, secret_scanning_push_protection: ON },
};
const settled = (overrides) =>
  bareRoutes([
    ...overrides,
    [/^\/repos\/malinfossum\/x$/, 200, SET_ON, "GET"],
    [/\/automated-security-fixes$/, 200, { enabled: true, paused: false }, "GET"],
    [/\/vulnerability-alerts$/, 204, undefined, "GET"],
  ]);
const defaultSetupOn = (languages) => [
  /\/code-scanning\/default-setup$/,
  200,
  { state: "configured", languages },
  "GET",
];
const treeOf = (paths) => [
  /\/git\/trees\/main/,
  200,
  { truncated: false, tree: paths.map((path) => ({ type: "blob", path })) },
  "GET",
];
const onBranch = (text) => [
  /\/contents\/\.github\/workflows\/ward\.yml$/,
  200,
  { content: b64(text) },
  "GET",
];
const WITH_JOB = caller({ node: "." });
const WITHOUT_JOB = WITH_JOB.replace(CODEQL_BLOCK, "");

// A checkout of a repo with its files staged, as files --apply leaves it.
function checkout(files, origin) {
  const dir = repo(files);
  const git = (...args) => spawnSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  if (origin) git("remote", "add", "origin", origin);
  git("add", ".");
  return dir;
}

test("settings: default setup goes off when the default branch's caller has the codeql job", async () => {
  const stub = stubFetch(
    settled([
      defaultSetupOn(["actions", "javascript", "typescript"]),
      treeOf([CALLER, "src/app.ts"]),
      onBranch(WITH_JOB),
    ]),
  );
  try {
    const dry = await runApply(["settings", "malinfossum/x"], ENV);
    assert.equal(dry.exitCode, 0);
    assert.deepEqual(
      dry.lines.filter((l) => /^(set|stop)/.test(l)),
      ["set     CodeQL default setup off"],
    );
    assert.ok(
      dry.lines.includes(
        "note    GitHub turns default setup off in the background: push only once status reads default-setup=not-configured.",
      ),
    );
    assert.deepEqual(stub.writes(), []);
    const wet = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(wet.exitCode, 0);
    assert.deepEqual(stub.writes(), [
      ["PATCH", "/repos/malinfossum/x/code-scanning/default-setup"],
    ]);
    assert.deepEqual(stub.calls.at(-1).body, { state: "not-configured" });
    assert.ok(wet.lines.includes("done    CodeQL default setup off"));
  } finally {
    stub.restore();
  }
});

test("settings: default setup stays on, with a note, while no caller has the codeql job", async () => {
  const stub = stubFetch(
    settled([defaultSetupOn(["actions"]), treeOf([CALLER]), onBranch(WITHOUT_JOB)]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(out.exitCode, 0);
    assert.ok(
      out.lines.includes(
        "note    CodeQL default setup stays on until the caller has the codeql job; run files --apply, then settings --dir <checkout>.",
      ),
    );
    assert.ok(!out.lines.some((l) => l.startsWith("set")));
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
});

test("settings: --dir shows the job from a checkout of the same repo before it is merged", async () => {
  const dir = checkout(
    { [CALLER]: WITH_JOB, "src/app.ts": "" },
    "https://github.com/MalinFossum/X.git",
  );
  const stub = stubFetch(
    settled([defaultSetupOn(["actions", "typescript"]), treeOf([CALLER]), onBranch(WITHOUT_JOB)]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/x", "--dir", dir, "--apply"], ENV);
    assert.equal(out.exitCode, 0);
    assert.ok(out.lines.includes("set     CodeQL default setup off"));
    assert.deepEqual(stub.writes(), [
      ["PATCH", "/repos/malinfossum/x/code-scanning/default-setup"],
    ]);
  } finally {
    stub.restore();
  }
});

test("settings: a --dir that is not a checkout of the repo is a stop, and nothing is written", async () => {
  const other = checkout({ [CALLER]: WITH_JOB }, "git@github.com:malinfossum/ward.git");
  const none = checkout({ [CALLER]: WITH_JOB }, "");
  const stub = stubFetch(
    settled([defaultSetupOn(["actions"]), treeOf([CALLER]), onBranch(WITHOUT_JOB)]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/x", "--dir", other, "--apply"], ENV);
    assert.equal(out.exitCode, 1);
    assert.deepEqual(out.lines, [
      `stop    ${other} is a checkout of malinfossum/ward, not malinfossum/x.`,
    ]);
    const bare = await runApply(["settings", "malinfossum/x", "--dir", none, "--apply"], ENV);
    assert.equal(bare.exitCode, 1);
    assert.match(
      bare.lines[0],
      /^stop {4}.* is a checkout of no GitHub repo, not malinfossum\/x\.$/,
    );
    const missing = await runApply(["settings", "malinfossum/x", "--dir"], ENV);
    assert.equal(missing.exitCode, 1);
    assert.deepEqual(missing.lines, ["stop    --dir is not a directory I can read."]);
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
});

test("settings: a language default setup scans and the codeql job would not is a stop", async () => {
  const stub = stubFetch(
    settled([
      defaultSetupOn(["actions", "c-cpp"]),
      treeOf([CALLER, "include/lib.h", "vendor/x.min.js"]),
      onBranch(WITH_JOB),
    ]),
  );
  try {
    const out = await runApply(["settings", "malinfossum/x", "--apply"], ENV);
    assert.equal(out.exitCode, 1);
    assert.ok(
      out.lines.includes(
        "stop    CodeQL default setup scans c-cpp, which the codeql job would not; add it to tools/codeql-languages.mjs first.",
      ),
    );
    assert.deepEqual(stub.writes(), []);
  } finally {
    stub.restore();
  }
});

const SETTLED = {
  alerts: true,
  securityUpdates: { enabled: true, paused: false },
  analysis: { secret_scanning: ON, secret_scanning_push_protection: ON },
};

test("planSettings: javascript and typescript fold into one; a language outside the table stops", () => {
  const on = (languages) => ({ ...SETTLED, codeScanning: { state: "configured", languages } });
  const folded = planSettings(on(["javascript", "typescript", "actions"]), {
    job: true,
    languages: ["actions", "javascript-typescript"],
  });
  assert.deepEqual(folded.stops, []);
  assert.deepEqual(folded.actions, [
    {
      what: "CodeQL default setup off",
      method: "PATCH",
      path: "/code-scanning/default-setup",
      body: { state: "not-configured" },
    },
  ]);
  const go = planSettings(on(["actions", "go"]), { job: true, languages: ["actions"] });
  assert.deepEqual(go.actions, []);
  assert.deepEqual(go.stops, [
    "CodeQL default setup scans go, which the codeql job would not; add it to tools/codeql-languages.mjs first.",
  ]);
  const off = { ...SETTLED, codeScanning: { state: "not-configured", languages: [] } };
  assert.deepEqual(planSettings(off, { job: false, languages: ["actions"] }), {
    stops: [],
    actions: [],
    notes: [],
  });
});

test("planSettings: default setup that does not list its languages is a stop, never a blind off", () => {
  const plan = planSettings(
    { ...SETTLED, codeScanning: { state: "configured" } },
    { job: true, languages: ["actions"] },
  );
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.stops, [
    "CodeQL default setup does not say which languages it scans, so I cannot check the codeql job covers them.",
  ]);
});

test("planSettings: a private repo gets a note to leave the codeql job out", () => {
  const plan = planSettings(
    { ...SETTLED, codeScanning: { state: "not-configured", languages: [] } },
    { isPrivate: true },
  );
  assert.deepEqual(plan.notes, [
    "This repo is private: CodeQL here needs GitHub Advanced Security, so leave the codeql job out of its caller.",
  ]);
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test tools/apply.test.mjs`
Expected: FAIL. The bare-repo test still sees `set     CodeQL default setup on`, the status test still sees `codeql=`, and the new tests get no `set     CodeQL default setup off` line, no `--dir` stop and no coverage stop.

- [ ] **Step 4: Write the implementation**

In `tools/apply.mjs`, add the import (after the `./automerge.mjs` import):

```js
import { languagesFor, trackedFiles } from "./codeql-languages.mjs";
```

Replace the file's opening comment (the six lines above the first `import`) with:

```js
// Applies the Ward standard to one repo: the files it carries (the caller,
// the Dependabot config, Directory.Build.props, the npm scripts the node
// contract needs) and the settings GitHub holds for it (Dependabot, secret
// scanning, CodeQL default setup off once the caller's codeql job takes over,
// the ruleset on the default branch, auto-merge). Every command prints what
// it would do and changes nothing until --apply. The ward skill in loadout
// drives it; by hand: node tools/apply.mjs <command>.
```

In `readState`, add two fields to the returned object, after `baseline: data.baseline,`:

```js
    // The default branch's files and caller: where settings looks for the codeql
    // job and the languages it will scan when no --dir is given.
    tree: data.tree,
    caller: data.caller,
```

Replace `planSettings` (its comment and body) with:

```js
// Default setup names JavaScript and TypeScript apart; the workflow scans them as one.
const FOLD = { javascript: "javascript-typescript", typescript: "javascript-typescript" };

// The settings a repo still needs, from the baseline the audit reads. A
// field the token could not read is a stop, never a blind write: the write
// would fail for the same reason, and a silent retry would hide it. job: a
// caller with the codeql job is visible; languages: what that job will scan.
// Default setup goes off only when both hold and nothing it scans is lost, so
// a repo is never left unscanned by accident.
export function planSettings(baseline, { job = false, languages = [], isPrivate = false } = {}) {
  const { alerts, securityUpdates, analysis, codeScanning } = baseline;
  if ([alerts, securityUpdates, analysis, codeScanning].some((value) => value == null)) {
    const stop = "The token cannot read this repo's settings; it needs admin on the repo.";
    return { stops: [stop], actions: [], notes: [] };
  }
  const stops = [];
  const actions = [];
  const notes = [];
  if (!alerts)
    actions.push({ what: "Dependabot alerts on", method: "PUT", path: "/vulnerability-alerts" });
  if (!securityUpdates.enabled || securityUpdates.paused) {
    actions.push({
      what: "Dependabot security updates on",
      method: "PUT",
      path: "/automated-security-fixes",
    });
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
  if (codeScanning.state === "configured") {
    if (!job) {
      notes.push(
        "CodeQL default setup stays on until the caller has the codeql job; run files --apply, then settings --dir <checkout>.",
      );
    } else if (!Array.isArray(codeScanning.languages)) {
      stops.push(
        "CodeQL default setup does not say which languages it scans, so I cannot check the codeql job covers them.",
      );
    } else {
      const scanned = [...new Set(codeScanning.languages.map((name) => FOLD[name] ?? name))];
      const lost = scanned.filter((name) => !languages.includes(name));
      if (lost.length) {
        stops.push(
          `CodeQL default setup scans ${lost.join(", ")}, which the codeql job would not; add it to tools/codeql-languages.mjs first.`,
        );
      } else {
        actions.push({
          what: "CodeQL default setup off",
          method: "PATCH",
          path: "/code-scanning/default-setup",
          body: { state: "not-configured" },
        });
        // The PATCH answers 202 and finishes later; an upload before then is refused.
        notes.push(
          "GitHub turns default setup off in the background: push only once status reads default-setup=not-configured.",
        );
      }
    }
  }
  if (isPrivate) {
    notes.push(
      "This repo is private: CodeQL here needs GitHub Advanced Security, so leave the codeql job out of its caller.",
    );
  }
  return { stops, actions, notes };
}
```

In `statusLine`, change the line `` `codeql=${state.baseline.codeScanning?.state ?? "unread"}`, `` to:

```js
    `default-setup=${state.baseline.codeScanning?.state ?? "unread"}`,
```

Replace `settingsCommand` with the two functions below:

```js
const hasCodeqlJob = (text) => Boolean(text != null && parseCaller(lf(text))?.codeql);

// Where settings can see the codeql job, and the tree that job will scan: the
// default branch, or a --dir checkout of this same repo, whose caller may have
// the job before it is merged. --dir has no default: run from a Ward clone, `.`
// would read Ward's own caller and pass for any repo.
function codeqlView(state, argv) {
  const onBranch = hasCodeqlJob(state.caller);
  if (!argv.includes("--dir")) return { job: onBranch, paths: state.tree };
  const dir = arg(argv, "--dir");
  if (!dir || !existsSync(dir)) {
    return { stop: `${dir || "--dir"} is not a directory I can read.` };
  }
  const origin = repoName([], dir);
  if (origin.toLowerCase() !== state.repo.toLowerCase()) {
    return { stop: `${dir} is a checkout of ${origin || "no GitHub repo"}, not ${state.repo}.` };
  }
  const local = join(dir, CALLER);
  const text = existsSync(local) ? readFileSync(local, "utf8") : null;
  return { job: onBranch || hasCodeqlJob(text), paths: trackedFiles(dir) ?? [] };
}

async function settingsCommand(state, argv, token, stacks) {
  const view = codeqlView(state, argv);
  if (view.stop) return { lines: [say("stop", view.stop)], exitCode: 1 };
  const { stops, actions, notes } = planSettings(state.baseline, {
    job: view.job,
    languages: languagesFor(view.paths, stacks.ignore),
    isPrivate: state.meta.private === true,
  });
  const lines = stops.map((stop) => say("stop", stop));
  for (const action of actions) lines.push(say("set", action.what));
  for (const note of notes) lines.push(say("note", note));
  if (stops.length) return { lines, exitCode: 1 };
  if (!actions.length && !notes.length) lines.push(say("keep", "every setting is already on"));
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
```

Replace `USAGE` with:

```js
export const USAGE = [
  "node tools/apply.mjs files [--dir <repo>] [--repo <owner/name>] [--apply]",
  "node tools/apply.mjs settings <owner/repo> [--dir <checkout>] [--apply]",
  "node tools/apply.mjs ruleset|automerge|status <owner/repo> [--apply] [--bypass-admin] [--no-codeql]",
  "Settings commands read GITHUB_TOKEN (locally: GITHUB_TOKEN=$(gh auth token)).",
].join("\n");
```

In `runApply`, change `if (command === "settings") return await settingsCommand(state, rest, token);` to:

```js
    if (command === "settings") return await settingsCommand(state, rest, token, stacks);
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --test tools/apply.test.mjs`
Expected: all pass.

- [ ] **Step 6: Format, lint, full suite**

Run: `npx biome check --write tools/apply.mjs tools/apply.test.mjs && npm run lint && npm test`
Expected: lint clean; 236 - 1 + 8 = 243 tests, 242 pass, 1 skipped.

- [ ] **Step 7: Dry run against Ward itself (read-only)**

Run: `GITHUB_TOKEN=$(gh auth token) node tools/apply.mjs settings malinfossum/ward --dir .`
Expected: `set     CodeQL default setup off`, the background note, exit 0, no `stop`. Without `--apply` nothing is written. Then run it once with `--dir ../hugin` (or any other clone): expected `stop    ../hugin is a checkout of malinfossum/hugin, not malinfossum/ward.`

- [ ] **Step 8: Commit**

```bash
git add tools/apply.mjs tools/apply.test.mjs
git commit -m "apply settings: turn default setup off once the codeql job covers it"
```

---

### Task 6: Docs and version 1.4.0

**Files:**
- Modify: `docs/apply.md`, `docs/repo-audit.md`, `README.md`, `package.json`, `package-lock.json`
- Test: `tools/apply.test.mjs` (the docs test)

**Interfaces:**
- Consumes: the behaviour of Tasks 1 to 5, the output words and the `settings` form from Task 5.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the failing docs assertions**

In `tools/apply.test.mjs`, in `docs/apply.md documents every command and every output word`, before `assert.match(doc, /--apply/);`, add:

```js
  assert.match(doc, /^\| `settings <owner\/repo> \[--dir <checkout>\]`/m);
  assert.match(doc, /default-setup=not-configured/);
  assert.match(doc, /`codeql` job/);
```

Run: `node --test tools/apply.test.mjs`
Expected: FAIL on the first new assertion.

- [ ] **Step 2: `docs/apply.md`**

Replace the `files` row with:

```markdown
| `files [--dir <repo>] [--repo <owner/name>]` | The tree, every `.csproj`, the caller, `dependabot.yml`, `Directory.Build.props`, `package.json` | Writes the caller, the Dependabot config and `Directory.Build.props` where they are missing, adds the `codeql` job to a caller that has none (before `automerge:`, or at the end), and adds the npm scripts the module contract needs that are missing (`deploy:check` only for a wrangler setup); a script it will not guess, such as `test`, is reported as `ask` |
```

Replace the `settings` row with:

```markdown
| `settings <owner/repo> [--dir <checkout>]` | Dependabot alerts and security updates, secret scanning and push protection, CodeQL default setup and the languages it scans, the caller's `codeql` job on the default branch or in `--dir`, and the tracked files that job will scan | Turns on what is off, and turns CodeQL default setup off once a caller with the `codeql` job is visible and covers every language default setup scans |
```

Replace the paragraph that starts "The order is the only safe one." with:

```markdown
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
would lose is a `stop`. On a private repo it prints a `note` to leave the job out: CodeQL there needs
GitHub Advanced Security.
```

In the Output table, replace these rows:

```markdown
| `edit` | `package.json` would get the scripts named, or the caller the `codeql` job |
| `note` | A package a new script needs (I install it, the script never does), or a CodeQL remark: default setup stays on until a caller has the `codeql` job, wait for `status` after turning it off, leave the job out on a private repo |
| `stop` | A precondition is not met: two candidates at one depth, classic branch protection, two branch rulesets, a setting the token cannot read, auto-merge before the gate, a `--dir` that is not a checkout of the repo, a language default setup scans that the `codeql` job would not. Exit 1, nothing written |
| `set` | A setting that would be turned on, or CodeQL default setup that would be turned off |
```

In "What it never does", replace the paragraph with:

```markdown
Overwrite a file that exists (the one edit to a caller only inserts the `codeql` job), install a
package, guess a `test` runner, merge a PR, enable auto-merge before the ruleset, write the ruleset
before CodeQL's first analysis, or turn CodeQL default setup off while no caller with the `codeql`
job is visible. `--no-codeql` is for a repo with no workflows at all, together with a dated
`ruleset` exception in `stacks.json`; every warded repo has the caller and with it an `actions`
analysis, so in practice it is unused. `--bypass-admin` is for a repo a token of mine pushes to
directly (the profile README), with the reason in the PR that adds it.
```

- [ ] **Step 3: `docs/repo-audit.md`**

Replace the `baseline` and `caller` rows with:

```markdown
| `baseline` | Dependabot alerts, Dependabot security updates, secret scanning or push protection is off, or CodeQL default setup is on (GitHub then refuses the uploads of the caller's `codeql` job) |
| `caller` | No `.github/workflows/ward.yml`, or it does not call `malinfossum/ward/.github/workflows/ci.yml@v1`, or its automerge job does not pin `dependabot-automerge.yml` to a full Ward commit SHA, or it has no `codeql` job, or that job does not pin `codeql.yml` to a full Ward commit SHA (Ward itself calls `./.github/workflows/codeql.yml`) |
```

- [ ] **Step 4: `README.md`**

Replace the paragraph that starts "The baseline also covers Dependabot" (three lines, ending with the design spec link) with:

```markdown
The baseline also covers Dependabot with auto-merge for patch and minor updates (GitHub's own actions
only; third-party actions wait for review), secret scanning with push protection, CodeQL on every
pull request (forks included) through the caller's `codeql` job, and a ruleset on `main`. The full
standard is in [the design spec](docs/specs/2026-09-25-ci-standard-design.md).
```

Replace the `.github/workflows/` row of the Layout table with:

```markdown
| `.github/workflows/` | `ci.yml` (entry point), `codeql.yml`, `dependabot-automerge.yml`, `repo-hygiene.yml`, the weekly `repo-audit.yml` and `canary.yml`, Ward's own `ward.yml` |
```

- [ ] **Step 5: Version 1.4.0**

Run: `npm version 1.4.0 --no-git-tag-version`
Expected: prints `v1.4.0`; `git diff --stat` shows `package.json` and `package-lock.json` (both `version` fields in the lock).

- [ ] **Step 6: Run everything**

Run: `npm test && npm run lint`
Expected: 243 tests, 242 pass, 1 skipped (no new test, three new assertions); lint clean. Check the docs for em dashes: `grep -n "$(printf '\342\200\224')" docs/apply.md docs/repo-audit.md README.md` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add docs/apply.md docs/repo-audit.md README.md package.json package-lock.json tools/apply.test.mjs
git commit -m "Document the codeql job and bump Ward to 1.4.0"
```

---

### Task 7: The final pin

**Files:**
- Modify: `templates/ward.yml` (only when the pin moves)

**Interfaces:**
- Consumes: the template's interim pin from Task 2.
- Produces: `templates/ward.yml` pins `codeql.yml` to the last branch commit that changed `.github/workflows/codeql.yml` or `tools/codeql-languages.mjs`, with `# v1.4.0`. Any later change to either file means repeating this task before merge.

- [ ] **Step 1: Find the pin**

```bash
PIN=$(git log -1 --format=%H -- .github/workflows/codeql.yml tools/codeql-languages.mjs)
echo "$PIN"
grep -n "codeql.yml@" templates/ward.yml
```

Expected: a 40-hex SHA. If no task after Task 2 changed either file, it equals the SHA already in the template.

- [ ] **Step 2: Set it (only when it differs)**

```bash
sed -i -E "s#(codeql\.yml@)[0-9a-f]{40}#\1$PIN#" templates/ward.yml
git diff templates/ward.yml
```

Expected: either no diff (the interim pin was already final; skip Step 4's commit and say so in the task report), or one changed line whose SHA is `$PIN` and whose comment still reads `# v1.4.0`.

- [ ] **Step 3: Check the pin holds the final files**

```bash
git diff --quiet "$PIN" HEAD -- .github/workflows/codeql.yml tools/codeql-languages.mjs && echo "pin matches HEAD"
git merge-base --is-ancestor "$PIN" HEAD && echo "pin is on this branch"
npm test && npm run lint
```

Expected: both echo lines print; 243 tests, 242 pass, 1 skipped; lint clean.

- [ ] **Step 4: Commit (only when Step 2 changed the file) and push**

```bash
git add templates/ward.yml
git commit -m "Pin the template's codeql job to the final codeql.yml"
git push -u origin feat/codeql-advanced
gh api "repos/malinfossum/ward/commits/$PIN" -q .sha
```

Expected: the push succeeds (a branch push starts no workflow: `ward.yml` runs on `pull_request` and on pushes to `main`), and the last command prints `$PIN`, so the pinned commit exists on GitHub.

---

### Task 8: Live verification and the PR

**Files:** none in the tree; a repo setting on `malinfossum/ward` and the PR.

**Interfaces:**
- Consumes: every commit above, pushed by Task 7.
- Produces: an open PR whose `codeql / analyze (...)` runs uploaded, with `ward / gate` green. No merge, no tag.

The owner has approved this one repo-settings change: CodeQL default setup off on `malinfossum/ward`, made with the command in Step 2. Nothing else in this task changes a setting.

- [ ] **Step 1: Preconditions**

```bash
git status --short
git log --oneline origin/feat/codeql-advanced -1
gh pr list --repo malinfossum/ward --state open --json number,title
```

Expected: a clean tree, the branch tip pushed, and the open PR list. Any PR listed there (Dependabot's included) will have no CodeQL results on its head once default setup is off; note its number for Step 6.

- [ ] **Step 2: Turn default setup off on Ward**

```bash
GITHUB_TOKEN=$(gh auth token) node tools/apply.mjs settings malinfossum/ward --dir .
GITHUB_TOKEN=$(gh auth token) node tools/apply.mjs settings malinfossum/ward --dir . --apply
```

Expected: the dry run prints `set     CodeQL default setup off` and the background note, no `stop`; the second run ends with `done    CodeQL default setup off`, exit 0.

- [ ] **Step 3: Wait for it to take**

```bash
for i in $(seq 1 20); do
  line=$(GITHUB_TOKEN=$(gh auth token) node tools/apply.mjs status malinfossum/ward)
  echo "$line"
  case "$line" in *default-setup=not-configured*) break ;; esac
  sleep 30
done
```

Expected: within a few minutes a line with `default-setup=not-configured`. Do not open the PR before it.

- [ ] **Step 4: Open the PR**

```bash
gh pr create --base main --head feat/codeql-advanced --title "CodeQL as a workflow, so fork pull requests get scanned" --body-file - <<'BODY'
Spec: `docs/specs/2026-10-14-codeql-advanced-design.md`. Plan: `docs/plans/2026-10-14-ward-codeql-advanced.md`.

Default setup never analyses a pull request from a fork, so the `code_scanning` rule blocked a contributor's PR to Hugin until I turned the rule off by hand. This moves CodeQL into a reusable workflow that runs on `pull_request`, forks included, and keeps the rule.

- `.github/workflows/codeql.yml`: a `languages` job maps the tracked files to CodeQL languages (`tools/codeql-languages.mjs`), then `analyze` runs one leg per language with `build-mode: none`. No build step and no `run:` in the job that holds `security-events: write`.
- The caller template gets a `codeql` job pinned to a full commit SHA (`# v1.4.0`). Ward's own `ward.yml` calls `./.github/workflows/codeql.yml`, so this PR tests its own workflow.
- `apply.mjs files` adds the job to a caller that lacks it. `settings` turns default setup off only once the job is visible and covers every language default setup scans; otherwise it stops, or leaves default setup on with a note. `status` now says `default-setup=`.
- The audit flips: default setup on is a finding, and so is a caller without a pinned `codeql` job.
- Docs and version 1.4.0.

Default setup is already off on this repo, so the CodeQL checks below come from the new workflow. This needs a merge commit, not a squash: the template pins a commit on this branch. No tag or release in this PR.
BODY
```

Expected: the PR URL. Record the number as `N`.

- [ ] **Step 5: Watch the checks and the uploads**

```bash
gh pr checks N --watch --interval 30
gh api "repos/malinfossum/ward/code-scanning/analyses?ref=refs/pull/N/merge&per_page=20" -q '.[] | .category + " " + .tool.name + " " + .created_at'
gh pr view N --json mergeStateStatus -q .mergeStateStatus
```

Expected: `codeql / languages`, `codeql / analyze (actions)`, `codeql / analyze (csharp)` and `codeql / analyze (javascript-typescript)` pass, and `ward / gate`, `ward-windows / gate`, `ward-ef / gate`, `fixtures` and `hygiene` pass; the identity job's drift step warns about the workflow files, which is expected. The analyses list shows `/language:actions`, `/language:csharp` and `/language:javascript-typescript` from `CodeQL`. `mergeStateStatus` is `CLEAN`: the `code_scanning` rule is satisfied by the new uploads. If an analyze leg fails, stop: fix it on this branch, repeat Task 7 (the pin moves), push, and watch again. If it cannot go green the same day, stop and report instead: Ward's `main` has no CodeQL while default setup is off and this PR is open. Turning default setup back on is the owner's call, not part of this task (the command would be `gh api -X PATCH repos/malinfossum/ward/code-scanning/default-setup -f state=configured -f query_suite=default`).

- [ ] **Step 5b: Record what the C# leg ran**

```bash
RUN=$(gh run list --repo malinfossum/ward --branch feat/codeql-advanced --workflow Ward --limit 1 --json databaseId -q '.[0].databaseId')
gh run view "$RUN" --repo malinfossum/ward --log | grep -i "codeql / analyze (csharp)" | grep -i -c "dotnet restore"
```

Expected: a count. CodeQL's buildless C# extractor runs `dotnet restore` on the solutions and projects it finds (its `NugetPackageRestorer.cs` says so), and a restore evaluates MSBuild files from the checkout. Report the count in the task report: it confirms the spec's Decision 6 as corrected on 2026-10-14. Change nothing in this task because of it.

- [ ] **Step 6: Record older open PRs**

List the PR numbers from Step 1 in the task report under "older PRs to unblock after merge". Nothing is rebased or merged in this task: a rebase before `main` has the `codeql` job gains nothing, and merging `main` into a branch is a merge. The Release section does it after the owner merges. If Step 1 listed none, record "no older PRs".

---

## Release (owner's go)

Not a task. These steps run only when I say so, after I have merged the PR **with a merge commit** in the GitHub UI.

```bash
git switch main && git pull --ff-only
PIN=$(sed -nE 's#.*codeql\.yml@([0-9a-f]{40}).*#\1#p' templates/ward.yml)
git merge-base --is-ancestor "$PIN" HEAD && echo "pin is on main"
git diff --quiet "$PIN" HEAD -- .github/workflows/codeql.yml tools/codeql-languages.mjs && echo "pin matches main"
```

Both lines must print; if either does not, stop: the template needs a new pin in a follow-up PR first. Then:

```bash
git tag -a v1.4.0 -m "Ward 1.4.0: CodeQL as a workflow" \
  && git merge-base --is-ancestor "$PIN" v1.4.0 && echo "pin is in v1.4.0" \
  && git diff --quiet "$PIN" v1.4.0 -- .github/workflows/codeql.yml tools/codeql-languages.mjs && echo "pin matches v1.4.0" \
  && git tag -fa v1 -m "Ward v1: currently v1.4.0" v1.4.0^{commit} \
  && git push origin v1.4.0 \
  && git push --force origin v1 \
  && gh release create v1.4.0 --verify-tag --title "v1.4.0" --latest --notes "CodeQL runs as a workflow: the caller's new codeql job calls .github/workflows/codeql.yml at a pinned commit, on every pull request, forks included, with build-mode none for every language. apply.mjs files adds the job to an older caller; settings turns CodeQL default setup off once the job covers every language it scanned. The audit now fails a repo with default setup on or without a pinned codeql job. Migrate one repo at a time: files --apply, settings --dir . --apply, wait for status to read default-setup=not-configured, then open the PR."
gh api repos/malinfossum/ward/git/ref/tags/v1 --jq '.object.sha' | xargs -I{} gh api repos/malinfossum/ward/git/tags/{} --jq '.object.sha'
git rev-parse v1.4.0^{commit}
```

Expected: the last two commands print the same commit SHA. Then watch the release-triggered canary: `sleep 300 && gh run list --repo malinfossum/ward --workflow canary.yml --limit 1 --json conclusion,event` reads `event: release`, `conclusion: success`. Once `main` has the workflow, the live audit test passes again: `GITHUB_TOKEN=$(gh auth token) npm test`.

Then unblock the older open PRs that Task 8 Step 6 recorded: a Dependabot PR gets the comment `@dependabot rebase` (`gh pr comment <number> --body "@dependabot rebase"`); a branch of mine gets `main` merged in. Their new runs carry CodeQL results from the workflow now that `main` has it.

## Follow-ups (outside this PR)

- The migration, one repo at a time, Hugin first, as the spec's "Migration" section lists it; the weekly audit fails every unmigrated repo until then.
- Portfolio drops its `ruleset` exception in `stacks.json` and gets the code-scanning rule.
- Workbench's six scaffold callers are regenerated with `renderCaller`; the loadout `ward` skill moves `settings` before the PR.
- A Dependabot bump of `github/codeql-action` changes `codeql.yml` on `main`; the template pin moves with the next release, never in between.
- devops-course is the first repo with C or C++ to migrate. Its PR is the proof that `c-cpp` runs green with `build-mode: none`; Ward's own PR only covers `actions`, `csharp` and `javascript-typescript`.

## Self-review (2026-10-14)

Spec coverage, section by section: the workflow and its two jobs (Task 2), `codeql-languages.mjs` with the table, ignore prefixes, `.min.js`, header-only, HTML-only and newline rules (Task 1), the caller block and Ward's `./` call (Task 2), the first pin and the repin rule (Tasks 2 and 7, Release), `apply.mjs files` (Task 4), `settings` with the coverage guard, private note, `--dir` origin stop and the 202 wait (Task 5, Task 8), `status` word (Task 5), the audit (Task 3), docs and version (Task 6), every row of the spec's Testing list (Tasks 1 to 5), the live check (Task 8). `ruleset` is unchanged, as the spec says. Placeholder scan: the only value not written out is the interim pin in Task 2 Step 7, which is the output of `git rev-parse HEAD` at that step, and Task 7 recomputes it. Names checked across tasks: `languagesFor`, `trackedFiles`, `LANGUAGES`, `CODEQL_PINNED`, `SELF_CODEQL`, `parseCaller().codeql`, `addCodeqlJob`, `planSettings(baseline, { job, languages, isPrivate })`, `CODEQL_BLOCK`, `AUTOMERGE_BLOCK`.

Where the code made me adjust the spec's suggested shape:

- The spec gives `analyze` 60 minutes; `workflows.test.mjs` allowed only 10 or 30. Task 2 keeps the rule and names `codeql.yml`'s `analyze` as its one exception.
- `every reusable workflow fetches Ward's tools at its own commit` counted 3 reusable workflows; it counts 4 now.
- Task 4 needs the template's block before the final pin exists, so Task 2 pins the template to its own workflow commit and Task 7 confirms or moves it.
- The coverage guard over `--dir` reads `git ls-files` (tracked files only, as the workflow will), not `listTree`, which also counts untracked files.
- The spec's `languages` job has `contents: read`; it inherits that from the top-level `permissions`, so it gets no job-level block.
- `settings` is a `stop` when default setup answers `configured` without a `languages` list: the spec is silent, and a blind "off" there could drop a language.
- `languagesFor` takes `(paths, ignore)`, not the spec's `(paths)`: the function stays pure, and the `stacks.json` prefixes are an input the tests can vary.
- `settings` prints the `keep` line only when there is no action and no note: next to a "default setup stays on" note it would read as a contradiction of the audit, which calls that state a finding.

## Stress test (2026-10-14)

Five passes over this plan (security, privacy, accessibility, legal, loopholes), with the CI / GitHub Actions add-on.

**Findings and what happened to them**

- 🟠 **Security: buildless C# still runs `dotnet restore` on the checkout.** CodeQL's C# extractor (`csharp/extractor/Semmle.Extraction.CSharp.DependencyFetching/NugetPackageRestorer.cs`) restores the solutions and projects it finds, and a restore evaluates MSBuild files, so a target hooked into restore would run in `analyze`, next to `security-events: write`. That contradicts the spec's Decision 6 wording ("no ... MSBuild target ... runs next to `security-events: write`"). The real guards still hold: a fork's `pull_request` run gets a read-only token whatever the job asks for, and it waits for my "Approve and run"; for my own and Dependabot's PRs the code is mine or a reviewed bump, and the worst a hostile restore could do with `security-events: write` is upload or dismiss code-scanning results, never touch the code. **Resolved in `bac04bc`:** the spec's Decision 6 now names the read-only fork token and the approval as the guard. Proof: Task 8 Step 5b records whether the C# leg ran `dotnet restore`.
- 🟡 **Loophole: default setup off while the PR cannot go green.** Applied: Task 8 Step 5 now stops and reports the same day instead of leaving `main` unscanned, and names the one command that would turn default setup back on, as the owner's call. Proof: manual, the executor in Task 8.
- 🟡 **Loophole: `c-cpp` with `build-mode: none` is never exercised on Ward.** Applied: a follow-up names devops-course's migration PR as the proof. Proof: that PR's `codeql / analyze (c-cpp)` check.
- 🟡 **Privacy: CodeQL Action status reports.** The action sends status reports to GitHub's own API (the same party that hosts the code and receives the SARIF). Its only switch, `CODEQL_ACTION_TEST_MODE` (`src/environment.ts` at v4.38.3), also turns off the SARIF upload, which is the whole point of the job, so it stays on. The telemetry variables the other workflows set are set here too. Proof: the existing telemetry test covers `codeql.yml`.
- ✅ **Accessibility:** no UI; the output words and their padding are unchanged, and the docs stay plain tables and short paragraphs.
- ✅ **Legal:** CodeQL is free on public repositories on GitHub.com, which is every warded repo; the private-repo `note` covers the one case that would need GitHub Advanced Security.
- ✅ **CI add-on:** every action pinned by SHA with a version comment, top-level `contents: read`, no `pull_request_target`, no event text in a `run:` line, no secret read, and the language list reaches the matrix only as table names (Task 1 tests). Each new guard has a case that goes red first (each task's Step 2).

**Considered and rejected**

- **A test that the template pin holds the branch's `codeql.yml`.** CI checks out one commit (`fetch-depth` 1), so the pinned commit is not there to compare, and on `main` the test would go red on every Dependabot bump of `codeql-action` until the next release. Task 7 and the release checks do this by hand instead.
- **A canary for the pinned `codeql.yml`.** Ward's own weekly run calls `./.github/workflows/codeql.yml` on `main`, which is the pinned file until the next change, and the release check proves the two are equal at the tag. The migrated repos exercise the pin itself.
- **A tracked symlink or a file CodeQL cannot extract that still matches an extension** (a `.py` symlink to nowhere). It would start a leg with nothing to extract, which fails red and blocks merges. No warded repo has one; a path list to exclude them would drift.
- **Counting an unpinned `codeql` job as visible in `settings`.** An unpinned job still runs and uploads, so default setup can go off; the audit and `files` both flag the missing pin.

> Stress-tested 2026-10-14 (skill 1b85fca): 3 applied, 0 adapted, 0 decided by me (1 open question for the owner).
