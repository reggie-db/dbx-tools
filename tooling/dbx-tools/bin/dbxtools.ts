#!/usr/bin/env -S npx tsx
/**
 * `dbxtools` - the single CLI for the toolchain (commander). Invoked as a bin
 * (`dbxtools <cmd>`) and by the projen `watch` task (`onchange … -- tsx …/dbxtools.ts sync`).
 */
import { Command } from "commander";
import { generateBarrels } from "../src/barrels";
import { logger } from "../src/log";
import { generateOpenapi } from "../src/openapi";
import { packageSetChanged, runSynth } from "../src/scaffold";
import { typecheckAll } from "../src/typecheck";

const program = new Command();
program.name("dbxtools").description("dbx-tools monorepo toolchain");

program
  .command("sync")
  .description("re-synth if the package set changed, then rebuild barrels (watch loop step)")
  .action(() => {
    const log = logger.withTag("projen:sync");
    if (packageSetChanged()) {
      log.start("package set changed - re-synthesizing");
      runSynth();
    }
    const n = generateBarrels();
    log.success(`synced (${n} barrel${n === 1 ? "" : "s"})`);
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
  .command("scaffold")
  .description("re-synthesize to configure any new packages/<scope>/<name>/src folder")
  .action(() => {
    const log = logger.withTag("projen:scaffold");
    log.start("synthesizing …");
    runSynth();
    log.success("done; run `pnpm install` to link any new workspace dependencies");
  });

program
  .command("typecheck")
  .description("type-check every package against its own scope tsconfig")
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
  .description("generate the openapi scope from server @openapi annotations")
  .action(async () => {
    const dirs = await generateOpenapi();
    if (dirs.length > 0) {
      runSynth();
      generateBarrels({ dirs });
    }
  });

program.parse();
