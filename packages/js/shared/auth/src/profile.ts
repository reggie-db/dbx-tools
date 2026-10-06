/**
 * Browser-safe Databricks profile-selector contracts.
 *
 * @module
 */

import { options } from "@dbx-tools/shared-core";
import { z } from "zod";

import { authTypeSchema, targetKindSchema } from "./config-schema.ts";

export const databricksProfileSummarySchema = z
  .object({
    name: z.string().min(1).describe("Profile name from the Databricks CLI configuration."),
    host: options.normalizedUrlSchema.optional().describe("Workspace or account host URL."),
    accountId: z
      .string()
      .min(1)
      .optional()
      .describe("Account id when the profile targets an account."),
    workspaceId: z
      .string()
      .min(1)
      .optional()
      .describe("Workspace id when the profile targets a workspace."),
    target: targetKindSchema.describe(
      "Whether this profile authenticates a workspace, account, or unified host.",
    ),
    authType: authTypeSchema.describe("Credential kind used by this profile."),
    principal: z.string().min(1).describe("Secret-free principal label suitable for selectors."),
  })
  .describe("Secret-free Databricks profile metadata.");

export type DatabricksProfileSummary = z.infer<typeof databricksProfileSummarySchema>;

export const databricksProfileListSchema = z
  .array(databricksProfileSummarySchema)
  .describe("List of secret-free Databricks profiles.");

export type DatabricksProfileList = z.infer<typeof databricksProfileListSchema>;

export const databricksProfileSelectionSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("ambient") }),
    z.object({
      kind: z.literal("profile"),
      profile: z.string().trim().min(1).describe("Named Databricks CLI profile to use."),
    }),
  ])
  .describe("Ambient or named-profile selector value.");

export type DatabricksProfileSelection = z.infer<typeof databricksProfileSelectionSchema>;
