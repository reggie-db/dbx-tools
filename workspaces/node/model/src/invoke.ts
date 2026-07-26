/**
 * Calling a Model Serving endpoint directly over HTTP.
 *
 * The SDK's `servingEndpoints.query` covers the typed request shapes, but an
 * OpenAI-compatible caller (a proxy, a passthrough route, a streaming client)
 * needs to issue its own `fetch` against the endpoint's `invocations` URL with
 * an OpenAI body. That needs exactly two things the SDK doesn't hand out
 * directly: the URL ({@link invocationsUrl}) and a currently-valid set of auth
 * headers ({@link authHeaders}).
 *
 * Auth is delegated entirely to the Databricks SDK: `config.authenticate`
 * re-runs the configured credential provider on every call and refreshes the
 * underlying OAuth / PAT token when it is close to expiry, so a caller never
 * manages token lifetimes itself - mint headers per request and each one is
 * signed with a valid bearer token.
 *
 * @module
 */

/**
 * Path segment appended to a serving endpoint for OpenAI-compatible requests.
 * Databricks routes `/serving-endpoints/<name>/invocations` to the endpoint's
 * OpenAI-shaped surface (`messages` in, `choices` out).
 */
export const INVOCATIONS_SUFFIX = "invocations";

/**
 * The OpenAI-compatible invocations URL for an endpoint id.
 *
 * @param host - Workspace host, e.g. `https://my-workspace.cloud.databricks.com/`.
 *   Pass the value resolved from `client.config.getHost()`.
 * @param endpoint - Endpoint id (already resolved; not fuzzy-matched here).
 */
export function invocationsUrl(host: string, endpoint: string): string {
  return new URL(
    `serving-endpoints/${encodeURIComponent(endpoint)}/${INVOCATIONS_SUFFIX}`,
    host,
  ).toString();
}

/**
 * Minimal structural shape {@link authHeaders} needs. Declared narrowly rather
 * than as a full `WorkspaceClientLike` so a caller holding its own
 * `@databricks/sdk-experimental` `WorkspaceClient` satisfies it regardless of
 * which SDK version resolved in its tree.
 */
export interface AuthenticatingClientLike {
  config: {
    authenticate(headers: Headers): Promise<void>;
  };
}

/**
 * Mint auth headers for one upstream request as a plain object, ready to spread
 * into a `fetch` init. Call it per request: the SDK refreshes the underlying
 * token when needed, so a long-lived process never has to track expiry itself.
 */
export async function authHeaders(
  client: AuthenticatingClientLike,
): Promise<Record<string, string>> {
  const headers = new Headers();
  await client.config.authenticate(headers);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
