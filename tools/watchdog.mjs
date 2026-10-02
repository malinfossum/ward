// Fails when one of Ward's own scheduled workflows has gone quiet: no
// completed run within MAX_AGE_DAYS, or none ever. GitHub turns a schedule
// off after 60 days without activity, silently. The canary runs this against
// the audit, the audit checks the canary through checkCanary, and my Monday
// briefing checks both from outside GitHub. Liveness only: a red run has
// already failed and emailed on its own.
import { pathToFileURL } from "node:url";
import { lastRunProblem, request, WARD } from "./repo-audit.mjs";

// The problem with the latest completed run of `workflow`, or null.
export async function watch(workflow, token, now = new Date().toISOString()) {
  const { status, body } = await request(
    `/repos/${WARD}/actions/workflows/${workflow}/runs?per_page=1&status=completed`,
    token,
  );
  if (status === 404) return `${workflow} does not exist in ${WARD}.`;
  if (status !== 200) return `Cannot read ${workflow} runs on ${WARD} (HTTP ${status}).`;
  return lastRunProblem(workflow, body, now, { requireSuccess: false });
}

async function main(argv) {
  const workflow = argv[0];
  if (!workflow) throw new Error("usage: node tools/watchdog.mjs <workflow file>");
  const problem = await watch(workflow, process.env.GITHUB_TOKEN || "");
  if (problem) {
    console.log(`::error::${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${workflow}: the latest completed run is fresh.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
