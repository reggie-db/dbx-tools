#!/usr/bin/env -S bun
import { sep } from "node:path";
import { parseArgs } from "node:util";
import { log, object, stringUtils } from "@dbx-tools/shared-core";
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
function ownerPackageDir(
  abs: string,
  packages: readonly { readonly dir: string; readonly tags: readonly string[] }[],
): string | undefined {
  // The OpenAPI task rebuilds generated-client barrels after writing its files.
  return packages.find(
    ({ dir, tags }) => !tags.includes("openapi") && (abs === dir || abs.startsWith(dir + sep)),
  )?.dir;
}

function changedBarrelTargets(changed: readonly string[]): object.Sequence<string> {
  const packages = recordedPackages();
  return object
    .sequence(changed)
    .map((path) => ownerPackageDir(path, packages))
    .nonNull()
    .distinct();
}

function warnUnownedChanges(changed: readonly string[]): void {
  if (changed.length) {
    logger.warn(
      `no recorded package owns ${stringUtils.pluralize(changed.length, "change")}; ` +
        "run `bun run default` (or touch .projenrc.ts) to pick up a new package folder",
    );
  }
}

if (values.watch) {
  // Watch the package roots; a source edit inside a package rebuilds just that
  // package's `index.ts` barrel (no re-synth - the projenrc watcher owns that).
  // watchLoop already drops generated paths, so a barrel write never re-triggers us.
  watchLoop(
    "barrels",
    watchRoots(),
    (changed) => {
      const n = generateBarrels({ dirs: [...changedBarrelTargets(changed)] });
      if (n) logger.success(`rebuilt ${stringUtils.pluralize(n, "barrel")}`);
    },
    {
      check: (changed) => {
        const targets = changedBarrelTargets(changed);
        // A change under a package root that no recorded package owns is a new
        // folder: only a re-synth can create its barrel, so this watcher skips.
        if (!targets.some(() => true)) {
          warnUnownedChanges(changed);
          return false;
        }
        return true;
      },
    },
  );
} else {
  const dirs = Array.isArray(values.dir)
    ? values.dir.filter((value): value is string => typeof value === "string")
    : [];
  const n = generateBarrels(dirs.length ? { dirs } : undefined);
  logger.success(
    n === 0 ? "barrels already up to date" : `updated ${stringUtils.pluralize(n, "barrel")}`,
  );
}
