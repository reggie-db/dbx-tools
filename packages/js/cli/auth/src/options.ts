/**
 * Databricks auth command-line option schemas and runtime projection.
 *
 * @module
 */

import {
  AuthOptionsSchema,
  DatabricksAuthOptionsSchema,
  type DatabricksAuthOptions,
} from "@dbx-tools/auth/config";
import { stringUtils } from "@dbx-tools/shared-core";
import { z } from "zod";

export const AuthCliOptionsSchema = z
  .object({
    profile: DatabricksAuthOptionsSchema.shape.profile,
    host: DatabricksAuthOptionsSchema.shape.host,
    accountId: DatabricksAuthOptionsSchema.shape.accountId,
    workspaceId: DatabricksAuthOptionsSchema.shape.workspaceId,
    configFile: DatabricksAuthOptionsSchema.shape.configFile,
    clientId: DatabricksAuthOptionsSchema.shape.clientId,
    groupId: DatabricksAuthOptionsSchema.shape.groupId,
    authType: DatabricksAuthOptionsSchema.shape.authType,
    scopes: z
      .preprocess(
        (value) =>
          Array.isArray(value)
            ? value.flatMap((entry) => stringUtils.parseList(String(entry)))
            : value,
        z.array(z.string().trim().min(1)),
      )
      .default([])
      .describe("OAuth scopes."),
    target: DatabricksAuthOptionsSchema.shape.target,
    lockTimeoutMs: AuthOptionsSchema.shape.lockTimeoutMs,
    loginTimeoutMs: AuthOptionsSchema.shape.loginTimeoutMs,
    refreshBufferMs: AuthOptionsSchema.shape.refreshBufferMs,
    preferUserToMachine: z
      .boolean()
      .default(true)
      .describe("Prefer a matching user profile over selected machine credentials."),
  })
  .strict()
  .describe("Options shared by every Databricks auth command.");

export const TokenCommandOptionsSchema = z
  .object({
    forceRefresh: z.boolean().default(false).describe("Refresh the token before returning it."),
    login: z.boolean().default(true).describe("Log in when credentials are missing or invalid."),
  })
  .strict()
  .describe("Options for returning a Databricks access token.");

export type AuthCliOptions = z.output<typeof AuthCliOptionsSchema>;

export type TokenCommandOptions = z.output<typeof TokenCommandOptionsSchema>;

/** Convert flat CLI fields into the Node auth package's nested options. */
export function databricksAuthOptions(options: AuthCliOptions): DatabricksAuthOptions {
  return {
    profile: options.profile,
    host: options.host,
    accountId: options.accountId,
    workspaceId: options.workspaceId,
    configFile: options.configFile,
    clientId: options.clientId,
    groupId: options.groupId,
    authType: options.authType,
    scopes: options.scopes.length > 0 ? options.scopes : undefined,
    target: options.target,
    auth: {
      lockTimeoutMs: options.lockTimeoutMs,
      loginTimeoutMs: options.loginTimeoutMs,
      refreshBufferMs: options.refreshBufferMs,
    },
    preferUserToMachine: options.preferUserToMachine,
  };
}
