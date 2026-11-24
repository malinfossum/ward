// git in a folder the caller names. A git hook exports GIT_DIR and its kin, and
// git obeys them over -C, so a read of that folder would read the hook's repo
// instead. The child gets every variable but these, which are the ones
// `git rev-parse --local-env-vars` lists (a test holds the two together).
import { spawnSync } from "node:child_process";

export const LOCAL_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
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
export function git(dir, args, options = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !LOCAL_ENV.includes(name.toUpperCase())),
  );
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", ...options, env });
}
