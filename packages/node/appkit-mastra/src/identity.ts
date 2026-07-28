/**
 * Which Databricks identity a chat turn's workspace calls run as.
 *
 * Every Databricks call a turn makes - the `/serving-endpoints` catalogue the
 * model picker reads, Genie suggestions, `ask_genie`, and the Statement
 * Execution fetch behind a `[data:<id>]` embed - goes through the workspace
 * client on the ambient AppKit execution context. That context is user-scoped
 * (OBO) whenever the plugin enters `asUser(req)` and the app's service principal
 * otherwise, so ONE decision - do we enter that scope for this request - moves
 * every call site together. This module owns that decision.
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
 * The two modes, from `config.genieIdentity` (env: {@link IDENTITY_ENV}):
 *
 *   - `"user"` (default): always OBO. Calls are attributed per user and Genie /
 *     Unity Catalog row filters apply per user. Correct whenever every caller is
 *     a workspace member. This is the historical behavior, so the option is
 *     purely additive - an app that never sets it is unchanged.
 *   - `"service-principal"`: always the app service principal. Needs no OBO
 *     scopes and works for any caller who can open the app, at the cost of
 *     per-user attribution in Genie / Unity Catalog.
 *
 * What `"service-principal"` does NOT change is WHO the turn belongs to. The
 * memory thread's `resourceId`, the per-user cache namespace, and the user
 * metadata on traces still come from the forwarded request headers, so two
 * account users sharing the service principal's data access still get separate
 * conversations and cannot read each other's threads or cached charts. Only the
 * Databricks credential is shared.
 *
 * @module
 */

import { ConfigurationError } from "@databricks/appkit";
import { string } from "@dbx-tools/shared-core";
import type express from "express";

/** Identity a chat turn's Databricks calls run as. See the module docs. */
export type MastraIdentityMode = "user" | "service-principal";

/** Environment fallback for `config.genieIdentity`. */
export const IDENTITY_ENV = "MASTRA_GENIE_IDENTITY";

/** Every accepted {@link MastraIdentityMode}. */
export const IDENTITY_MODES: readonly MastraIdentityMode[] = ["user", "service-principal"];

/**
 * Default mode. `"user"` keeps OBO the only identity unless an app opts in, so
 * adopting this option can never silently widen an existing app's data access.
 */
export const DEFAULT_IDENTITY_MODE: MastraIdentityMode = "user";

/**
 * Resolve the configured mode: explicit plugin config, then {@link IDENTITY_ENV},
 * then {@link DEFAULT_IDENTITY_MODE}.
 *
 * An unrecognized value throws rather than falling back, since falling back
 * would silently keep serving OBO - and the 500s it produces - to exactly the
 * callers the option was set to accommodate.
 */
export function resolveIdentityMode(configured: string | undefined): MastraIdentityMode {
  const raw = string.trimToNull(configured) ?? string.trimToNull(process.env[IDENTITY_ENV]);
  if (raw === null) return DEFAULT_IDENTITY_MODE;
  const mode = raw.toLowerCase() as MastraIdentityMode;
  if (!IDENTITY_MODES.includes(mode)) {
    throw new ConfigurationError(
      `genieIdentity must be one of ${IDENTITY_MODES.join(" | ")} (env: ${IDENTITY_ENV})`,
      { context: { field: "genieIdentity", envVar: IDENTITY_ENV, received: raw } },
    );
  }
  return mode;
}

/** Header Databricks Apps forward the signed-in user's id on. */
export const USER_ID_HEADER = "x-forwarded-user";

/** Header Databricks Apps forward the signed-in user's email on. */
export const USER_EMAIL_HEADER = "x-forwarded-email";

/**
 * The forwarded user id on `req`, or `undefined`. Used to attribute a turn to
 * the real caller in `service-principal` mode, where the Databricks client is
 * the app SP but memory / cache / traces must still key off the user.
 */
export function requestUserId(req: express.Request): string | undefined {
  return string.trimToNull(req.header(USER_ID_HEADER)) ?? undefined;
}

/** The forwarded user email on `req`, or `undefined`. */
export function requestUserEmail(req: express.Request): string | undefined {
  return string.trimToNull(req.header(USER_EMAIL_HEADER)) ?? undefined;
}

/**
 * Whether this request should run its Databricks calls as the app service
 * principal rather than OBO. `"service-principal"` always does; `"user"` never
 * does. The request is accepted for symmetry and to leave room for
 * request-scoped policy later; it is unused today.
 */
export function useServicePrincipal(mode: MastraIdentityMode, _req?: express.Request): boolean {
  return mode === "service-principal";
}
