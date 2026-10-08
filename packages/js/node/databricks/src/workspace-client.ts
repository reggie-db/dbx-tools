/**
 * Resolve the current Databricks workspace's URL, numeric id, and client from
 * the active execution context (AppKit, when initialized), a default
 * {@link WorkspaceClient}, or the environment. Server-only.
 *
 * @module
 */

import {
  createWorkspaceClient as _createWorkspaceClient,
  type WorkspaceClient as AppKitWorkspaceClient,
} from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { client as authClient, type AuthClient, type DatabricksAuthOptions } from "@dbx-tools/auth";
import { functionUtils, net, stringUtils } from "@dbx-tools/shared-core";

/** Databricks workspace ids are a 10-20 digit run embedded in the host. */
const WORKSPACE_ID_REGEX = /\d{10,20}/;
const workspaceAuth = new WeakMap<AppKitWorkspaceClient, AuthClient>();

/** Legacy SDK client exposed by AppKit for APIs not yet on its facade. */
export type WorkspaceClient = ReturnType<AppKitWorkspaceClient["toLegacyWorkspaceClient"]>;
type Config = WorkspaceClient["config"];

/**
 * Create an AppKit workspace client whose SDK credential visitor delegates to
 * `@dbx-tools/auth`.
 *
 * The auth package resolves the active profile, host, token lifecycle, and
 * unified-workspace header without requiring callers to mirror profile values
 * into environment variables. The SDK still owns workspace APIs and request
 * execution.
 */
export async function createWorkspaceClient(
  options: DatabricksAuthOptions = {},
): Promise<AppKitWorkspaceClient> {
  const auth = await authClient.createAuthClient(options);
  const client = _createWorkspaceClient({ host: auth.host });
  client.config.credentials = {
    name: "pat",
    async configure() {
      return async (headers) => {
        for (const [name, value] of Object.entries(await auth.headers())) {
          headers.set(name, value);
        }
      };
    },
  };
  workspaceAuth.set(client, auth);
  return client;
}

/**
 * Refresh the dbx-tools credential lifecycle attached by
 * {@link createWorkspaceClient}. Returns `false` for externally supplied
 * AppKit clients whose credential owner is unknown.
 */
export async function refreshWorkspaceClientAuthentication(
  client: AppKitWorkspaceClient,
): Promise<boolean> {
  const auth = workspaceAuth.get(client);
  if (!auth) return false;
  await auth.headers({ login: false, refresh: true });
  return true;
}

/** Resolve AppKit's facade or an existing legacy client to the legacy SDK surface. */
export function toLegacyWorkspaceClient(
  client: AppKitWorkspaceClient | WorkspaceClient,
): WorkspaceClient {
  return "toLegacyWorkspaceClient" in client ? client.toLegacyWorkspaceClient() : client;
}

/**
 * Lazily-constructed default `WorkspaceClient` (env / profile auth), memoized so
 * construction happens at most once per process. Used only when there's no
 * AppKit execution context to borrow a client from.
 */
const getDefaultWorkspaceClient = functionUtils.memoize(async () =>
  (await createWorkspaceClient()).toLegacyWorkspaceClient(),
);

/**
 * The AppKit execution-context workspace client when available, otherwise
 * `undefined`. Never constructs a fallback client and never throws for a
 * missing AppKit scope.
 */
export function tryGetWorkspaceClient(): WorkspaceClient | undefined {
  return appkit.tryGetExecutionContext()?.client.toLegacyWorkspaceClient();
}

/**
 * Resolve a {@link WorkspaceClient}: {@link tryGetWorkspaceClient} first, else
 * a memoized default client from env / profile auth.
 */
export async function getWorkspaceClient(): Promise<WorkspaceClient> {
  return tryGetWorkspaceClient() ?? (await getDefaultWorkspaceClient());
}

/**
 * The active workspace `Config`: the AppKit execution-context client's config
 * when AppKit is initialized, else the default client's. Returns `undefined`
 * (never throws) when neither is available.
 */
async function getWorkspaceConfig(): Promise<Config | undefined> {
  try {
    return (await getWorkspaceClient()).config;
  } catch {
    return undefined;
  }
}

/**
 * Current Databricks username for workspace home paths
 * (`/Workspace/Users/<userName>`).
 *
 * Prefers `userName` on the AppKit execution context when set, otherwise
 * calls `currentUser.me()` on {@link client} (or {@link getWorkspaceClient}).
 */
export async function getCurrentUserName(client?: WorkspaceClient): Promise<string> {
  const contextUser = readContextUserName(appkit.tryGetExecutionContext());
  if (contextUser) return contextUser;

  const resolved = client ?? (await getWorkspaceClient());
  const me = await resolved.currentUser.me();
  const userName = me.userName?.trim();
  if (!userName) {
    throw new Error("Databricks currentUser.me() did not return a userName");
  }
  return userName;
}

/** Best-effort `userName` off an AppKit execution context (shape varies by mode). */
function readContextUserName(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null || !("userName" in ctx)) return undefined;
  const value = (ctx as { userName?: unknown }).userName;
  return stringUtils.trimToUndefined(value);
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
