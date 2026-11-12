// Decides whether a Dependabot PR may auto-merge: only Dependabot's own
// commits, patch or minor (or a major of a development dependency), nothing
// bound to the .NET runtime, no third-party action, Ward itself only at a
// release tag, and only where the base branch requires Ward's gate. Without a
// required check, auto-merge would merge instantly.
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
  // The image is the runtime, and CI never runs inside it: mcr.microsoft.com/dotnet/aspnet
  // and a registry-less name like dotnet/aspnet both refer to the same container image.
  /(^|\/)dotnet\//i,
];

// Ward's workflows hold write access in every repo that calls them, so the
// caller pins them to a SHA. A bump merges only when every SHA it moves to is
// the commit of a vX.Y.Z tag on Ward's main: a tag ruleset lets only me create
// or move those, so the tag is my review. Anything else named like Ward is a
// look-alike and waits.
export const WARD = /^malinfossum\/ward(\/|$)/i;
const LOOK_ALIKE = /^malinfossum\/ward/i;
export const WARD_REPO = "malinfossum/ward";

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
export const isReleaseTag = (name) => RELEASE_TAG.test(name);

// The Ward SHAs a PR diff adds. fetch-metadata cannot give them: a SHA pin
// with a version comment reports the comment, and a SHA-to-SHA bump reads as
// a major.
export function wardTargets(diff) {
  const added = /^\+.*\buses:\s*["']?malinfossum\/ward\/[^@\s"']+@([0-9a-f]{40})\b/gim;
  return [...new Set([...diff.matchAll(added)].map((match) => match[1].toLowerCase()))];
}

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

// Rulesets need GitHub Pro on a private repo, so GitHub Free answers 403
// "Upgrade to GitHub Pro" for its branch rules. That is a branch with no
// rules, and the PR is left for review like any other without the required
// check; it is not a failure of this job. Every other refusal still throws.
const NEEDS_PRO = /upgrade to github pro/i;

export function rulesOrNone(readRules) {
  try {
    return readRules();
  } catch (error) {
    if (NEEDS_PRO.test(`${error.stderr ?? ""}\n${error.message}`)) return [];
    throw error;
  }
}

const MAJOR = "version-update:semver-major";
const DEVELOPMENT = "direct:development";

function decideWard(dependencies, wardPins) {
  if (dependencies.some((name) => !WARD.test(name))) {
    return { merge: false, reason: "a Ward bump arrives in its own PR; this one mixes in others" };
  }
  if (wardPins.length === 0) {
    return { merge: false, reason: "a Ward bump with no Ward pin in the diff" };
  }
  for (const pin of wardPins) {
    const short = pin.sha.slice(0, 7);
    if (!pin.release) return { merge: false, reason: `${short} is not a Ward release tag` };
    if (!pin.onMain) {
      return { merge: false, reason: `${pin.release} (${short}) is not on Ward's main` };
    }
  }
  const releases = [...new Set(wardPins.map((pin) => pin.release))];
  return { merge: true, reason: `Ward release ${releases.join(", ")}` };
}

export function decide({
  authors,
  ecosystem,
  updateType,
  dependencyType,
  dependencies,
  requiredChecks,
  requiredCheck,
  wardPins = [],
}) {
  const others = authors.filter((author) => author.toLowerCase() !== DEPENDABOT);
  if (others.length || authors.length === 0) {
    return { merge: false, reason: "the PR has commits by someone other than Dependabot" };
  }
  if (!requiredChecks.includes(requiredCheck)) {
    return { merge: false, reason: `the base branch does not require "${requiredCheck}"` };
  }
  if (!ecosystem || dependencies.length === 0) {
    return { merge: false, reason: "missing Dependabot metadata" };
  }
  const kind = ecosystem.replaceAll("-", "_");
  if (RUNTIME_ECOSYSTEMS.has(kind)) {
    return { merge: false, reason: `runtime-bound: the ${ecosystem} ecosystem` };
  }
  const lookAlikes = dependencies.filter((name) => LOOK_ALIKE.test(name) && !WARD.test(name));
  if (lookAlikes.length) {
    return { merge: false, reason: `a look-alike of Ward: ${lookAlikes.join(", ")}` };
  }
  // Checked before the update type: fetch-metadata calls every SHA bump a major.
  if (dependencies.some((name) => WARD.test(name))) return decideWard(dependencies, wardPins);
  // fetch-metadata reports the most production-like type among the PR's
  // dependencies, so direct:development means every one of them is.
  const devMajor = updateType === MAJOR && dependencyType === DEVELOPMENT;
  if (!SAFE.has(updateType) && !devMajor) {
    return { merge: false, reason: `${updateType || "an unknown update type"} needs my review` };
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
  const what = devMajor ? "development major" : updateType;
  return { merge: true, reason: `${what} of ${dependencies.join(", ")}` };
}

// Each Ward SHA the PR moves to, with the release tag that names it and
// whether Ward's main contains it. GitHub's tag list gives each tag's commit,
// annotated tags already peeled.
function wardPinsOf(prUrl, gh, ghText) {
  const shas = wardTargets(ghText("pr", "diff", prUrl));
  if (shas.length === 0) return [];
  const releases = new Map();
  const pages = gh("api", "--paginate", "--slurp", `repos/${WARD_REPO}/tags?per_page=100`);
  for (const tag of pages.flat()) {
    if (isReleaseTag(tag.name) && !releases.has(tag.commit.sha)) {
      releases.set(tag.commit.sha, tag.name);
    }
  }
  return shas.map((sha) => {
    const release = releases.get(sha) ?? null;
    if (!release) return { sha, release, onMain: false };
    const { status } = gh("api", `repos/${WARD_REPO}/compare/${sha}...main`);
    return { sha, release, onMain: status === "ahead" || status === "identical" };
  });
}

function main() {
  const env = process.env;
  const ghText = (...args) => execFileSync("gh", args, { encoding: "utf8" });
  const gh = (...args) => JSON.parse(ghText(...args));

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
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.log(`::error::Failed to disable auto-merge on ${env.PR_URL}`);
      process.exitCode = 1;
    }
  };

  try {
    const rules = rulesOrNone(() => gh("api", `repos/${env.REPO}/rules/branches/${env.BRANCH}`));
    const dependencies = (env.DEPENDENCIES ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const wardPins = dependencies.some((name) => WARD.test(name))
      ? wardPinsOf(env.PR_URL, gh, ghText)
      : [];
    const result = decide({
      authors: commits.flatMap((commit) => commit.authors.map((author) => author.email ?? "")),
      ecosystem: env.ECOSYSTEM ?? "",
      updateType: env.UPDATE_TYPE ?? "",
      dependencyType: env.DEPENDENCY_TYPE ?? "",
      dependencies,
      wardPins,
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
