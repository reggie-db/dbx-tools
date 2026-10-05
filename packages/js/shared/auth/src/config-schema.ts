/**
 * Browser-safe schemas for Databricks authentication configuration values.
 *
 * @module
 */

import { z } from "zod";

import { AuthType, TargetKind } from "./config.ts";

/** Runtime schema for Databricks authentication type values. */
export const authTypeSchema = z.enum([
  AuthType.DatabricksCli,
  AuthType.OAuthM2M,
  AuthType.PersonalAccessToken,
  AuthType.AppOnBehalfOf,
  AuthType.AppServicePrincipal,
]);

/** Runtime schema for Databricks authentication target values. */
export const targetKindSchema = z.enum([
  TargetKind.Workspace,
  TargetKind.Account,
  TargetKind.Unified,
]);
