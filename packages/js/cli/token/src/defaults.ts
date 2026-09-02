/**
 * Stable defaults for the local token broker.
 *
 * @module
 */

/** Loopback listener retained alongside discovered container gateways. */
export const DEFAULT_BIND = ["127.0.0.1"] as const;
/** Discover reachable Docker and Podman gateways unless explicitly disabled. */
export const DEFAULT_BIND_DOCKER = "auto";
/** Host header values accepted for host, Docker, and Podman clients. */
export const DEFAULT_ALLOWED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "host.docker.internal",
  "host.containers.internal",
] as const;
/** Default broker TCP port. */
export const DEFAULT_PORT = 5556;
/** Signed client tokens are the secure default for broker authentication. */
export const DEFAULT_AUTH_MODE = "jwt";
/** Conservative lifetime of a newly printed Google user access token. */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** Refresh tokens five minutes before their assumed expiry. */
export const DEFAULT_REFRESH_SKEW_SECONDS = 5 * 60;
/** Default signed client-token lifetime. */
export const DEFAULT_CLIENT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Native service, keychain, and state identity. */
export const DEFAULT_SERVICE_NAME = "dbx-tools-token-broker";
/** Empty means gcloud uses the ADC grant without a `--scopes` override. */
export const DEFAULT_GOOGLE_SCOPES = [] as const;
