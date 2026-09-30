import { Command } from "commander";
import { generateBarrels } from "./barrels.ts";

const program = new Command()
  .option("--check", "fail on stale barrels without writing")
  .option("--dir <paths...>", "explicit package directories")
  .parse();
const options = program.opts<{ check?: boolean; dir?: string[] }>();
const changed = generateBarrels({ dirs: options.dir, check: options.check });
console.log(`${changed} barrels updated`);
