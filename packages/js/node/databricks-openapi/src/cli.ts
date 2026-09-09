import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "@dbx-tools/shared-core";

import { generateDatabricksOpenapi } from "./generator.ts";

const logger = log.logger("databricks-openapi");

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

/** Run one configured generation pass. */
export async function main(): Promise<void> {
  const outputs = await generateDatabricksOpenapi();
  logger.info("generated Databricks OpenAPI packages", { count: outputs.length });
}

if (isMainModule()) {
  await main();
}
