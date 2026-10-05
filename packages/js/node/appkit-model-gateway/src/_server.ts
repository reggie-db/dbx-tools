/**
 * Standalone AppKit model-gateway server.
 *
 * @module
 */

import { startModelGateway } from "./server.ts";

process.env.DATABRICKS_APP_PORT ??= "4400";
process.env.LOG_LEVEL ??= "debug";

await startModelGateway({
  port: Number(process.env.DATABRICKS_APP_PORT),
});
