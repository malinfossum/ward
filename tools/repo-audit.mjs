// The weekly audit over every repo I own: the baseline settings are on, the
// caller is present on @v1 with the inputs the repo's stacks need, every NuGet
// audit suppression carries a dated reason, no runtime is near end of life,
// and Ward's canary is alive. Each check is a pure function over fetched data
// that returns [kind, message] findings; main() only fetches and reports.
import { requiredChecksFrom } from "./automerge.mjs";
import { detectStacks } from "./stacks.mjs";

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
// enough. A caller too odd to parse reads as absent, never as a caller with
// wrong inputs: a `with:` before `uses:` or in flow style is such a caller, and
// "caller missing" is a better report than a false "input is empty".
export function parseCaller(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) =>
    /^\s*uses:\s*(malinfossum\/ward\/|\.\/)\.github\/workflows\/ci\.yml/.test(line),
  );
  if (at === -1) return null;
  const uses = unquote(lines[at].replace(/^\s*uses:\s*/, ""));
  const indent = indentOf(lines[at]);
  const skippable = (line) => line.trim() === "" || /^\s*#/.test(line);
  // The job is the run of lines around `uses:` indented at least as far.
  const inJob = (line) => skippable(line) || indentOf(line) >= indent;
  let first = at;
  while (first > 0 && inJob(lines[first - 1])) first--;
  let last = at;
  while (last + 1 < lines.length && inJob(lines[last + 1])) last++;
  let withAt = -1;
  for (let i = first; i <= last; i++) {
    if (skippable(lines[i]) || indentOf(lines[i]) !== indent || !/^\s*with:/.test(lines[i])) {
      continue;
    }
    if (i < at || !/^\s*with:\s*(#.*)?$/.test(lines[i])) return null;
    withAt = i;
  }
  const inputs = {};
  if (withAt !== -1) {
    for (const line of lines.slice(withAt + 1)) {
      if (skippable(line)) continue;
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
  if (alerts == null) unreadable.push("Dependabot alerts");
  else if (!alerts) findings.push(["baseline", "Dependabot alerts are off."]);
  if (securityUpdates == null) unreadable.push("Dependabot security updates");
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
  if (codeScanning == null) unreadable.push("CodeQL default setup");
  else if (codeScanning.state !== "configured") {
    // The API lists the languages CodeQL would analyse even when setup is
    // off. A repo with none (docs only) cannot turn it on, so that is not a
    // finding; a response without the list is read as "can", to fail closed.
    const analysable = codeScanning.languages ? codeScanning.languages.length > 0 : true;
    if (analysable) findings.push(["baseline", "CodeQL default setup is not configured."]);
  }
  if (rules == null) unreadable.push("branch rules");
  else {
    const types = new Set(rules.map((rule) => rule.type));
    if (!types.has("pull_request")) {
      findings.push(["ruleset", "The default branch does not require a pull request."]);
    }
    if (!types.has("non_fast_forward")) {
      findings.push(["ruleset", "The default branch does not block force pushes."]);
    }
    if (!types.has("deletion")) {
      findings.push(["ruleset", "The default branch does not block deletion."]);
    }
    if (!types.has("code_scanning")) {
      findings.push(["ruleset", "The default branch does not require code scanning results."]);
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
      findings.push([
        "runtime",
        `${file}: ${runtime} is not in the EOL table; add it to tools/repo-audit.mjs.`,
      ]);
      continue;
    }
    const finding = eolFinding(`${file}: ${runtime}`, eol, today);
    if (finding) findings.push(finding);
  }
  if (nodeVersion) {
    const major = nodeVersion.match(/^v?(\d+)/)?.[1] ?? "";
    const eol = EOL.node[major];
    if (!eol) {
      findings.push([
        "runtime",
        `node-version ${nodeVersion} is not in the EOL table; add it to tools/repo-audit.mjs.`,
      ]);
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
