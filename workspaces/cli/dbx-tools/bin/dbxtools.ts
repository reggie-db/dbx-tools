#!/usr/bin/env -S npx tsx
/**
 * `dbxtools` - the single CLI for the toolchain (commander). Invoked as a bin
 * (`dbxtools <cmd>`) and by the generated `sync` task, which runs
 * `pnpm dbxtools sync` with receiveArgs - so `pnpm exec projen sync --watch`
 * forwards `--watch` and starts the single watcher.
 *
 *   sync [--watch]  bootstrap an empty folder, or re-synthesize an existing
 *                   workspace (runs projen; barrels regenerate). With --watch,
 *                   keep it in sync while editing afterward: re-synth on
 *                   `.projenrc.ts` or package add/remove, rebuild barrels on
 *                   source edits.
 *   barrels         regenerate every package's root index.ts barrel.
 *   openapi         generate the openapi packages from tsoa controllers.
 *   clean [-y]      remove generated files (projen config + barrels) and every
 *                   node_modules dir; interactive picker (all preselected) unless
 *                   -y/--yes. Removing node_modules needs a `pnpm install` after.
 *
 * Type-checking is projen's own per-package `compile` task (`tsc --build` against
 * each package's tag tsconfig, which is what enforces the tags) - not a dbxtools
 * command; run it per package or across the workspace with `pnpm -r compile`.
 *
 * `bootstrap`, `watch`, `openapi`, and `clean`'s picker (`@clack/prompts`) are
 * imported lazily so a plain `sync`/`barrels` don't pull their heavier deps
 * (chokidar, openapi-typescript, clack) unless actually used.
 */
import { Command } from "commander";
import { logger } from "../src/log";
import { generateBarrels } from "../src/projen/barrels";
import { runSynth } from "../src/projen/scaffold";

const program = new Command();
program.name("dbxtools").description("dbx-tools monorepo toolchain");

program
  .command("sync")
  .description("bootstrap or re-synthesize the workspace; --watch keeps it in sync while editing")
  .option(
    "--watch",
    "after syncing, watch: re-synth on .projenrc.ts/package changes, rebuild barrels on source edits",
  )
  .action(async (opts: { watch?: boolean }) => {
    const log = logger.withTag("projen:sync");
    const { needsBootstrap, bootstrapWorkspace } = await import("../src/projen/bootstrap");
    if (needsBootstrap()) {
      bootstrapWorkspace();
    } else {
      log.start("synthesizing");
      runSynth({ post: true }); // full projen: installs + regenerates barrels (post-synth)
      log.success("synced");
    }
    if (opts.watch) {
      const { startWatch } = await import("../src/projen/watch");
      startWatch();
    }
  });

program
  .command("barrels")
  .description("regenerate every package's root index.ts barrel")
  .action(() => {
    const log = logger.withTag("projen:barrels");
    const n = generateBarrels();
    log.success(
      n === 0 ? "barrels already up to date" : `updated ${n} barrel${n === 1 ? "" : "s"}`,
    );
  });

program
  .command("openapi")
  .description("generate the openapi client packages from server/node tsoa controllers")
  .action(async () => {
    const { generateOpenapi } = await import("../src/projen/openapi");
    const dirs = await generateOpenapi();
    if (dirs.length > 0) runSynth({ post: true });
  });

program
  .command("clean")
  .description(
    "remove generated files (projen config + barrels) and node_modules; interactive picker, all preselected",
  )
  .option("-y, --yes", "remove every generated file and node_modules dir without prompting")
  .action(async (opts: { yes?: boolean }) => {
    const log = logger.withTag("projen:clean");
    const { listGeneratedFiles, listNodeModulesDirs, removePaths } =
      await import("../src/projen/clean");
    const files = listGeneratedFiles();
    const nodeModules = listNodeModulesDirs();
    const targets = [...files, ...nodeModules];
    if (targets.length === 0) {
      log.success("nothing to remove (no generated files or node_modules)");
      return;
    }

    // Removing node_modules takes the engine's own deps with it, so a re-synth can't
    // run until dependencies are reinstalled - guide accordingly.
    const regenHint = (removedNodeModules: boolean): string =>
      removedNodeModules
        ? "reinstall with `pnpm install`, then `pnpm exec projen`"
        : "regenerate with `pnpm exec projen`";

    // Non-interactive escape hatch: delete the whole set, no prompt.
    if (opts.yes) {
      const n = removePaths(targets);
      log.success(
        `removed ${n} path${n === 1 ? "" : "s"} (${files.length} generated + ${nodeModules.length} node_modules) - ${regenHint(nodeModules.length > 0)}`,
      );
      return;
    }

    // The picker needs a TTY; in a piped/CI shell, guide to -y instead of hanging.
    if (!process.stdin.isTTY) {
      log.warn(
        `non-interactive shell: re-run with -y to remove all ${targets.length} paths (${files.length} generated + ${nodeModules.length} node_modules), or run in a terminal to pick`,
      );
      return;
    }

    const { relative } = await import("node:path");
    const { repoRoot, toPosix } = await import("../src/projen/workspace");
    const clack = await import("@clack/prompts");
    clack.intro("dbxtools clean");
    const label = (f: string): string => toPosix(relative(repoRoot, f));
    const picked = await clack.multiselect<string>({
      message: `Select paths to remove (${files.length} generated + ${nodeModules.length} node_modules, all preselected)`,
      options: [
        ...files.map((f) => ({ value: f, label: label(f) })),
        ...nodeModules.map((d) => ({
          value: d,
          label: `${label(d)} (directory)`,
        })),
      ],
      initialValues: [...targets],
      required: false,
    });
    if (clack.isCancel(picked)) {
      clack.cancel("clean cancelled - nothing removed");
      return;
    }
    if (picked.length === 0) {
      clack.outro("nothing selected - nothing removed");
      return;
    }
    const removedNodeModules = picked.some((p) => nodeModules.includes(p));
    const n = removePaths(picked);
    clack.outro(`removed ${n} path${n === 1 ? "" : "s"} - ${regenHint(removedNodeModules)}`);
  });

program.parseAsync();
