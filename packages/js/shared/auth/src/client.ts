/**
 * Browser-safe Databricks authentication status contracts.
 *
 * @module
 */

import { options } from "@dbx-tools/shared-core";
import { z } from "zod";

import { authTypeSchema, targetKindSchema } from "./config-schema.ts";

/** Authentication source supplied by a Databricks Python runtime. */
export const RUNTIME_AUTH_TYPE = "runtime" as const;

/** Resolved secret-free Databricks authentication client fields. */
export const databricksAuthClientInfoSchema = z.object({
  profile: z.string().min(1).optional(),
  host: options.normalizedUrlSchema,
  accountId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  target: targetKindSchema,
  authType: authTypeSchema.or(z.literal(RUNTIME_AUTH_TYPE)),
  principal: z.string().min(1),
});
/** Resolved secret-free Databricks authentication client fields. */
export type DatabricksAuthClientInfo = z.infer<typeof databricksAuthClientInfoSchema>;
