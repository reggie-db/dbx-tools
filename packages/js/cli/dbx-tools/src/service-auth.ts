/** Databricks authentication preflight used by installed CLI services. */

import { resolveProfile, type DatabricksAuthOptions } from "@dbx-tools/auth";
import { parseArgv } from "@dbx-tools/cli-args";
import {
  CliServiceWaitForAuthSchema,
  type CliServiceCommand,
  type CliServiceWaitForAuth,
} from "@dbx-tools/cli-service";
import { createWorkspaceClient, waitForWorkspaceAuth } from "@dbx-tools/databricks";
import { DatabricksOptionsSchema } from "@dbx-tools/shared-core";
import { z } from "zod";
import { resolveServiceAuthEntrypoint } from "./_service-auth-entrypoint.ts";

const SERVICE_AUTH_ENTRYPOINT = resolveServiceAuthEntrypoint(import.meta.url);

/** Serialized options accepted by the installed service authentication preflight. */
export const DatabricksServiceAuthOptionsSchema = z
  .object({
    waitForAuth: CliServiceWaitForAuthSchema.default("auto"),
    profile: z
      .array(DatabricksOptionsSchema.shape.profile.unwrap())
      .min(1)
      .optional()
      .meta(DatabricksOptionsSchema.shape.profile.meta() ?? {})
      .describe("Databricks profiles requiring authentication preflight."),
  })
  .strict()
  .describe("Databricks authentication preflight options for an installed CLI service.");

/** Options accepted by the installed service authentication preflight. */
export interface DatabricksServiceAuthOptions {
  readonly waitForAuth: CliServiceWaitForAuth;
  readonly profile?: string | readonly string[];
}

/** Injectable authentication and workspace boundaries for the service preflight. */
export interface DatabricksServiceAuthDependencies {
  readonly resolveProfile: typeof resolveProfile;
  readonly createWorkspaceClient: typeof createWorkspaceClient;
  readonly waitForWorkspaceAuth: typeof waitForWorkspaceAuth;
}

const DEFAULT_DEPENDENCIES: DatabricksServiceAuthDependencies = {
  resolveProfile,
  createWorkspaceClient,
  waitForWorkspaceAuth,
};

/** Build the optional preflight compiled beside an installed service command. */
export function databricksServiceAuthCommand(
  waitForAuth: CliServiceWaitForAuth,
  profile?: string | readonly string[],
): CliServiceCommand | undefined {
  if (waitForAuth === "false") return undefined;
  const profiles = profile === undefined ? [] : Array.isArray(profile) ? profile : [profile];
  return {
    entrypoint: SERVICE_AUTH_ENTRYPOINT,
    arguments: ["--wait-for-auth", waitForAuth, ...profiles.flatMap((name) => ["--profile", name])],
  };
}

/** Wait for `currentUser.me()` when the selected service mode requires it. */
export async function runDatabricksServiceAuth(
  options: DatabricksServiceAuthOptions,
  dependencies: DatabricksServiceAuthDependencies = DEFAULT_DEPENDENCIES,
): Promise<boolean> {
  if (options.waitForAuth === "false") return false;
  let profiles =
    options.profile === undefined
      ? undefined
      : Array.isArray(options.profile)
        ? [...options.profile]
        : [options.profile];
  if (options.waitForAuth === "auto") {
    if (!profiles) {
      const configured = dependencies.resolveProfile();
      if (!configured) return false;
      profiles = [configured.name];
    }
  }
  for (const profile of profiles ?? [undefined]) {
    const authOptions: DatabricksAuthOptions = profile ? { profile } : {};
    const client = await dependencies.createWorkspaceClient(authOptions);
    await dependencies.waitForWorkspaceAuth(client);
  }
  return true;
}

/** Parse and run the installed service authentication preflight. */
export async function runDatabricksServiceAuthCli(argv: readonly string[]): Promise<void> {
  await runDatabricksServiceAuth(parseArgv(DatabricksServiceAuthOptionsSchema, argv));
}
