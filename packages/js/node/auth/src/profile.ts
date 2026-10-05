import type { DatabricksProfileSummary } from "@dbx-tools/shared-auth/profile";

import { listDatabricksProfiles, resolveDatabricksProfile } from "./_profile-config.ts";
import type { DatabricksProfile } from "./_types.ts";
import type { DatabricksAuthOptions } from "./config.ts";

/** Profile-listing controls. */
export interface ListProfilesOptions {
  configFile?: string;
  refresh?: boolean;
}

/** Resolve one selected profile without exposing credentials. */
export function resolveProfile(options: DatabricksAuthOptions = {}): DatabricksProfileSummary {
  return toProfileSummary(resolveDatabricksProfile(options));
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
