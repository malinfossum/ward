import assert from "node:assert/strict";
import { test } from "node:test";
import { watch } from "./watchdog.mjs";

const NOW = "2026-10-05T07:00:00Z";

// Replaces fetch for one test; node:test restores it when the test ends.
function answer(t, status, body) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? "" });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const run = (conclusion, updated_at) => ({
  workflow_runs: [{ conclusion, updated_at, html_url: "https://github.com/x/runs/1" }],
});

test("a fresh run passes, whatever its conclusion: the watchdog checks liveness, not results", async (t) => {
  const calls = answer(t, 200, run("failure", "2026-10-04T06:20:00Z"));
  assert.equal(await watch("repo-audit.yml", "tok", NOW), null);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].url,
    /\/repos\/malinfossum\/ward\/actions\/workflows\/repo-audit\.yml\/runs\?per_page=1&status=completed$/,
  );
  assert.equal(calls[0].auth, "Bearer tok");
});

test("a run older than 8 days, or none ever, is a problem", async (t) => {
  answer(t, 200, run("success", "2026-09-26T06:20:00Z"));
  assert.match(await watch("repo-audit.yml", "", NOW), /repo-audit\.yml run is 9 days old/);
  answer(t, 200, { total_count: 0, workflow_runs: [] });
  assert.match(await watch("repo-audit.yml", "", NOW), /never completed/);
});

test("a missing workflow and an unreadable one are problems, and a 5xx throws", async (t) => {
  answer(t, 404);
  assert.match(await watch("repo-audit.yml", "", NOW), /does not exist in malinfossum\/ward/);
  answer(t, 403);
  assert.match(
    await watch("repo-audit.yml", "", NOW),
    /Cannot read repo-audit\.yml runs .*HTTP 403/,
  );
  answer(t, 503);
  await assert.rejects(() => watch("repo-audit.yml", "", NOW), /GitHub API 503/);
});
