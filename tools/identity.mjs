// Every commit in a range must be authored by an allowed address and carry no
// AI attribution. The identity job in ci.yml runs this.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEPENDABOT = "49699333+dependabot[bot]@users.noreply.github.com";
export const DEPENDABOT_LOGIN = "dependabot[bot]";
export const GITHUB_WEB = "noreply@github.com";

// Anchored to the start of a line, so prose that mentions a footer passes.
const ATTRIBUTION = /^claude-session:|^(🤖\s*)?generated with\b.*(claude|copilot|chatgpt|cursor)/i;
const AI_COAUTHOR = /claude|anthropic|copilot|openai|chatgpt|cursor/i;
const ADDRESS = /[^\s<>]+@[^\s<>]+/g;

// CI logs on a public repo are public: show enough to recognise an address,
// not enough to publish it.
export function redact(address) {
  const at = address.lastIndexOf("@");
  return at < 1 ? "…" : `${address[0]}…${address.slice(at)}`;
}

const redactLine = (line) => line.replace(ADDRESS, redact);

export function parseAllowed(value) {
  return value
    .split(/[\s,]+/)
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
}

export function parseLog(raw) {
  return raw
    .split("\x1e")
    .map((record) => record.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha, author, committer, subject, body = ""] = record.split("\x1f");
      return { sha, author, committer, subject, body };
    });
}

export function textProblems(text, { allowed, allowHumanCoauthors }) {
  // A squash merge adds a co-author line for every other author, including me
  // and Dependabot, so those addresses pass.
  const own = new Set([...allowed, DEPENDABOT]);
  const problems = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (ATTRIBUTION.test(line)) {
      problems.push(`attribution line: ${redactLine(line)}`);
      continue;
    }
    if (!/^co-authored-by:/i.test(line)) continue;
    const address = (line.match(/<([^>]+)>/)?.[1] ?? "").toLowerCase();
    if (AI_COAUTHOR.test(line) || (!own.has(address) && !allowHumanCoauthors)) {
      problems.push(`co-author line: ${redactLine(line)}`);
    }
  }
  return problems;
}

// Dependabot PRs quote upstream release notes, which I do not control.
export function prTextProblems({ author, title, body }, policy) {
  if (author === DEPENDABOT_LOGIN) return [];
  return textProblems(`${title}\n${body}`, policy);
}

export function commitProblems(commit, policy) {
  const own = new Set([...policy.allowed, DEPENDABOT]);
  const committers = new Set([...own, GITHUB_WEB]);
  const problems = [];
  if (!own.has(commit.author.toLowerCase())) {
    problems.push(`authored by <${redact(commit.author)}>`);
  }
  if (!committers.has(commit.committer.toLowerCase())) {
    problems.push(`committed by <${redact(commit.committer)}>`);
  }
  problems.push(...textProblems(commit.body, policy));
  return problems;
}

function main() {
  const env = process.env;
  const policy = {
    allowed: parseAllowed(env.ALLOWED ?? ""),
    allowHumanCoauthors: env.ALLOW_HUMAN_COAUTHORS === "true",
  };
  const head = env.HEAD || "HEAD";
  const range = /^0*$/.test(env.BASE ?? "") ? ["-1", head] : [`${env.BASE}..${head}`];
  const raw = execFileSync("git", ["log", "--format=%H%x1f%ae%x1f%ce%x1f%s%x1f%B%x1e", ...range], {
    encoding: "utf8",
  });

  let bad = 0;
  for (const commit of parseLog(raw)) {
    for (const problem of commitProblems(commit, policy)) {
      console.log(`::error::${commit.sha.slice(0, 7)} ${problem} (${commit.subject})`);
      bad++;
    }
  }
  const pr = { author: env.PR_AUTHOR ?? "", title: env.PR_TITLE ?? "", body: env.PR_BODY ?? "" };
  for (const problem of prTextProblems(pr, policy)) {
    console.log(`::error::Pull request ${problem}`);
    bad++;
  }
  if (bad === 0) {
    console.log("Every commit is authored by an allowed address and carries no AI attribution.");
  }
  process.exitCode = bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
