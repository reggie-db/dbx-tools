#!/usr/bin/env -S npx tsx
import { sep } from "node:path";
import { generateBarrels } from "../src/barrels";
import { logger, pluralize } from "../src/log";
import { watchLoop, watchRoots } from "../src/watch";
import { workspacePackages } from "../src/workspace";

const log = logger.withTag("projen:barrels");

/** The recorded package dir that owns `abs`, if any (for a targeted barrel rebuild). */
function ownerPackageDir(abs: string, pkgDirs: string[]): string | undefined {
  return pkgDirs.find((dir) => abs === dir || abs.startsWith(dir + sep));
}

if (process.argv.includes("--watch")) {
  // Watch the package roots; a source edit inside a package rebuilds just that
  // package's `index.ts` barrel (no re-synth - the projenrc watcher owns that).
  // watchLoop already drops generated paths, so a barrel write never re-triggers us.
  watchLoop("barrels", watchRoots(), (changed) => {
    const pkgDirs = workspacePackages().map((p) => p.dir);
    const dirs = new Set<string>();
    for (const p of changed) {
      const owner = ownerPackageDir(p, pkgDirs);
      if (owner) dirs.add(owner);
    }
    const n = generateBarrels(dirs.size ? { dirs: [...dirs] } : {});
    if (n) log.success(`rebuilt ${pluralize(n, "barrel")}`);
  });
} else {
  const n = generateBarrels();
  log.success(n === 0 ? "barrels already up to date" : `updated ${pluralize(n, "barrel")}`);
}
