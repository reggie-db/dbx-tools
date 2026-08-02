/**
 * Which Databricks identity a chat turn's workspace calls run as.
 *
 * Every Databricks call a turn makes - the `/serving-endpoints` catalogue the
 * model picker reads, Genie suggestions, `ask_genie`, and the Statement
 * Execution fetch behind a `[data:<id>]` embed - goes through the workspace
 * client on the ambient AppKit execution context. That context is user-scoped
 * (OBO) whenever the plugin enters `asUser(req)` and the app's service principal
 * otherwise, so ONE decision - do we enter that scope for this request - moves
 * every call site together.
 *
 * The decision itself is NOT Mastra-specific (the Teams messaging endpoint and
 * the tunnel gate face it too), so it lives in `@dbx-tools/appkit`'s `identity`
 * module - which also documents the measured AppKit behavior that makes `"auto"`
 * necessary. This module is the Mastra-facing binding: the plugin's own config
 * field and env var, re-exporting the shared vocabulary so a consumer importing
 * `@dbx-tools/appkit-mastra` needs no second import.
 *
 * Why the option exists: OBO requires the caller to be a member of the
 * WORKSPACE, not merely of the Databricks account. An app shared with an
 * account-level group can therefore be opened by someone whose OBO token is
 * perfectly valid but whose every workspace call fails with `Unauthorized
 * access to Org: <workspace-id>`, and granting workspace membership is not
 * always available - a workspace caps membership far below the size of a large
 * account's user group. The app's own service principal already holds the Genie
 * / warehouse / serving / Unity Catalog grants the app was deployed with, and
 * works for every caller.
 *
 * The modes, from `config.genieIdentity` (env: {@link IDENTITY_ENV}):
 *
 *   - `"user"` (default): always OBO. Calls are attributed per user and Genie /
 *     Unity Catalog row filters apply per user. Correct whenever every caller is
 *     a workspace member. This is the historical behavior, so the option is
 *     purely additive - an app that never sets it is unchanged.
 *   - `"service-principal"`: always the app service principal. Needs no OBO
 *     scopes and works for any caller who can open the app, at the cost of
 *     per-user attribution in Genie / Unity Catalog.
 *   - `"auto"`: OBO when the request carries an OBO token, the service principal
 *     when it does not. The mode for an app that serves BOTH the platform front
 *     door and a door with no OBO token to forward (a `@dbx-tools/cli-tunnel`
 *     gate, a Teams channel), since a single container serves both at once.
 *
 * What the service-principal path does NOT change is WHO the turn belongs to.
 * The memory thread's `resourceId`, the per-user cache namespace, and the user
 * metadata on traces still come from the forwarded request headers, so two
 * account users sharing the service principal's data access still get separate
 * conversations and cannot read each other's threads or cached charts. Only the
 * Databricks credential is shared.
 *
 * @module
 */

import { identity } from "@dbx-tools/appkit";

/** Identity a chat turn's Databricks calls run as. See the module docs. */
export type MastraIdentityMode = identity.IdentityMode;

/** Environment fallback for `config.genieIdentity`. */
export const IDENTITY_ENV = "MASTRA_GENIE_IDENTITY";

/** Every accepted {@link MastraIdentityMode}. */
export const IDENTITY_MODES = identity.IDENTITY_MODES;

/**
 * Default mode. `"user"` keeps OBO the only identity unless an app opts in, so
 * adopting this option can never silently widen an existing app's data access.
 */
export const DEFAULT_IDENTITY_MODE = identity.DEFAULT_IDENTITY_MODE;

/** Header Databricks Apps forward the signed-in user's id on. */
export const USER_ID_HEADER = identity.USER_ID_HEADER;

/** Header Databricks Apps forward the signed-in user's email on. */
export const USER_EMAIL_HEADER = identity.USER_EMAIL_HEADER;

/**
 * Resolve the configured mode: explicit plugin config, then {@link IDENTITY_ENV},
 * then {@link DEFAULT_IDENTITY_MODE}. An unrecognized value throws.
 */
export function resolveIdentityMode(configured: string | undefined): MastraIdentityMode {
  return identity.resolveIdentityMode(configured, IDENTITY_ENV, "genieIdentity");
}

/**
 * The forwarded user id on `req`, or `undefined`. Used to attribute a turn to
 * the real caller when the Databricks client is the app SP but memory / cache /
 * traces must still key off the user.
 */
export const requestUserId = identity.requestUserId;

/** The forwarded user email on `req`, or `undefined`. */
export const requestUserEmail = identity.requestUserEmail;

/**
 * Whether this request should run its Databricks calls as the app service
 * principal rather than OBO - `"service-principal"` always, `"user"` never, and
 * `"auto"` only when the request carries no OBO token for AppKit to use.
 */
export const useServicePrincipal = identity.useServicePrincipal;
