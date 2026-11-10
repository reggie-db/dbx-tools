/**
 * Browser-safe Databricks authentication status contracts.
 *
 * @module
 */

import { normalizedUrlSchema } from "@dbx-tools/shared-core";
import { z } from "zod";

import { authTypeSchema } from "./config-schema.ts";
import { databricksProfileSummarySchema } from "./profile.ts";

/** Authentication source supplied by a Databricks Python runtime. */
export const RUNTIME_AUTH_TYPE = "runtime" as const;

/** Resolved secret-free Databricks authentication client fields. */
export const databricksAuthClientInfoSchema = databricksProfileSummarySchema
  .omit({ name: true })
  .extend({
    profile: databricksProfileSummarySchema.shape.name
      .optional()
      .describe("Selected Databricks CLI profile, when explicitly configured."),
    host: normalizedUrlSchema.describe("Resolved workspace or account host URL."),
    authType: authTypeSchema
      .or(z.literal(RUNTIME_AUTH_TYPE))
      .describe("Resolved credential kind, including injected Python-runtime authentication."),
  })
  .describe("Resolved secret-free Databricks authentication client fields.");
/** Resolved secret-free Databricks authentication client fields. */
export type DatabricksAuthClientInfo = z.infer<typeof databricksAuthClientInfoSchema>;
