/**
 * Browser-safe schemas for Databricks authentication configuration values.
 *
 * @module
 */

import { databricksEnvironmentNames } from "@dbx-tools/shared-core";
import { z } from "zod";

import { AuthType, TargetKind } from "./config.ts";

export const authTypeSchema = z
  .enum(AuthType)
  .meta({ env: databricksEnvironmentNames.authType, flag: false })
  .describe("Databricks authentication type values.");

export const targetKindSchema = z
  .enum(TargetKind)
  .describe("Databricks authentication target values.");
