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
 *   typecheck       type-check every package against its own tag tsconfig.
 *   openapi         generate the openapi packages from tsoa controllers.
 *   clean [-y]      remove generated files (projen config + barrels); an
 *                   interactive picker (all preselected) unless -y/--yes.
 *
 * `bootstrap`, `watch`, `openapi`, and `clean`'s picker (`@clack/prompts`) are
 * imported lazily so a plain `sync`/`barrels`/`typecheck` don't pull their heavier
 * deps (chokidar, openapi-typescript, clack) unless actually used.
 */
import { Command } from "commander";
import { logger } from "../src/log";
import { generateBarrels } from "../src/projen/barrels";
import { runSynth } from "../src/projen/scaffold";
import { typecheckAll } from "../src/projen/typecheck";

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
    log.success(n === 0 ? "barrels already up to date" : `updated ${n} barrel${n === 1 ? "" : "s"}`);
  });

program
  .command("typecheck")
  .description("type-check every package against its own tag tsconfig")
  .action(() => {
    const log = logger.withTag("projen:typecheck");
    const failures = typecheckAll();
    if (failures > 0) {
      log.error(`${failures} package(s) failed type-check`);
      process.exit(1);
    }
    log.success("all packages type-check");
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
  .description("remove generated files (projen config + barrels); interactive picker, all preselected")
  .option("-y, --yes", "remove every detected generated file without prompting")
  .action(async (opts: { yes?: boolean }) => {
    const log = logger.withTag("projen:clean");
    const { listGeneratedFiles, removeFiles } = await import("../src/projen/clean");
    const files = listGeneratedFiles();
    if (files.length === 0) {
      log.success("no generated files to remove");
      return;
    }

    // Non-interactive escape hatch (CI / non-TTY): delete the whole set, no prompt.
    if (opts.yes) {
      const n = removeFiles(files);
      log.success(`removed ${n} generated file${n === 1 ? "" : "s"} - run \`pnpm exec projen\` to regenerate`);
      return;
    }

    const { relative } = await import("node:path");
    const { repoRoot, toPosix } = await import("../src/projen/workspace");
    const clack = await import("@clack/prompts");
    clack.intro("dbxtools clean");
    const picked = await clack.multiselect<string>({
      message: `Select generated files to remove (${files.length} found, all preselected)`,
      options: files.map((f) => ({ value: f, label: toPosix(relative(repoRoot, f)) })),
      initialValues: [...files],
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
    const n = removeFiles(picked);
    clack.outro(`removed ${n} file${n === 1 ? "" : "s"} - regenerate with \`npx tsx .projenrc.ts\``);
  });

program.parseAsync();
