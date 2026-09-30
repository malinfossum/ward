// Checks that a repo's public face still matches what is inside it: the GitHub
// description against the README's opening line, topics and homepage, the Stack
// section against the real manifests, and versions and links against reality.
//
//   node tools/repo-hygiene.mjs --repo owner/name [--path .] [--mode warn|strict]
//   node tools/repo-hygiene.mjs --all --owner malinfossum,wendhq [--include-archived]
//
// --repo reads the files from a local checkout (what CI does per repo).
// --all reads them over the API for every repo an owner has, which is how
// archived repos get audited: they are read-only, so they cannot run Actions.
// Exit 1 when findings exist and --mode strict; warn mode always exits 0.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";

// Dependencies worth naming in a README. Everything else in a manifest is
// plumbing, and flagging all of it would train me to ignore the check.
const NOTABLE = new Set([
  "astro",
  "react",
  "vue",
  "svelte",
  "next",
  "vite",
  "vitest",
  "typescript",
  "tailwindcss",
  "biome",
  "@biomejs/biome",
  "eslint",
  "prettier",
  "playwright",
  "jest",
  "express",
  "fastify",
  "prisma",
  "drizzle-orm",
  "zod",
  "Microsoft.EntityFrameworkCore",
  "Npgsql.EntityFrameworkCore.PostgreSQL",
  "NUnit",
  "xunit",
  "Moq",
  "Serilog",
  "Dapper",
  "AutoMapper",
]);

// How a package name reads in prose, when the two differ.
const DISPLAY = {
  "@biomejs/biome": "biome",
  tailwindcss: "tailwind",
  "Microsoft.EntityFrameworkCore": "EF Core",
  "Npgsql.EntityFrameworkCore.PostgreSQL": "PostgreSQL",
};

const STOP = new Set([
  "a",
  "an",
  "and",
  "the",
  "for",
  "of",
  "to",
  "in",
  "on",
  "with",
  "your",
  "that",
  "this",
  "is",
  "it",
  "built",
  "my",
]);

export function tokenize(text) {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function overlap(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

// A README's opening pitch: every prose paragraph before the first `##`, with
// headings, badge rows, blockquotes, tables and HTML dropped. Taglines and
// scene-setting lines mean the description often matches the second or third
// paragraph, not the first, so the whole intro is the fair comparison.
export function readmeIntro(md, limit = 600) {
  const body = md.replace(/<!--[\s\S]*?-->/g, "").split(/^##\s/m)[0];
  const parts = [];
  for (const block of body.split(/\n\s*\n/)) {
    const line = block.trim();
    if (!line || line.startsWith("#") || line.startsWith(">")) continue;
    if (line.startsWith("<") || line.startsWith("|") || line.startsWith("```")) continue;
    if (/^\[!\[/.test(line) || /^!\[/.test(line)) continue;
    parts.push(line.replace(/\s+/g, " "));
    if (parts.join(" ").length >= limit) break;
  }
  return parts.join(" ").slice(0, limit);
}

export function readmeTitle(md) {
  const match = md.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

// Direct dependencies worth mentioning, from package.json or any .csproj.
export function manifestDeps(files) {
  const found = new Set();
  const pkg = files["package.json"];
  if (pkg) {
    const parsed = JSON.parse(pkg);
    for (const group of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(parsed[group] || {})) {
        if (NOTABLE.has(name)) found.add(DISPLAY[name] || name);
      }
    }
  }
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith(".csproj")) continue;
    for (const m of text.matchAll(/PackageReference\s+Include="([^"]+)"/g)) {
      const name = m[1];
      const key = [...NOTABLE].find((n) => name === n || name.startsWith(`${n}.`));
      if (key) found.add(DISPLAY[key] || key);
    }
  }
  return [...found];
}

export function manifestVersion(files) {
  const pkg = files["package.json"];
  if (pkg) return JSON.parse(pkg).version || "";
  const toml = files["pyproject.toml"];
  if (toml) {
    const m = toml.match(/^version\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  return "";
}

export function compareVersions(a, b) {
  const parts = (v) =>
    (v || "")
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((p) => Number.parseInt(p, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function extractLinks(md) {
  const urls = new Set();
  for (const m of md.matchAll(/!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) urls.add(m[1]);
  for (const m of md.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)) urls.add(m[1]);
  return [...urls];
}

export function extractLocalRefs(md) {
  const paths = new Set();
  for (const m of md.matchAll(/!?\[[^\]]*\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) paths.add(m[1]);
  for (const m of md.matchAll(/(?:href|src)="(?!https?:|mailto:|#)([^"]+)"/g)) paths.add(m[1]);
  return [...paths].map((p) => p.split("#")[0].split("?")[0]).filter(Boolean);
}

// A README that points at *this repo's* live site. An index repo links a dozen
// other projects' demos, and none of those is its homepage, so the URL has to
// carry the repo's own name to count.
export function liveUrlInReadme(md, repoName = "") {
  if (!repoName) return "";
  const hosts =
    /https?:\/\/[^\s)"]*(?:pages\.dev|github\.io|azurewebsites\.net|vercel\.app|netlify\.app|workers\.dev)[^\s)"]*/g;
  for (const match of md.matchAll(hosts)) {
    if (match[0].toLowerCase().includes(repoName.toLowerCase())) return match[0];
  }
  return "";
}

export function checkMetadata(meta, md) {
  const findings = [];
  const intro = readmeIntro(md);

  if (!meta.description) {
    findings.push(["description", "The repo has no GitHub description."]);
  } else if (intro && overlap(meta.description, intro) < 0.4) {
    findings.push([
      "description",
      `Description and README intro have drifted apart.\n    repo:   ${meta.description}\n    README: ${intro.slice(0, 120)}`,
    ]);
  }

  const topics = meta.topics || [];
  if (topics.length < 3) {
    findings.push(["topics", `Only ${topics.length} topic(s). Three or more is the bar.`]);
  }

  const live = liveUrlInReadme(md, meta.name);
  if (!meta.homepage && (live || meta.has_pages)) {
    findings.push([
      "homepage",
      `The repo is deployed but has no homepage set: ${live || "GitHub Pages is on"}`,
    ]);
  }

  const title = readmeTitle(md);
  if (
    title &&
    title.toLowerCase() === meta.name.toLowerCase() &&
    title !== title[0].toUpperCase() + title.slice(1)
  ) {
    findings.push(["title", `H1 is the repo slug, not the project name: "${title}".`]);
  }
  return findings;
}

export function checkStack(md, deps) {
  const haystack = md.toLowerCase();
  const missing = deps.filter((name) => !haystack.includes(name.toLowerCase()));
  return missing.length
    ? [["stack", `In the manifests but never named in the README: ${missing.join(", ")}.`]]
    : [];
}

export function checkVersions(md, version, latestTag) {
  const findings = [];
  if (latestTag && version && !version.includes("dev") && compareVersions(version, latestTag) < 0) {
    findings.push([
      "version",
      `Manifest version ${version} is behind the latest release ${latestTag}.`,
    ]);
  }
  if (latestTag && version.includes("dev") && compareVersions(version, latestTag) > 0) {
    findings.push([
      "version",
      `Unreleased work: manifest is ${version}, latest release is ${latestTag}.`,
    ]);
  }
  for (const m of md.matchAll(/\bv(\d+\.\d+(?:\.\d+)?)\b/g)) {
    if (
      latestTag &&
      compareVersions(m[1], latestTag) < 0 &&
      /status|release|version|latest/i.test(contextOf(md, m.index))
    ) {
      findings.push([
        "version",
        `README mentions v${m[1]} where the latest release is ${latestTag}.`,
      ]);
      break;
    }
  }
  return findings;
}

function contextOf(md, index) {
  return md.slice(Math.max(0, index - 80), index + 40);
}

export async function checkLinks(md, exists, fetchImpl = fetch) {
  const findings = [];
  for (const path of extractLocalRefs(md)) {
    if (!exists(path)) findings.push(["links", `Dead relative link: ${path}`]);
  }
  const urls = extractLinks(md);
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetchImpl(url, { method: "GET", redirect: "follow" });
        // 403 and 429 are the host throttling a bot, not a broken link.
        return res.ok || res.status === 403 || res.status === 429 ? null : `${url} → ${res.status}`;
      } catch {
        return `${url} → unreachable`;
      }
    }),
  );
  for (const bad of results.filter(Boolean)) findings.push(["links", `Broken link: ${bad}`]);
  return findings;
}

export const contentsPath = (path) => path.split("/").map(encodeURIComponent).join("/");

export async function api(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "repo-hygiene",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}`);
  return res.json();
}

export async function fetchFile(repo, path, token) {
  const data = await api(`/repos/${repo}/contents/${contentsPath(path)}`, token);
  if (!data?.content) return null;
  return Buffer.from(data.content, "base64").toString("utf8");
}

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
  // Private repos sit outside the standard (spec, Out of scope). The public
  // listing never returns one; kept so that a token or endpoint change can
  // never widen the sweep.
  return repos
    .filter((r) => !r.fork && !r.private && r.name !== ".github")
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

function localFiles(root) {
  const files = {};
  for (const name of ["README.md", "package.json", "pyproject.toml"]) {
    const path = join(root, name);
    if (existsSync(path)) files[name] = readFileSync(path, "utf8");
  }
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.name.endsWith(".csproj")) continue;
    const path = join(entry.parentPath || root, entry.name);
    files[entry.name] = readFileSync(path, "utf8");
  }
  return files;
}

async function auditRepo(meta, files, token, { links = true } = {}) {
  const md = files["README.md"];
  if (!md) return [["readme", "No README.md in the default branch."]];

  const latest = await api(`/repos/${meta.full_name}/releases/latest`, token);
  const findings = [
    ...checkMetadata(meta, md),
    ...checkStack(md, manifestDeps(files)),
    ...checkVersions(md, manifestVersion(files), latest ? latest.tag_name : ""),
  ];
  if (links) {
    const exists = files.__exists || (() => true);
    findings.push(...(await checkLinks(md, exists)));
  }
  return findings;
}

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

async function main(argv) {
  const arg = (flag, fallback = "") => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  // The sweep reads public data only, so the Actions token is all it needs.
  const token = process.env.GITHUB_TOKEN || "";
  const strict = arg("--mode", "warn") === "strict";
  let summary = "";
  let total = 0;

  if (argv.includes("--all")) {
    const owners = arg("--owner", "malinfossum")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const includeArchived = argv.includes("--include-archived");
    let archivedSummary = "";
    for (const meta of await listRepos(owners, token)) {
      if (meta.archived && !includeArchived) continue;
      const files = {};
      for (const name of ["README.md", "package.json", "pyproject.toml"]) {
        const text = await fetchFile(meta.full_name, name, token);
        if (text) files[name] = text;
      }
      const findings = await auditRepo(meta, files, token, { links: false });
      // Archived repos are read-only on GitHub: nothing can be fixed without
      // unarchiving them, so they are reported but never fail the run.
      if (meta.archived) {
        archivedSummary += report(`${meta.full_name} (archived)`, findings, "");
      } else {
        total += findings.length;
        summary += report(meta.full_name, findings, strict ? "error" : "warning");
      }
    }
    if (archivedSummary) {
      summary += `\n<details><summary>Archived repos (read-only, unarchive to fix)</summary>\n\n${archivedSummary}</details>\n`;
    }
  } else {
    const repo = arg("--repo");
    if (!repo) throw new Error("--repo owner/name is required (or --all).");
    const root = arg("--path", ".");
    const meta = await api(`/repos/${repo}`, token);
    if (!meta) throw new Error(`Repo not found: ${repo}`);
    const files = localFiles(root);
    files.__exists = (p) => existsSync(join(root, p));
    const findings = await auditRepo(meta, files, token);
    total = findings.length;
    summary += report(repo, findings, strict ? "error" : "warning");
  }

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
