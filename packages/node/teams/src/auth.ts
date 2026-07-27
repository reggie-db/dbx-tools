/**
 * Inbound and outbound authentication for the Teams messaging endpoint.
 *
 * `POST /api/teams/messages` is a PUBLIC URL - Azure Bot Service calls it from
 * the internet, so it cannot sit behind AppKit's OBO headers or a workspace
 * login. Its only trust boundary is the JWT the Bot Service signs each request
 * with, which is what this module verifies:
 *
 *   1. fetch the Bot Framework OpenID metadata to discover the signing JWKS;
 *   2. verify the token's signature against that key set;
 *   3. check `issuer` is a known Bot Service issuer and `audience` is exactly
 *      this bot's app id.
 *
 * All three matter. Skipping (3) is the classic bot vulnerability: a token the
 * Bot Service legitimately issued for a DIFFERENT bot still verifies against the
 * same JWKS, so without an audience check anyone with their own bot could drive
 * this agent.
 *
 * The outbound half is the reverse: replies go to the Connector API, which needs
 * a client-credentials token for the bot's own app registration. Both key sets
 * and tokens are cached, since a busy channel would otherwise re-fetch metadata
 * on every turn.
 *
 * @module
 */

import { error, log } from "@dbx-tools/shared-core";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * OpenID metadata document for tokens the Bot Service sends a bot in the public
 * cloud. The JWKS URI is read from this document rather than hard-coded so a key
 * rotation on Microsoft's side needs no release here.
 *
 * Overridable per call ({@link VerifyOptions.metadataUrl}) because a sovereign
 * cloud (GCC High / DoD) publishes its own metadata endpoint - and because it
 * makes the verifier testable against a local key set.
 */
export const BOT_OPENID_METADATA =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

/**
 * Accepted `iss` values on an inbound token.
 *
 * The Bot Service has issued tokens under several issuers across channel and
 * tenant configurations, and a single-tenant bot receives the v2 Entra issuer
 * with its own tenant id spliced in (handled by {@link isTrustedIssuer}). The
 * fixed set covers the channel-issued cases.
 */
const TRUSTED_ISSUERS = [
  "https://api.botframework.com",
  "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
  "https://login.microsoftonline.com/d6d49420-f39b-4df7-a1dc-d59a935871db/v2.0",
] as const;

/** Token endpoint issuing the Connector credentials an outbound reply uses. */
const LOGIN_TOKEN_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

/**
 * Scope requested for a Connector token. `.default` asks for the app's
 * statically configured permissions, which is what a bot registration grants.
 */
const CONNECTOR_SCOPE = "https://api.botframework.com/.default";

/** Tenant used for a multi-tenant bot, which has no tenant of its own. */
const MULTI_TENANT = "botframework.com";

/**
 * Refresh an access token this many milliseconds BEFORE it actually expires, so
 * a token never expires mid-flight between the check and the Connector call.
 */
const TOKEN_SKEW_MS = 60_000;

const logger = log.logger("teams:auth");

/**
 * Lazily-created, cached remote key set. `createRemoteJWKSet` handles its own
 * key caching and rotation (re-fetching only on an unknown `kid`), so this is
 * created once per process rather than per request.
 */
let keySet: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Cached JWKS URI discovered from the OpenID metadata document, keyed by metadata URL. */
let jwksUri: string | undefined;

/** Metadata URL the cached key set was built from, so an override busts the cache. */
let keySetSource: string | undefined;

/** Reset cached auth state. Test seam; not part of the public contract. */
export const resetTeamsAuth = (): void => {
  keySet = undefined;
  jwksUri = undefined;
  keySetSource = undefined;
  tokenCache = undefined;
};

/**
 * Discover the signing JWKS URI from the Bot Framework OpenID metadata.
 *
 * Cached for the life of the process: it is a stable pointer, and the key
 * rotation that actually matters happens inside the key set it names.
 */
const discoverJwksUri = async (metadataUrl: string, signal?: AbortSignal): Promise<string> => {
  if (jwksUri && keySetSource === metadataUrl) return jwksUri;
  const response = await fetch(metadataUrl, { ...(signal ? { signal } : {}) });
  if (!response.ok) {
    throw new Error(`teams: could not fetch Bot Framework OpenID metadata (${response.status})`);
  }
  const metadata = (await response.json()) as { jwks_uri?: unknown };
  const uri = typeof metadata.jwks_uri === "string" ? metadata.jwks_uri : null;
  if (!uri) throw new Error("teams: Bot Framework OpenID metadata carried no jwks_uri");
  jwksUri = uri;
  keySetSource = metadataUrl;
  return uri;
};

/** The key set for the discovered JWKS URI, created once and reused. */
const signingKeys = async (
  metadataUrl: string,
  signal?: AbortSignal,
): Promise<ReturnType<typeof createRemoteJWKSet>> => {
  if (keySet && keySetSource === metadataUrl) return keySet;
  const uri = await discoverJwksUri(metadataUrl, signal);
  keySet = createRemoteJWKSet(new URL(uri));
  return keySet;
};

/**
 * Whether `issuer` is one this bot accepts.
 *
 * A single-tenant bot receives tokens issued by its OWN tenant, so the
 * configured tenant's v2 issuer is accepted in addition to the fixed channel
 * issuers.
 */
const isTrustedIssuer = (issuer: string | undefined, tenantId?: string): boolean => {
  if (!issuer) return false;
  if ((TRUSTED_ISSUERS as readonly string[]).includes(issuer)) return true;
  if (!tenantId) return false;
  return (
    issuer === `https://login.microsoftonline.com/${tenantId}/v2.0` ||
    issuer === `https://sts.windows.net/${tenantId}/`
  );
};

/** A verified inbound Bot Framework token. */
export interface VerifiedBotToken {
  /** The token's claims, after signature / issuer / audience validation. */
  claims: JWTPayload;
  /**
   * The `serviceUrl` the token was issued for, when it carries one. Bot Service
   * tokens include this claim; comparing it to the activity's `serviceUrl` is
   * what stops a valid token being replayed to redirect replies elsewhere.
   */
  serviceUrl?: string;
}

/** Options for {@link verifyBotToken}. */
export interface VerifyOptions {
  /** The bot's app id; the ONLY audience an inbound token may carry. */
  appId: string;
  /** Tenant of a single-tenant bot, whose own issuer is then also accepted. */
  appTenantId?: string;
  /**
   * OpenID metadata document naming the signing key set. Defaults to
   * {@link BOT_OPENID_METADATA}; override for a sovereign cloud.
   */
  metadataUrl?: string;
  /** Cancels the metadata / JWKS fetch with the request. */
  signal?: AbortSignal;
}

/**
 * Verify the `Authorization` header on an inbound Bot Service request.
 *
 * Rejects (by throwing) a missing / malformed header, a bad signature, an
 * untrusted issuer, or an audience that is not this bot's `appId`. The caller
 * turns a throw into a 401 - never into a processed activity.
 */
export const verifyBotToken = async (
  authorization: string | undefined,
  options: VerifyOptions,
): Promise<VerifiedBotToken> => {
  const token = bearerToken(authorization);
  if (!token) throw new Error("teams: request carried no bearer token");

  const keys = await signingKeys(options.metadataUrl ?? BOT_OPENID_METADATA, options.signal);
  // `audience` is enforced by the verifier itself: a token the Bot Service
  // issued for someone else's bot verifies against this same JWKS, so the
  // audience check - not the signature - is what binds a request to THIS bot.
  const { payload } = await jwtVerify(token, keys, { audience: options.appId });

  if (!isTrustedIssuer(payload.iss, options.appTenantId)) {
    throw new Error(`teams: untrusted token issuer '${payload.iss ?? "none"}'`);
  }

  const serviceUrl = typeof payload.serviceurl === "string" ? payload.serviceurl : undefined;
  return { claims: payload, ...(serviceUrl ? { serviceUrl } : {}) };
};

/** Read the bearer value out of an `Authorization` header. */
const bearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) return null;
  const [scheme, value] = authorization.split(/\s+/, 2);
  if (!value || scheme?.toLowerCase() !== "bearer") return null;
  return value.trim() || null;
};

/** A cached Connector access token and the moment it stops being usable. */
interface CachedToken {
  token: string;
  expiresAt: number;
}

let tokenCache: CachedToken | undefined;

/**
 * Fetch (or reuse) a Connector API access token for the bot's own app
 * registration.
 *
 * Cached until shortly before expiry: a Connector token is valid for ~1h, and
 * re-fetching per reply would add a round trip to every turn.
 */
export const connectorToken = async (options: {
  appId: string;
  appPassword: string;
  appTenantId?: string;
  signal?: AbortSignal;
}): Promise<string> => {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: options.appId,
    client_secret: options.appPassword,
    scope: CONNECTOR_SCOPE,
  });
  const response = await fetch(LOGIN_TOKEN_URL(options.appTenantId ?? MULTI_TENANT), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `teams: could not obtain a Connector token (${response.status}) ${detail}`.trim(),
    );
  }
  const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  const token = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!token) throw new Error("teams: token response carried no access_token");
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  tokenCache = { token, expiresAt: now + expiresIn * 1000 - TOKEN_SKEW_MS };
  logger.debug("connector token refreshed", { expiresIn });
  return token;
};

/**
 * Host suffixes replies may be sent to when the token pins no `serviceUrl`.
 *
 * `smba.trafficmanager.net` is the one that matters in practice: that is where
 * Teams itself serves the Connector API from (per-region, e.g.
 * `https://smba.trafficmanager.net/amer/`), so omitting it would reject every
 * real Teams reply. Compared as dot-prefixed suffixes (or exact matches) so a
 * lookalike host like `botframework.com.attacker.example` cannot pass.
 */
const ALLOWED_SERVICE_HOSTS = ["botframework.com", "trafficmanager.net", "microsoft.com"] as const;

/**
 * Whether `serviceUrl` is one replies may be sent to.
 *
 * Only ever the host the verified token was issued for. A Bot Service token is a
 * bearer credential, so honoring the `serviceUrl` from the request BODY would
 * let a replayed token point the bot's authenticated replies (and its token) at
 * an attacker-controlled host. When the token carries no `serviceurl` claim the
 * body value is accepted but restricted to Microsoft's own domains.
 */
export const isAllowedServiceUrl = (serviceUrl: string, tokenServiceUrl?: string): boolean => {
  const normalize = (value: string) => value.replace(/\/+$/, "").toLowerCase();
  if (tokenServiceUrl) return normalize(serviceUrl) === normalize(tokenServiceUrl);
  try {
    const { protocol, hostname } = new URL(serviceUrl);
    if (protocol !== "https:") return false;
    const host = hostname.toLowerCase();
    return ALLOWED_SERVICE_HOSTS.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch (err) {
    logger.debug("rejecting unparseable serviceUrl", { error: error.errorMessage(err) });
    return false;
  }
};
