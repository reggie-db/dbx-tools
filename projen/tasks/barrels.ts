#!/usr/bin/env -S bun
/** Generate package barrels once or keep affected barrels current in watch mode. */
import { relative } from "node:path";
import { relativePathWithin } from "@dbx-tools/core";
import { log, pluralize } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions } from "./cli.ts";
import { TaskDirectoriesOptionSchema, TaskWatchOptionSchema } from "./options.ts";
import { generateBarrels } from "../src/barrels.ts";
import { packageDirOfModule, recordedPackages, repoRoot, toPosix } from "../src/packages.ts";
import { watchLoop, watchRoots } from "../src/watch.ts";

const logger = log.logger("projen:barrels");

/** The recorded package dir that owns `abs`, if any (for a targeted barrel rebuild). */
function ownerPackageDir(
  abs: string,
  packages: readonly { readonly dir: string }[],
): string | undefined {
  return packages.find(({ dir }) => relativePathWithin(dir, abs) !== undefined)?.dir;
}

/** Planned watcher work after separating owned, newly discoverable, and irrelevant paths. */
export interface BarrelChangePlan {
  /** Recorded package directories whose barrels may need regeneration. */
  readonly targets: string[];
  /** Unrecorded package directories inferred from changed source modules. */
  readonly unrecordedPackages: string[];
  /** Changed paths that cannot affect a recorded or newly discoverable package barrel. */
  readonly ignored: string[];
}

/** Package directory implied by a changed module beneath one watched root's `src/`. */
function unrecordedPackageDir(path: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const owner = packageDirOfModule(root, path);
    if (owner) return owner;
  }
  return undefined;
}

/** Classify one debounced watcher batch without treating every unowned path as a package. */
export function planBarrelChanges(
  changed: readonly string[],
  packages: readonly { readonly dir: string }[],
  roots: readonly string[],
): BarrelChangePlan {
  const targets = new Set<string>();
  const unrecordedPackages = new Set<string>();
  const ignored: string[] = [];
  for (const path of changed) {
    const owner = ownerPackageDir(path, packages);
    if (owner) {
      targets.add(owner);
      continue;
    }
    const unrecorded = unrecordedPackageDir(path, roots);
    if (unrecorded) unrecordedPackages.add(unrecorded);
    else ignored.push(path);
  }
  return {
    targets: [...targets],
    unrecordedPackages: [...unrecordedPackages],
    ignored,
  };
}

function displayPaths(paths: readonly string[]): string[] {
  return paths.map((path) => toPosix(relative(repoRoot, path) || "."));
}

function reportUnownedChanges(plan: BarrelChangePlan): void {
  if (plan.unrecordedPackages.length) {
    logger.warn(
      `detected ${pluralize(plan.unrecordedPackages.length, "unrecorded package")}: ` +
        `${displayPaths(plan.unrecordedPackages).join(", ")}; ` +
        "run `bun run default` (or touch .projenrc.ts) to refresh workspace metadata",
    );
  }
  if (plan.ignored.length) {
    logger.debug("ignored barrel-irrelevant changes outside recorded packages", {
      paths: displayPaths(plan.ignored),
    });
  }
}

export const BarrelsOptionsSchema = z.object({
  watch: TaskWatchOptionSchema,
  dir: TaskDirectoriesOptionSchema.describe("Repeatable package directory to rebuild"),
});

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const values = await taskOptions(
    taskCommand(
      import.meta.url,
      "Generate package barrels once or keep them current",
      BarrelsOptionsSchema,
    ),
    BarrelsOptionsSchema,
    args,
  );

  if (values.watch) {
    let prepared: BarrelChangePlan | undefined;
    // Watch the package roots; a source edit inside a package rebuilds just that
    // package's `index.ts` barrel (no re-synth - the projenrc watcher owns that).
    // watchLoop already drops generated paths, so a barrel write never re-triggers us.
    await watchLoop(
      "barrels",
      watchRoots(),
      (changed) => {
        const plan = prepared ?? planBarrelChanges(changed, recordedPackages(), watchRoots());
        prepared = undefined;
        const n = generateBarrels({ dirs: plan.targets });
        if (n) logger.success(`rebuilt ${pluralize(n, "barrel")}`);
      },
      {
        check: (changed) => {
          prepared = planBarrelChanges(changed, recordedPackages(), watchRoots());
          reportUnownedChanges(prepared);
          return prepared.targets.length > 0;
        },
      },
    );
  } else {
    const dirs = values.dir;
    const n = generateBarrels(dirs.length ? { dirs } : undefined);
    logger.success(n === 0 ? "barrels already up to date" : `updated ${pluralize(n, "barrel")}`);
  }
}

await runTaskMain(import.meta, main);
