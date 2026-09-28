// Decides whether a Dependabot PR may auto-merge: only Dependabot's own
// commits, patch or minor only, nothing bound to the .NET runtime, no
// third-party action, never Ward itself, and only where the base branch
// requires Ward's gate. Without a required check, auto-merge would merge
// instantly.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DEPENDABOT } from "./identity.mjs";

export const RUNTIME_BOUND = [
  /^Microsoft\.AspNetCore\./i,
  /^Microsoft\.EntityFrameworkCore/i,
  /^Microsoft\.Extensions\./i,
  /^Microsoft\.NET(Core)?\./i,
  /^System\./i,
  /^dotnet-sdk$/i,
  /\/dotnet\//i,
];

// Ward's workflows hold write access in every repo that calls them, and the
// caller pins them to a SHA so that I read each bump.
export const NEVER_AUTO = [/^malinfossum\/ward/i];

// Actions from GitHub's own organisations. Any other action runs inside
// workflows that may hold deploy secrets, so it waits for my review.
export const FIRST_PARTY_ACTIONS = /^(actions|github|dependabot)\//i;

// Refused by ecosystem, whatever the dependency is called.
const RUNTIME_ECOSYSTEMS = new Set(["dotnet_sdk"]);

const SAFE = new Set(["version-update:semver-patch", "version-update:semver-minor"]);

export function requiredChecksFrom(rules) {
  return rules
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters.required_status_checks.map((check) => check.context));
}

export function decide({
  authors,
  ecosystem,
  updateType,
  dependencies,
  requiredChecks,
  requiredCheck,
}) {
  const others = authors.filter((author) => author.toLowerCase() !== DEPENDABOT);
  if (others.length || authors.length === 0) {
    return { merge: false, reason: "the PR has commits by someone other than Dependabot" };
  }
  if (!requiredChecks.includes(requiredCheck)) {
    return { merge: false, reason: `the base branch does not require "${requiredCheck}"` };
  }
  if (!SAFE.has(updateType)) {
    return { merge: false, reason: `${updateType || "an unknown update type"} needs my review` };
  }
  if (!ecosystem || dependencies.length === 0) {
    return { merge: false, reason: "missing Dependabot metadata" };
  }
  const kind = ecosystem.replaceAll("-", "_");
  if (RUNTIME_ECOSYSTEMS.has(kind)) {
    return { merge: false, reason: `runtime-bound: the ${ecosystem} ecosystem` };
  }
  const ward = dependencies.filter((name) => NEVER_AUTO.some((pattern) => pattern.test(name)));
  if (ward.length) {
    return { merge: false, reason: `Ward itself: ${ward.join(", ")}` };
  }
  const bound = dependencies.filter((name) => RUNTIME_BOUND.some((pattern) => pattern.test(name)));
  if (bound.length) {
    return { merge: false, reason: `runtime-bound: ${bound.join(", ")}` };
  }
  if (kind === "github_actions") {
    const thirdParty = dependencies.filter((name) => !FIRST_PARTY_ACTIONS.test(name));
    if (thirdParty.length) {
      return { merge: false, reason: `third-party action: ${thirdParty.join(", ")}` };
    }
  }
  return { merge: true, reason: `${updateType} of ${dependencies.join(", ")}` };
}

function main() {
  const env = process.env;
  const gh = (...args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));

  // Fetched first, outside the try/catch below, so that a failure further
  // down still knows whether auto-merge is currently on.
  const { commits, autoMergeRequest } = gh(
    "pr",
    "view",
    env.PR_URL,
    "--json",
    "commits,autoMergeRequest",
  );

  // Every refusal, and every failure below, turns off auto-merge that an
  // earlier run enabled — for example before I pushed a commit of my own
  // onto the PR. Skipped when auto-merge was never on, so a fresh PR's first
  // (failing) run does not shell out for nothing.
  const disableAutoMerge = () => {
    if (autoMergeRequest == null) return;
    const result = spawnSync("gh", ["pr", "merge", "--disable-auto", env.PR_URL], {
      stdio: "ignore",
    });
    if (result.status !== 0) {
      console.log(`::error::Failed to disable auto-merge on ${env.PR_URL}`);
      process.exitCode = 1;
    }
  };

  try {
    const rules = gh("api", `repos/${env.REPO}/rules/branches/${env.BRANCH}`);
    const result = decide({
      authors: commits.flatMap((commit) => commit.authors.map((author) => author.email ?? "")),
      ecosystem: env.ECOSYSTEM ?? "",
      updateType: env.UPDATE_TYPE ?? "",
      dependencies: (env.DEPENDENCIES ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
      requiredChecks: requiredChecksFrom(rules),
      requiredCheck: env.REQUIRED_CHECK,
    });
    if (!result.merge) {
      disableAutoMerge();
      console.log(`::notice::Leaving this PR for review: ${result.reason}`);
      return;
    }
    execFileSync("gh", ["pr", "merge", "--auto", "--squash", env.PR_URL], { stdio: "inherit" });
    console.log(`Auto-merge enabled: ${result.reason}`);
  } catch (error) {
    disableAutoMerge();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
