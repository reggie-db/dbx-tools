#!/usr/bin/env -S bun
import { sep } from "node:path";
import { parseArgs } from "node:util";
import { log, string } from "@dbx-tools/shared-core";
import { generateBarrels } from "../src/barrels.ts";
import { recordedPackages } from "../src/packages.ts";
import { watchLoop, watchRoots } from "../src/watch.ts";

const logger = log.logger("projen:barrels");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    watch: { type: "boolean" },
    dir: { type: "string", multiple: true },
  },
  strict: false,
});

/** The recorded package dir that owns `abs`, if any (for a targeted barrel rebuild). */
function ownerPackageDir(abs: string, pkgDirs: string[]): string | undefined {
  return pkgDirs.find((dir) => abs === dir || abs.startsWith(dir + sep));
}

if (values.watch) {
  // Watch the package roots; a source edit inside a package rebuilds just that
  // package's `index.ts` barrel (no re-synth - the projenrc watcher owns that).
  // watchLoop already drops generated paths, so a barrel write never re-triggers us.
  watchLoop("barrels", watchRoots(), (changed) => {
    const pkgDirs = recordedPackages().map((p) => p.dir);
    const dirs = new Set<string>();
    const unowned: string[] = [];
    for (const p of changed) {
      const owner = ownerPackageDir(p, pkgDirs);
      if (owner) dirs.add(owner);
      else unowned.push(p);
    }
    // A change under a package root that no RECORDED package owns is almost always a
    // NEW package folder: it has no `pnpm-workspace.yaml` member yet, so there is no
    // barrel for this watcher to target and only a re-synth can create one. Say so,
    // rather than rebuilding every barrel in the repo - the previous fallback, which
    // did a full-repo sweep on behalf of a file it could not barrel anyway, and in
    // doing so raced the projenrc watcher's own post-synth sweep.
    if (dirs.size === 0) {
      if (unowned.length) {
        logger.warn(
          `no recorded package owns ${string.pluralize(unowned.length, "change")}; ` +
            "run `bun run default` (or touch .projenrc.ts) to pick up a new package folder",
        );
      }
      return;
    }
    const n = generateBarrels({ dirs: [...dirs] });
    if (n) logger.success(`rebuilt ${string.pluralize(n, "barrel")}`);
  });
} else {
  const dirs = Array.isArray(values.dir)
    ? values.dir.filter((value): value is string => typeof value === "string")
    : [];
  const n = generateBarrels(dirs.length ? { dirs } : undefined);
  logger.success(
    n === 0 ? "barrels already up to date" : `updated ${string.pluralize(n, "barrel")}`,
  );
}
