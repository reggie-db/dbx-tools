import type { DatabricksProfileSummary } from "@dbx-tools/shared-auth/profile";

import { AuthError } from "./_errors.ts";
import { listDatabricksProfiles, resolveDatabricksProfile } from "./_profile-config.ts";
import type { DatabricksProfile } from "./_types.ts";
import type { DatabricksAuthOptions } from "./config.ts";

/** Profile-listing controls. */
export interface ListProfilesOptions {
  configFile?: string;
  refresh?: boolean;
}

/** Resolve one configured profile without exposing credentials, or `null` when none exists. */
export function resolveProfile(
  options: DatabricksAuthOptions = {},
): DatabricksProfileSummary | null {
  const configured = listDatabricksProfiles(options.configFile);
  if (configured.length === 0) return null;
  const environment = options.configFile
    ? { DATABRICKS_CONFIG_FILE: options.configFile }
    : process.env;
  try {
    const resolved = resolveDatabricksProfile(options, environment);
    if (
      !resolved.selectedProfile ||
      !configured.some(({ name }) => name === resolved.selectedProfile)
    ) {
      return null;
    }
    return toProfileSummary(resolved);
  } catch (error) {
    if (error instanceof AuthError && error.kind === "config") return null;
    throw error;
  }
}

/** List configured profiles without exposing credentials. */
export function listProfiles(options: ListProfilesOptions = {}): DatabricksProfileSummary[] {
  return listDatabricksProfiles(options.configFile, options.refresh);
}

function toProfileSummary(profile: DatabricksProfile): DatabricksProfileSummary {
  return {
    name: profile.name,
    host: profile.host,
    ...(profile.accountId ? { accountId: profile.accountId } : {}),
    ...(profile.workspaceId ? { workspaceId: profile.workspaceId } : {}),
    target: profile.target,
    authType: profile.authType,
    principal: profile.principal,
  };
}
