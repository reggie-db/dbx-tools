/**
 * Calling a Model Serving endpoint directly over HTTP.
 *
 * The SDK's `servingEndpoints.query` covers the typed request shapes, but an
 * OpenAI-compatible caller (a proxy, a passthrough route, a streaming client)
 * needs to issue its own `fetch` against Databricks' OpenAI-shaped URLs with
 * an OpenAI body. That needs exactly two things the SDK doesn't hand out
 * directly: the URL ({@link invocationsUrl} / {@link responsesUrl} /
 * {@link openResponsesUrl}) and a currently-valid set of auth headers
 * ({@link authHeaders}).
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
 * Path segment appended to a serving endpoint for OpenAI-compatible chat
 * requests. Databricks routes `/serving-endpoints/<name>/invocations` to the
 * endpoint's Chat Completions surface (`messages` in, `choices` out). Some
 * models (notably Codex) reject this path and require {@link responsesUrl}.
 */
export const INVOCATIONS_SUFFIX = "invocations";

/**
 * Workspace-level OpenAI Responses API path. Body carries `model` (endpoint
 * id); used by GPT / Codex models that speak Responses natively.
 */
export const RESPONSES_PATH = "serving-endpoints/responses";

/**
 * Workspace-level Open Responses API path - the cross-provider Responses
 * surface (Claude, Gemini, …) that OpenAI `/responses` does not cover.
 */
export const OPEN_RESPONSES_PATH = "serving-endpoints/open-responses";

/**
 * Workspace-level OpenAI Chat Completions path. Body carries `model` (endpoint
 * id), unlike {@link invocationsUrl} which names the endpoint in the URL. Use
 * this when the caller has a model id rather than a per-endpoint route - e.g.
 * attaching a provider tool spec to whichever endpoint was resolved.
 */
export const CHAT_COMPLETIONS_PATH = "serving-endpoints/chat/completions";

/**
 * The OpenAI-compatible chat-completions invocations URL for an endpoint id.
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

/** Workspace OpenAI Responses API URL (`POST`, model in the body). */
export function responsesUrl(host: string): string {
  return new URL(RESPONSES_PATH, host).toString();
}

/** Workspace Open Responses API URL (`POST`, model in the body). */
export function openResponsesUrl(host: string): string {
  return new URL(OPEN_RESPONSES_PATH, host).toString();
}

/** Workspace OpenAI Chat Completions URL (`POST`, model in the body). */
export function chatCompletionsUrl(host: string): string {
  return new URL(CHAT_COMPLETIONS_PATH, host).toString();
}

/**
 * True when the endpoint is known to reject Chat Completions `/invocations`
 * and require the Responses API (Codex models today). Callers should route
 * those to {@link responsesUrl} instead of {@link invocationsUrl}.
 */
export function isResponsesOnly(endpoint: string): boolean {
  return /codex/i.test(endpoint);
}

/**
 * Pick the Databricks Responses upstream for an endpoint id: OpenAI-family
 * models use `/serving-endpoints/responses`; everything else uses the
 * cross-provider `/serving-endpoints/open-responses`.
 */
export function responsesUpstreamUrl(host: string, endpoint: string): string {
  return isOpenAiFamily(endpoint) ? responsesUrl(host) : openResponsesUrl(host);
}

/** GPT / Codex / o-series style endpoint names that speak OpenAI Responses. */
function isOpenAiFamily(endpoint: string): boolean {
  const n = endpoint.toLowerCase();
  return (
    n.includes("gpt") ||
    n.includes("codex") ||
    /(^|[^a-z])o[1-9]([^a-z]|$)/.test(n) ||
    n.includes("openai")
  );
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
