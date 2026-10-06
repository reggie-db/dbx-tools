import { authTypeSchema, targetKindSchema } from "@dbx-tools/shared-auth/config-schema";
import { options } from "@dbx-tools/shared-core";
import { z } from "zod";

const text = (description: string) => z.string().trim().min(1).optional().describe(description);
const safeInteger = (description: string) =>
  z.coerce.number<number>().int().safe().describe(description);

export const AuthOptionsSchema = z
  .object({
    refreshBufferMs: safeInteger("Token refresh buffer in milliseconds.").default(300_000),
    lockTimeoutMs: safeInteger("Credential lock timeout in milliseconds.").nonnegative().default(0),
    loginTimeoutMs: safeInteger("Browser login timeout in milliseconds.")
      .nonnegative()
      .default(900_000),
  })
  .strict()
  .describe("Token lifecycle timing configuration.");

/** Token lifecycle timing configuration in milliseconds. */
export interface AuthOptions extends z.input<typeof AuthOptionsSchema> {}

export const DatabricksAuthOptionsSchema = z
  .object({
    profile: options.DatabricksOptionsSchema.shape.profile,
    host: options.DatabricksOptionsSchema.shape.host,
    accountId: options.DatabricksOptionsSchema.shape.accountId,
    workspaceId: options.DatabricksOptionsSchema.shape.workspaceId,
    configFile: options.DatabricksOptionsSchema.shape.configFile,
    clientId: options.DatabricksOptionsSchema.shape.clientId,
    clientSecret: options.DatabricksOptionsSchema.shape.clientSecret,
    accessToken: options.DatabricksOptionsSchema.shape.accessToken,
    groupId: options.DatabricksOptionsSchema.shape.groupId,
    authType: authTypeSchema.optional().describe("Databricks authentication type."),
    scopes: z.array(z.string().trim().min(1)).optional().describe("OAuth scopes."),
    target: targetKindSchema.optional().describe("OAuth target."),
    auth: AuthOptionsSchema.partial().optional().describe("Token lifecycle overrides."),
    requestHeaders: z
      .record(z.string(), z.string())
      .optional()
      .describe("Additional authentication request headers."),
    accessTokenHeader: text("Request header carrying a bearer access token."),
    preferUserToMachine: z
      .boolean()
      .optional()
      .describe("Prefer a matching user profile over selected machine credentials."),
  })
  .strict()
  .describe("Databricks profile and credential-source options.");

/** Databricks profile and credential-source options. */
export interface DatabricksAuthOptions extends Omit<
  z.input<typeof DatabricksAuthOptionsSchema>,
  "auth"
> {
  auth?: AuthOptions;
}

/** Default token refresh, lock, and interactive login timing values. */
export const AUTH_DEFAULTS = Object.freeze(AuthOptionsSchema.parse({}));

/** OAuth client used by Databricks CLI-compatible user authentication. */
export const DEFAULT_CLIENT_ID = "databricks-cli";
/** Default Databricks profile configuration path. */
export const DEFAULT_CONFIG_FILE = "~/.databrickscfg";
/** Request header carrying a bearer access token. */
export const DEFAULT_ACCESS_TOKEN_HEADER = "authorization";
/** Request header carrying the resolved Databricks workspace ID. */
export const WORKSPACE_ID_HEADER = "x-databricks-workspace-id";
