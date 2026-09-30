import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkLinks,
  checkMetadata,
  checkStack,
  checkVersions,
  compareVersions,
  contentsPath,
  extractLinks,
  extractLocalRefs,
  liveUrlInReadme,
  manifestDeps,
  manifestVersion,
  overlap,
  readmeIntro,
  readmeTitle,
  tokenize,
} from "./repo-hygiene.mjs";

const README = `# Spindle

[![CI](https://example.com/badge.svg)](https://example.com/ci)

A local library for your LP and CD collection.

**Live:** [spindle-music.pages.dev](https://spindle-music.pages.dev)

## Stack

- Vite for the build, Biome for formatting
`;

test("readmeIntro skips the heading, badges and blockquotes", () => {
  assert.match(readmeIntro(README), /^A local library for your LP and CD collection\./);
  assert.equal(readmeIntro("# T\n\n> a note\n\nReal text."), "Real text.");
  assert.equal(readmeIntro("# Only a heading"), "");
});

test("readmeIntro takes the whole pitch, so a tagline cannot hide the real line", () => {
  const md =
    "# Ignite\n\n*a small flame, kept going.*\n\nSometimes all it takes is a spark.\n\n" +
    "An ADHD-friendly task app: capture a thought in one line.\n\n## Install\n\nnot the intro\n";
  const intro = readmeIntro(md);
  assert.match(intro, /ADHD-friendly task app/);
  assert.doesNotMatch(intro, /not the intro/);
  assert.ok(overlap("ADHD-friendly task app", intro) >= 0.4);
});

test("readmeTitle reads the H1", () => {
  assert.equal(readmeTitle(README), "Spindle");
  assert.equal(readmeTitle("no heading here"), "");
});

test("tokenize drops stop words and short words", () => {
  assert.deepEqual([...tokenize("A local library for your LP")], ["local", "library"]);
});

test("overlap scores shared wording, not exact matches", () => {
  assert.equal(overlap("A local library for LP and CD", "A local library for your LP"), 1);
  assert.ok(overlap("job radar for developers", "a calm desktop timer") < 0.4);
  assert.equal(overlap("", "anything"), 0);
});

test("manifestDeps keeps notable packages and drops plumbing", () => {
  const pkg = JSON.stringify({
    dependencies: { astro: "7", react: "19", "@fontsource/bebas-neue": "5" },
    devDependencies: { "@biomejs/biome": "2", "@types/node": "26" },
  });
  assert.deepEqual(manifestDeps({ "package.json": pkg }).sort(), ["astro", "biome", "react"]);
});

test("manifestDeps reads PackageReference out of a csproj", () => {
  const csproj = `<Project><ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="9.0" />
    <PackageReference Include="NUnit" Version="4.0" />
    <PackageReference Include="SomeInternal.Thing" Version="1.0" />
  </ItemGroup></Project>`;
  assert.deepEqual(manifestDeps({ "App.csproj": csproj }).sort(), ["EF Core", "NUnit"]);
});

test("manifestVersion reads package.json and pyproject.toml", () => {
  assert.equal(manifestVersion({ "package.json": '{"version":"0.2.0-dev"}' }), "0.2.0-dev");
  assert.equal(manifestVersion({ "pyproject.toml": 'name = "x"\nversion = "0.6.0"\n' }), "0.6.0");
  assert.equal(manifestVersion({}), "");
});

test("compareVersions orders releases, tags and prereleases", () => {
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(compareVersions("v2.6.1", "2.6.1"), 0);
  assert.equal(compareVersions("0.2.0-dev", "0.1.0"), 1);
});

test("extractLinks and extractLocalRefs split external from in-repo", () => {
  const md = '[a](https://x.test) <img src="assets/chip.svg"> [b](./docs/plan.md#top)';
  assert.deepEqual(extractLinks(md), ["https://x.test"]);
  assert.deepEqual(extractLocalRefs(md).sort(), ["./docs/plan.md", "assets/chip.svg"]);
});

test("liveUrlInReadme finds this repo's site, not a link to another project", () => {
  assert.equal(liveUrlInReadme(README, "spindle"), "https://spindle-music.pages.dev");
  const index = "Live demo: [html-intro](https://malinfossum.github.io/html-intro/).";
  assert.equal(
    liveUrlInReadme(index, "getacademy"),
    "",
    "another project's demo is not this repo's site",
  );
  assert.equal(liveUrlInReadme(README, ""), "");
  assert.equal(liveUrlInReadme("no site here", "x"), "");
});

test("checkMetadata flags GitHub Pages with no homepage set", () => {
  const findings = checkMetadata(
    {
      name: "portfolio",
      description: "A portfolio site",
      topics: ["a", "b", "c"],
      homepage: "",
      has_pages: true,
    },
    "# Portfolio\n\nA portfolio site.\n",
  );
  assert.deepEqual(
    findings.map(([kind]) => kind),
    ["homepage"],
  );
});

test("checkMetadata flags a drifted description, thin topics and a missing homepage", () => {
  const findings = checkMetadata(
    {
      name: "spindle",
      description: "A tool for tracking job adverts",
      topics: ["music"],
      homepage: "",
    },
    README,
  );
  const kinds = findings.map(([kind]) => kind);
  assert.deepEqual(kinds.sort(), ["description", "homepage", "topics"]);
});

test("checkMetadata passes a repo whose face matches its README", () => {
  const findings = checkMetadata(
    {
      name: "spindle",
      description: "A local library for your LP and CD collection",
      topics: ["music-library", "vite", "mvc"],
      homepage: "https://spindle-music.pages.dev",
    },
    README,
  );
  assert.deepEqual(findings, []);
});

test("checkMetadata flags an H1 that is the repo slug", () => {
  const findings = checkMetadata(
    { name: "devops-course", description: "Course work", topics: ["a", "b", "c"], homepage: "" },
    "# devops-course\n\nCourse work notes.\n",
  );
  assert.deepEqual(
    findings.map(([kind]) => kind),
    ["title"],
  );
});

test("checkStack names manifest packages the README never mentions", () => {
  assert.deepEqual(checkStack(README, ["vite", "biome"]), []);
  const [finding] = checkStack(README, ["astro", "vite"]);
  assert.equal(finding[0], "stack");
  assert.match(finding[1], /astro/);
});

test("checkVersions catches a manifest behind its tag, and unreleased work", () => {
  assert.deepEqual(
    checkVersions("", "0.5.0", "v0.6.0").map(([k]) => k),
    ["version"],
  );
  const [unreleased] = checkVersions("", "0.2.0-dev", "v0.1.0");
  assert.match(unreleased[1], /Unreleased work/);
  assert.deepEqual(checkVersions("", "2.6.1", "v2.6.1"), []);
});

test("checkVersions reads a stale version out of README prose", () => {
  const md = "**Status:** v0.1.0 is the last tagged release.";
  assert.deepEqual(
    checkVersions(md, "", "v0.3.0").map(([k]) => k),
    ["version"],
  );
});

test("checkLinks reports dead relative paths and bad status codes", async () => {
  const md = "[gone](docs/missing.md) [ok](https://good.test) [bad](https://bad.test)";
  const fakeFetch = async (url) => ({
    ok: url === "https://good.test",
    status: url === "https://good.test" ? 200 : 404,
  });
  const findings = await checkLinks(md, (p) => p !== "docs/missing.md", fakeFetch);
  assert.equal(findings.length, 2);
  assert.match(findings[0][1], /Dead relative link/);
  assert.match(findings[1][1], /bad\.test/);
});

test("checkLinks treats throttling as reachable", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429 });
  assert.deepEqual(await checkLinks("[x](https://slow.test)", () => true, fakeFetch), []);
});

test("contentsPath encodes each segment and keeps the slashes", () => {
  assert.equal(contentsPath(".github/workflows/ward.yml"), ".github/workflows/ward.yml");
  assert.equal(contentsPath("src/My App/App.csproj"), "src/My%20App/App.csproj");
});
