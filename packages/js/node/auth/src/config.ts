import type { AuthType, TargetKind } from "@dbx-tools/shared-auth/config";

/** Token lifecycle timing configuration in milliseconds. */
export interface AuthOptions {
  refreshBufferMs?: number;
  lockTimeoutMs?: number;
  loginTimeoutMs?: number;
}

/** Default token refresh, lock, and interactive login timing values. */
export const AUTH_DEFAULTS: Required<AuthOptions> = {
  refreshBufferMs: 300_000,
  lockTimeoutMs: 0,
  loginTimeoutMs: 900_000,
};

/** Databricks profile and credential-source options. */
export interface DatabricksAuthOptions {
  profile?: string;
  host?: string;
  accountId?: string;
  workspaceId?: string;
  configFile?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  groupId?: string;
  authType?: AuthType;
  scopes?: string[];
  target?: TargetKind;
  auth?: AuthOptions;
  requestHeaders?: Record<string, string>;
  accessTokenHeader?: string;
  preferUserToMachine?: boolean;
}

/** OAuth client used by Databricks CLI-compatible user authentication. */
export const DEFAULT_CLIENT_ID = "databricks-cli";
/** Default Databricks profile configuration path. */
export const DEFAULT_CONFIG_FILE = "~/.databrickscfg";
/** Request header carrying a bearer access token. */
export const DEFAULT_ACCESS_TOKEN_HEADER = "authorization";
/** Request header carrying the resolved Databricks workspace ID. */
export const WORKSPACE_ID_HEADER = "x-databricks-workspace-id";
