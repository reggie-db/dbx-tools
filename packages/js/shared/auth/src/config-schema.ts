/**
 * Browser-safe schemas for Databricks authentication configuration values.
 *
 * @module
 */

import { z } from "zod";
import { options } from "@dbx-tools/shared-core";

import { AuthType, TargetKind } from "./config.ts";

export const authTypeSchema = z
  .enum([
    AuthType.DatabricksCli,
    AuthType.OAuthM2M,
    AuthType.PersonalAccessToken,
    AuthType.AppOnBehalfOf,
    AuthType.AppServicePrincipal,
  ])
  .meta({ env: options.databricksEnvironmentNames.authType, flag: false })
  .describe("Databricks authentication type values.");

export const targetKindSchema = z
  .enum([TargetKind.Workspace, TargetKind.Account, TargetKind.Unified])
  .describe("Databricks authentication target values.");
