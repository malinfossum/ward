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

// Windows names variables without regard to case, so the match ignores it too.
// An env the caller passes is scrubbed the same way, never replaced.
export function git(dir, args, options = {}) {
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      ([name]) => !LOCAL_ENV.includes(name.toUpperCase()),
    ),
  );
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", ...options, env });
}
