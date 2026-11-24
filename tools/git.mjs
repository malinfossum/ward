// git in a folder the caller names. A git hook exports GIT_DIR and its kin, and
// git obeys them over -C, so a read of that folder would read the hook's repo
// instead. The child gets every variable but these: the ones
// `git rev-parse --local-env-vars` lists, except GIT_CONFIG and its kin, which
// carry config set on purpose (safe.directory in a container, say) and point
// at no repo. A test holds the two lists together.
import { spawnSync } from "node:child_process";

export const LOCAL_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

// Without the variables above. Windows names variables without regard to case,
// so the match ignores it too.
export function scrubbed(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !LOCAL_ENV.includes(name.toUpperCase())),
  );
}

// An env the caller passes is scrubbed the same way, never replaced. The
// buffer is raised from spawnSync's 1 MiB, which a file list of a large repo
// outgrows; past it the read fails and reads as no work tree.
export function git(dir, args, options = {}) {
  const env = scrubbed(options.env ?? process.env);
  return spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    env,
  });
}
