#!/usr/bin/env -S bun
/** Generate package barrels for the workspace or selected package directories. */
import { log, pluralize } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain } from "./cli.ts";
import { generateBarrels } from "../src/barrels.ts";

const logger = log.logger("projen:barrels");

export const BarrelsOptionsSchema = z
  .object({
    dir: z
      .array(z.string().trim().min(1))
      .default([])
      .describe("Repeatable package directory to rebuild"),
  })
  .describe("Generate package barrels");

export const main = await runTaskMain(import.meta, BarrelsOptionsSchema, ({ dir }) => {
  const n = generateBarrels(dir.length ? { dirs: dir } : undefined);
  logger.success(n === 0 ? "barrels already up to date" : `updated ${pluralize(n, "barrel")}`);
});
