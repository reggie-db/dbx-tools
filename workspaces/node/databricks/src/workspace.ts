/**
 * Resolve the current Databricks workspace's URL and numeric id from the active
 * execution context (AppKit, when initialized), a default `WorkspaceClient`, or
 * the environment. Server-only.
 */

import { functionModule, net } from "@dbx-tools/shared-core";
import { appkit } from "@dbx-tools/node-appkit";
import { type Config, WorkspaceClient } from "@databricks/sdk-experimental";

/** Databricks workspace ids are a 10-20 digit run embedded in the host. */
const WORKSPACE_ID_REGEX = /\d{10,20}/;

/**
 * Lazily-constructed default `WorkspaceClient` (env / profile auth), memoized so
 * construction happens at most once per process. Used only when there's no
 * AppKit execution context to borrow a client from.
 */
const getDefaultWorkspaceClient = functionModule.memoize(async () => new WorkspaceClient({}));

/**
 * The active workspace `Config`: the AppKit execution-context client's config
 * when AppKit is initialized, else the default client's. Returns `undefined`
 * (never throws) when neither is available.
 */
async function getWorkspaceConfig(): Promise<Config | undefined> {
  let client = appkit.tryGetExecutionContext()?.client as WorkspaceClient | undefined;
  if (!client) {
    try {
      client = await getDefaultWorkspaceClient();
    } catch {
      // no client available; fall back to the environment
    }
  }
  return client?.config;
}

/**
 * Resolve the current workspace host as a `net.UrlBuilder`: the workspace
 * `Config` host first, then the `DATABRICKS_HOST` env var, else `undefined`.
 */
export async function getWorkspaceUrl(): Promise<net.UrlBuilder | undefined> {
  const config = await getWorkspaceConfig();
  if (config) {
    const configHost = net.urlBuilder(await config.getHost());
    if (configHost) return configHost;
  }
  const databricksHost = net.urlBuilder(process.env.DATABRICKS_HOST);
  if (databricksHost) return databricksHost;
  return undefined;
}

/**
 * Resolve the numeric workspace id: the workspace `Config`'s `workspaceId`
 * first, else the 10-20 digit run of `workspaceHost` (defaulting to
 * {@link getWorkspaceUrl}'s host). `undefined` when neither yields an id.
 */
export async function getWorkspaceId(workspaceHost?: string): Promise<string | undefined> {
  const workspaceId = (await getWorkspaceConfig())?.workspaceId;
  if (workspaceId) return workspaceId;
  workspaceHost = workspaceHost ?? (await getWorkspaceUrl())?.host;
  if (workspaceHost) {
    const match = workspaceHost.match(WORKSPACE_ID_REGEX)?.[0];
    if (match) return match;
  }
  return undefined;
}
