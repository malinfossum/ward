// The weekly audit over every repo I own: the baseline settings are on, the
// caller is present on @v1 with the inputs the repo's stacks need, every NuGet
// audit suppression carries a dated reason, no runtime is near end of life,
// and Ward's canary is alive. Each check is a pure function over fetched data
// that returns [kind, message] findings; main() only fetches and reports.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { requiredChecksFrom } from "./automerge.mjs";
import { fetchFile, listRepos } from "./repo-hygiene.mjs";
import { detectStacks, ignored, loadStacks } from "./stacks.mjs";

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

// admin: the token for the four settings endpoints; read: the token for the
// public reads (tree, caller, project files, branch rules). stacks supplies the
// ignore prefixes, the same ones stack detection skips.
export async function fetchRepoData(meta, { admin, read, stacks = loadStacks() }) {
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
  for (const path of paths.filter((p) => PROPS_OR_PROJECT.test(p) && !ignored(p, stacks.ignore))) {
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

// The canary runs endpoint answers 404 when canary.yml does not exist yet, and
// 401 or 403 when the token cannot read it. Only the 404 means "no canary": a
// token that cannot read must never look like a missing workflow.
export function canaryFindings(status, body, now) {
  if (status === 401 || status === 403) {
    return [["token", `Cannot read canary runs on ${WARD} (HTTP ${status}).`]];
  }
  return checkCanary(status === 404 ? null : body, now);
}

// The suppression reason is free text from a public file and the audit log is
// public too, so an email address in it never reaches the summary.
export const redactEmails = (text) => text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[redacted]");

export const suppressionRow = (s) =>
  `| ${s.repo} | ${s.file} | ${s.advisory} | ${redactEmails(s.reason || "(none)")} |\n`;

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
      if (listed.archived && !includeArchived) continue;
      // One repo's API error is that repo's finding, so the others still
      // report and the summary survives; the run still fails on it.
      try {
        // The list omits security_and_analysis; the single-repo call has it.
        const meta = (await request(`/repos/${listed.full_name}`, admin)).body ?? listed;
        const data = await fetchRepoData(meta, { admin, read, stacks });
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
  const canaryResult = canaryFindings(canary.status, canary.body, new Date().toISOString());
  // Ward is my own repo: a canary I cannot read fails the run, and --warn-kinds
  // never softens it.
  const ownWarn = warnKindsFor(WARD.split("/")[0], env);
  summary += report(`${WARD} canary`, canaryResult, level, ownWarn);
  failures += hardCount(canaryResult, ownWarn);

  if (suppressions.length) {
    summary +=
      "### NuGet audit suppressions\n\n| Repo | File | Advisory | Reason |\n|---|---|---|---|\n";
    for (const s of suppressions) summary += suppressionRow(s);
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
