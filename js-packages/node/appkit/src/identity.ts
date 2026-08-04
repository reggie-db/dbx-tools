/**
 * Which Databricks identity a request's workspace calls run as.
 *
 * AppKit gives a plugin two identities: the ambient SERVICE context (the app's
 * own service principal) and a per-request USER context entered with
 * `asUser(req)`, which authenticates as the caller on-behalf-of (OBO). The
 * choice is one call, so the whole decision is "do we enter `asUser` for this
 * request".
 *
 * `asUser(req)` needs the OBO token the platform front door forwards on
 * {@link ACCESS_TOKEN_HEADER}. Measured against the installed AppKit, its
 * behavior when that header is absent depends ENTIRELY on `NODE_ENV`:
 *
 * | `NODE_ENV`    | no `x-forwarded-access-token`                        |
 * | ------------- | ---------------------------------------------------- |
 * | `development` | logs a warning, silently runs as the service principal |
 * | anything else | throws `AuthenticationError: Missing user token`      |
 *
 * That production throw is correct for an app behind the Databricks front door,
 * where a missing token means something is wrong. It is fatal for an app whose
 * traffic legitimately arrives WITHOUT one:
 *
 *   - a public tunnel (`@dbx-tools/tunnel`), where callers authenticate by
 *     email OTP and no OBO token exists to forward - the gate can prove WHO the
 *     caller is, but it cannot mint a Databricks credential for them;
 *   - any reverse proxy, webhook, or bot channel (`POST /api/teams/messages`)
 *     that authenticates its own way.
 *
 * Such an app must not run with `NODE_ENV=development` just to get the fallback:
 * that flag also relaxes secure cookies, AppKit's own dev affordances, and
 * `allowUnauthenticated` escape hatches. Hence {@link IdentityMode}:
 *
 *   - `"user"` - always OBO. Per-user attribution and per-user Genie / Unity
 *     Catalog row filters. Correct when every caller is a workspace member.
 *   - `"service-principal"` - always the app's own identity. Needs no OBO
 *     scopes and works for any caller, at the cost of per-user data scoping.
 *   - `"auto"` - OBO when the request actually carries a usable OBO token,
 *     the service principal otherwise. One deployment then serves BOTH doors
 *     correctly: front-door requests keep full per-user scoping, while tunnel /
 *     webhook requests degrade to the service principal instead of 500ing.
 *
 * `"auto"` decides per REQUEST, not per boot, because a single container serves
 * both doors at once - the tunnel gate and the platform front door share a port
 * (see `@dbx-tools/tunnel`). A boot-time flag would have to be wrong for one
 * of them.
 *
 * What the service principal does NOT change is WHO the request belongs to. The
 * caller's identity still arrives on {@link USER_ID_HEADER} /
 * {@link USER_EMAIL_HEADER}, so memory threads, cache namespaces, and trace
 * attribution stay per-user. Only the Databricks credential is shared.
 *
 * @module
 */

import { ConfigurationError } from "@databricks/appkit";
import { env, string, token, type EnvKey } from "@dbx-tools/shared-core";

/**
 * Header the Databricks Apps front door forwards the caller's OBO token on.
 * Its presence is what makes `asUser(req)` viable, so it is the signal
 * {@link useServicePrincipal} reads in `"auto"` mode.
 *
 * Re-exported from `@dbx-tools/shared-core`'s `token` module (which reads the
 * same header to decode OAuth scopes) rather than re-spelled, so the name for
 * this wire contract exists once.
 */
export const ACCESS_TOKEN_HEADER = token.ACCESS_TOKEN_HEADER;

/** Header the Databricks Apps front door forwards the caller's user id on. */
export const USER_ID_HEADER = token.USER_ID_HEADER;

/** Header the Databricks Apps front door forwards the caller's email on. */
export const USER_EMAIL_HEADER = token.USER_EMAIL_HEADER;

/** Identity a request's Databricks calls run as. See the module docs. */
export type IdentityMode = "user" | "service-principal" | "auto";

/** Every accepted {@link IdentityMode}, in the order docs and schemas list them. */
export const IDENTITY_MODES: readonly IdentityMode[] = ["user", "service-principal", "auto"];

/**
 * Default mode. `"user"` keeps OBO the only identity unless an app opts in, so
 * adopting this option can never silently widen an existing app's data access.
 */
export const DEFAULT_IDENTITY_MODE: IdentityMode = "user";

/** The subset of `express.Request` this module reads - one header lookup. */
export interface HeaderBearing {
  header(name: string): string | undefined;
}

/**
 * Resolve a configured mode: explicit config value, then the first non-empty
 * variable among `envKeys`, then {@link DEFAULT_IDENTITY_MODE}.
 *
 * An unrecognized value throws rather than falling back. Falling back would
 * silently keep serving OBO - and the production `AuthenticationError` it
 * produces - to exactly the callers the option was set to accommodate, and a
 * typo (`"obo"`, `"sp"`) is the likeliest way to get one.
 */
export function resolveIdentityMode(
  configured: string | undefined,
  envKeys: EnvKey,
  field = "identity",
): IdentityMode {
  const raw = env.string(configured, envKeys);
  if (raw === null) return DEFAULT_IDENTITY_MODE;
  const mode = raw.toLowerCase() as IdentityMode;
  if (!IDENTITY_MODES.includes(mode)) {
    const names = typeof envKeys === "string" ? envKeys : envKeys.join(" / ");
    throw new ConfigurationError(
      `${field} must be one of ${IDENTITY_MODES.join(" | ")} (env: ${names})`,
      { context: { field, envVar: names, received: raw } },
    );
  }
  return mode;
}

/**
 * The OBO token on `req`, or `undefined`. Read through the same trim as every
 * other header, so a header present-but-blank (which some proxies emit for an
 * unset upstream value) counts as absent rather than as a token that fails at
 * the first Databricks call.
 */
export function requestAccessToken(req: HeaderBearing | undefined): string | undefined {
  return string.trimToNull(req?.header(ACCESS_TOKEN_HEADER)) ?? undefined;
}

/** The forwarded user id on `req`, or `undefined`. */
export function requestUserId(req: HeaderBearing | undefined): string | undefined {
  return string.trimToNull(req?.header(USER_ID_HEADER)) ?? undefined;
}

/** The forwarded user email on `req`, or `undefined`. */
export function requestUserEmail(req: HeaderBearing | undefined): string | undefined {
  return string.trimToNull(req?.header(USER_EMAIL_HEADER)) ?? undefined;
}

/**
 * Whether `req` should run its Databricks calls as the app service principal
 * rather than OBO.
 *
 * - `"service-principal"` -> always `true`.
 * - `"user"` -> always `false`, even with no token. The mode is an explicit
 *   assertion that every caller is OBO-capable, so a missing token is a real
 *   error and must surface as AppKit's `AuthenticationError` rather than being
 *   quietly downgraded to shared data access.
 * - `"auto"` -> `true` only when the request carries no usable OBO token.
 *
 * A request AppKit will not accept for OBO anyway (no token) can never be
 * served by entering `asUser`, so in `"auto"` mode the token check is the whole
 * decision: it is the same condition AppKit itself branches on, just resolved
 * before it can throw.
 */
export function useServicePrincipal(mode: IdentityMode, req?: HeaderBearing): boolean {
  if (mode === "service-principal") return true;
  if (mode === "user") return false;
  return requestAccessToken(req) === undefined;
}
