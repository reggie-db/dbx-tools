#!/usr/bin/env -S npx tsx
/**
 * `dbxtools` - the single CLI for the toolchain (commander). Invoked as a bin
 * (`dbxtools <cmd>`) and by the generated `sync` task, which runs
 * `pnpm dbxtools watch` alongside `projen --watch` (via concurrently).
 *
 *   sync            bootstrap an empty folder, or re-synthesize an existing
 *                   workspace (runs projen; barrels regenerate).
 *   watch           keep it in sync while editing: re-synth on package add/remove,
 *                   rebuild barrels on source edits (runs beside `projen --watch`,
 *                   which owns `.projenrc.ts` re-synth).
 *   barrels         regenerate every package's root index.ts barrel.
 *   typecheck       type-check every package against its own tag tsconfig.
 *   openapi         generate the openapi packages from tsoa controllers.
 *
 * `bootstrap`, `watch`, and `openapi` are imported lazily so `sync`/`barrels`/
 * `typecheck` don't require their heavier deps (chokidar, openapi-typescript) to
 * be installed.
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
  .description("bootstrap an empty folder, or re-synthesize the workspace (one-shot)")
  .action(async () => {
    const log = logger.withTag("projen:sync");
    const { needsBootstrap, bootstrapWorkspace } = await import("../src/projen/bootstrap");
    if (needsBootstrap()) {
      bootstrapWorkspace();
    } else {
      log.start("synthesizing");
      runSynth({ post: true }); // full projen: installs + regenerates barrels (post-synth)
      log.success("synced");
    }
  });

program
  .command("watch")
  .description("watch: re-synth on package add/remove, rebuild barrels on source edits")
  .action(async () => {
    const { startWatch } = await import("../src/projen/watch");
    startWatch();
  });

program
  .command("barrels")
  .description("regenerate every package's root index.ts barrel")
  .action(() => {
    const log = logger.withTag("projen:barrels");
    const n = generateBarrels();
    log.success(`generated ${n} barrel${n === 1 ? "" : "s"}`);
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

program.parseAsync();
