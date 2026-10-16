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
