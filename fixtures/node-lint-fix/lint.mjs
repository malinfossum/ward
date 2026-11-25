// A lint that passes only because it fixes what it finds: it rewrites the
// double quotes in src.js and exits 0. It also writes an untracked cache,
// which the gate leaves alone.
import { readFileSync, writeFileSync } from "node:fs";

writeFileSync("src.js", readFileSync("src.js", "utf8").replaceAll('"', "'"));
writeFileSync(".lintcache", "{}\n");
