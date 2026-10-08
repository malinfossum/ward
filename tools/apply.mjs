// Applies the Ward standard to one repo: the files it carries (the caller,
// the Dependabot config, Directory.Build.props, the npm scripts the node
// contract needs) and the settings GitHub holds for it (Dependabot, secret
// scanning, CodeQL, the ruleset on the default branch, auto-merge). Every
// command prints what it would do and changes nothing until --apply. The
// ward skill in loadout drives it; by hand: node tools/apply.mjs <command>.
import { detectStacks, ignored } from "./stacks.mjs";

const depth = (path) => path.split("/").length;
export const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
const asDirectory = (dir) => (dir === "." ? "/" : `/${dir}`);

// Any EF Core package except Design and Tools, which only the tooling needs.
const EF_PACKAGE = /Microsoft\.EntityFrameworkCore(?:\.(?!(?:Design|Tools)\b)[\w.]+)?(?![\w.])/;
const EF_DESIGN = /Microsoft\.EntityFrameworkCore\.Design(?![\w.])/;

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

  // The project with the DbContext packages is the EF project; the one with
  // Design is the startup project when it is a different project. A repo with
  // only a Design reference has one project doing both jobs.
  const withEf = projects.filter((path) => EF_PACKAGE.test(text(path)));
  const withDesign = projects.filter((path) => EF_DESIGN.test(text(path)));
  const efPick = pickOne(withEf, "project referencing Microsoft.EntityFrameworkCore", stops);
  const designPick = pickOne(
    withDesign,
    "project referencing Microsoft.EntityFrameworkCore.Design",
    stops,
  );
  const ef = withEf.length ? efPick : designPick;
  const startup = ef && designPick && designPick !== ef ? designPick : "";

  const inputs = {
    node: manifest ? dirOf(manifest) : "",
    dotnet,
    "dotnet-os": wpf ? "windows-latest" : "ubuntu-latest",
    "dotnet-ef-project": ef ? dirOf(ef) : "",
    "dotnet-ef-startup-project": startup ? dirOf(startup) : "",
  };
  const ecosystems = [{ ecosystem: "github-actions", directory: "/" }];
  for (const path of manifests) {
    ecosystems.push({ ecosystem: "npm", directory: asDirectory(dirOf(path)) });
  }
  // Dependabot looks only in the directory a block names, so the nuget block
  // sits beside the solution and a nested global.json, Dockerfile or
  // pyproject.toml gets a block of its own (varde keeps global.json under api/).
  const dirs = (files) => [...new Set(files.map((path) => dirOf(path)))];
  if (dotnet) ecosystems.push({ ecosystem: "nuget", directory: asDirectory(dirOf(dotnet)) });
  for (const dir of dirs(kept.filter((path) => /(^|\/)global\.json$/.test(path)))) {
    ecosystems.push({ ecosystem: "dotnet-sdk", directory: asDirectory(dir) });
  }
  for (const [stack, ecosystem] of [
    ["docker", "docker"],
    ["python", "pip"],
  ]) {
    for (const dir of dirs(filesOf(stack))) {
      ecosystems.push({ ecosystem, directory: asDirectory(dir) });
    }
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
