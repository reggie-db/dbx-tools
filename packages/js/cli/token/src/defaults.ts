/**
 * Stable defaults for the local token broker.
 *
 * @module
 */

/** Host-only listener used unless explicit/container binds are requested. */
export const DEFAULT_BIND = ["127.0.0.1"] as const;
/** Host header values accepted for host, Docker, and Podman clients. */
export const DEFAULT_ALLOWED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "host.docker.internal",
  "host.containers.internal",
] as const;
/** Default broker TCP port. */
export const DEFAULT_PORT = 4010;
/** First implemented provider. */
export const DEFAULT_PROVIDER = "google";
/** Foreground local mode starts without application authentication. */
export const DEFAULT_AUTH_MODE = "none";
/** Authenticated modes use mandatory-client-certificate TLS by default. */
export const DEFAULT_TLS_MODE = "mtls";
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
