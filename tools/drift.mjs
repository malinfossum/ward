// Warns when a pull request changes a file that decides what Ward checks. A PR
// can turn its own checks off; this makes that visible without blocking
// Dependabot's action bumps, which touch workflows too.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const GUARDED = [
  /^\.github\/workflows\//,
  /(^|\/)Directory\.Build\.props$/,
  /(^|\/)biome\.jsonc?$/,
  /(^|\/)global\.json$/,
];

export function guardedChanges(files) {
  return files.filter((file) => GUARDED.some((pattern) => pattern.test(file)));
}

// Only the scripts block decides what the node module runs; a dependency bump
// in package.json is not a change to the checks.
export function scriptsChanged(before, after) {
  const scripts = (text) => {
    try {
      return JSON.stringify(JSON.parse(text).scripts ?? {});
    } catch {
      return null;
    }
  };
  return scripts(before) !== scripts(after);
}

function main() {
  const { BASE, HEAD } = process.env;
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const show = (ref, file) => {
    try {
      return git("show", `${ref}:${file}`);
    } catch {
      return "";
    }
  };
  const files = git("diff", "--name-only", `${BASE}...${HEAD}`).split("\n").filter(Boolean);
  const scriptEdits = files.filter(
    (file) =>
      /(^|\/)package\.json$/.test(file) && scriptsChanged(show(BASE, file), show(HEAD, file)),
  );
  const changed = [...guardedChanges(files), ...scriptEdits];
  for (const file of changed) {
    console.log(
      `::warning file=${file}::${file} decides what Ward checks. Read the change before merging.`,
    );
  }
  if (changed.length === 0) console.log("This PR changes nothing that decides what Ward checks.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
