/**
 * Browser-safe Databricks authentication status contracts.
 *
 * @module
 */

import { z } from "zod";

import { authTypeSchema, targetKindSchema } from "./config-schema.ts";

/** Resolved secret-free Databricks authentication client fields. */
export const databricksAuthClientInfoSchema = z.object({
  profile: z.string().min(1).optional(),
  host: z.string().url(),
  accountId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  target: targetKindSchema,
  authType: authTypeSchema,
  principal: z.string().min(1),
});
/** Resolved secret-free Databricks authentication client fields. */
export type DatabricksAuthClientInfo = z.infer<typeof databricksAuthClientInfoSchema>;
