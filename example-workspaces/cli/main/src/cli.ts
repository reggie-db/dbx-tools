#!/usr/bin/env -S npx tsx
import { fileURLToPath } from "node:url";
import { intro, outro } from "@clack/prompts";
import { add } from "@dbx-tools/shared-core";
import { Command } from "commander";

/**
 * Sum the numeric CLI args and print the total. Exercises the two deps the
 * `cli` scope profile injects automatically: commander (arg parsing) and
 * @clack/prompts (here just the non-interactive intro/outro banners).
 */
export function run(argv: string[] = process.argv.slice(2)): number {
  let total = 0;
  new Command()
    .name("pw-demo")
    .description("sum numbers")
    .argument("[numbers...]", "numbers to add")
    .action((numbers: string[]) => {
      total = numbers.map(Number).reduce((sum, n) => add(sum, n), 0);
    })
    .parse(argv, { from: "user" });

  intro("pw-demo");
  outro(`sum = ${total}`);
  return total;
}

// Only auto-run when executed as the bin - not when imported via the barrel.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
