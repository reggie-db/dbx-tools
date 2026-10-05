/**
 * Browser-safe Databricks authentication configuration values.
 *
 * @module
 */

/** Canonical Databricks authentication type values. */
export const AuthType = {
  DatabricksCli: "databricks-cli",
  OAuthM2M: "oauth-m2m",
  PersonalAccessToken: "pat",
  AppOnBehalfOf: "app_obo",
  AppServicePrincipal: "app_sp",
} as const;
export type AuthType = (typeof AuthType)[keyof typeof AuthType];

/** Scope of a Databricks authentication target. */
export const TargetKind = {
  Workspace: "workspace",
  Account: "account",
  Unified: "unified",
} as const;
export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];
