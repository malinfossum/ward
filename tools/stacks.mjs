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
