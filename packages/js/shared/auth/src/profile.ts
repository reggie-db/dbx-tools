/**
 * Browser-safe Databricks profile-selector contracts.
 *
 * @module
 */

import { z } from "zod";

import { authTypeSchema, targetKindSchema } from "./config-schema.ts";

/** Secret-free Databricks profile metadata for profile selectors. */
export const databricksProfileSummarySchema = z.object({
  name: z.string().min(1),
  host: z.string().url().optional(),
  accountId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  target: targetKindSchema,
  authType: authTypeSchema,
  principal: z.string().min(1),
});
/** Secret-free Databricks profile metadata. */
export type DatabricksProfileSummary = z.infer<typeof databricksProfileSummarySchema>;

/** Browser-safe list of configured Databricks profiles. */
export const databricksProfileListSchema = z.array(databricksProfileSummarySchema);
/** List of secret-free Databricks profiles. */
export type DatabricksProfileList = z.infer<typeof databricksProfileListSchema>;

/** Profile-selector value for ambient or named-profile authentication. */
export const databricksProfileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ambient") }),
  z.object({
    kind: z.literal("profile"),
    profile: z.string().trim().min(1),
  }),
]);
/** Ambient or named-profile selector value. */
export type DatabricksProfileSelection = z.infer<typeof databricksProfileSelectionSchema>;
