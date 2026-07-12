#!/usr/bin/env -S npx tsx
/**
 * `dbxtools` - the single CLI entry point for the workspace toolchain, built on
 * commander. The projen tasks invoke it as `tsx .../bin/dbxtools.ts <command>`;
 * when the package is installed it is also exposed as the `dbxtools` bin.
 */
import { Command } from "commander";
import { generateBarrels } from "../src/barrels";
import { logger } from "../src/log";
import { generateOpenapi } from "../src/openapi";
import { runSynth } from "../src/scaffold";
import { typecheckAll } from "../src/typecheck";
import { startWatch } from "../src/watch";

const program = new Command();
program.name("dbxtools").description("projen-workspace dev toolchain");

program
  .command("watch")
  .description("watch packages/*: barrels + scaffold + openapi on change")
  .action(async () => {
    await startWatch();
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
  .description("re-synthesize to configure any new packages/<scope>/<name>/src")
  .action(() => {
    const log = logger.withTag("projen:scaffold");
    log.start("synthesizing - discovers packages/<scope>/<name>/src folders …");
    runSynth();
    log.success("done; run `pnpm install` to link any new workspace dependencies");
  });

program
  .command("openapi")
  .description("generate the openapi scope from server @openapi annotations")
  .action(async () => {
    const dirs = await generateOpenapi();
    if (dirs.length > 0) {
      runSynth();
      generateBarrels({ dirs });
      logger.withTag("projen:openapi").success("done; run `pnpm install` to link the client");
    }
  });

program
  .command("typecheck")
  .description("type-check every package against its own profile tsconfig")
  .action(() => {
    const log = logger.withTag("projen:typecheck");
    const failures = typecheckAll();
    if (failures > 0) {
      log.error(`${failures} package(s) failed type-check`);
      process.exit(1);
    }
    log.success("all packages type-check");
  });

program.parse();
