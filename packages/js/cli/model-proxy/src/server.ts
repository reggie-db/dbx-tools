/**
 * OpenAI-compatible HTTP proxy in front of Databricks Model Serving.
 *
 * Databricks serving endpoints speak OpenAI wire formats, so this server is a
 * thin pass-through: it resolves the request's (possibly fuzzy) `model` to a
 * real endpoint id via the {@link ModelProxyBackend}, stamps a fresh auth
 * header, and forwards to the right Databricks URL:
 *
 *   - Chat Completions → `/serving-endpoints/<name>/invocations`, except for
 *     Responses-only models (Codex) which are translated and sent to
 *     `/serving-endpoints/responses`.
 *   - Responses → native `/serving-endpoints/responses` (OpenAI-family) or
 *     `/serving-endpoints/open-responses` (Claude/Gemini/…), body forwarded
 *     as-is. No chat round-trip.
 *
 * Any OpenAI-compatible tool (iTerm, editors, the `openai` SDK, Codex CLI) can
 * point its base URL at this server and use loose model names.
 *
 * Routes:
 *   - `GET  /health`, `GET /`            liveness
 *   - `GET  /v1/models`, `GET /models`   list resolvable endpoints. Emits the
 *     OpenAI `{object:"list",data:[…]}` shape by default; when the request
 *     looks like the Codex CLI (a `client_version` query param, which Codex
 *     always sends) it emits Codex's `{models:[{slug,…}]}` shape instead, so
 *     both standard OpenAI clients and Codex can enumerate the catalogue.
 *   - `POST /v1/chat/completions`        proxy (also `/completions`,
 *     `/v1/completions`, `/v1/embeddings`, and the un-prefixed variants)
 *   - `POST /v1/responses`               OpenAI Responses API, forwarded to
 *     Databricks' native Responses / Open Responses surface.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { config } from "@dbx-tools/core";
import { async as sharedAsync, error, json, log, object, string } from "@dbx-tools/shared-core";
import {
  classify,
  openaiChat,
  openaiResponses,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model";
import { Agent } from "undici";

import { DEFAULT_BIND_HOST, DEFAULT_PORT, DEFAULT_RETRY, type RetryConfig } from "./defaults.ts";

const { chatToResponsesRequest, responseToChatCompletion, sanitizeOpenResponsesRequest } =
  openaiResponses;

const logger = log.logger("model-proxy/server");

/**
 * Dispatcher for every upstream call, with undici's inactivity timeouts
 * DISABLED (`0`).
 *
 * A proxied turn is only as fast as the model behind it, and undici's
 * defaults (300s `headersTimeout`, 300s `bodyTimeout`) are both wrong here.
 * `bodyTimeout` is the killer: it measures the gap BETWEEN chunks, so a model
 * that thinks for a while mid-stream - extended reasoning, a long tool round
 * trip, a slow Genie/SQL step - trips it and undici tears the socket down
 * with `UND_ERR_BODY_TIMEOUT`, which the client sees as a truncated stream.
 *
 * The proxy has no opinion on how long a model may take, so it imposes no
 * deadline: the stream ends when the upstream ends it, or when the client
 * hangs up (see {@link requestAbortSignal}). Callers that DO want a deadline
 * should send one, the same as they would to OpenAI.
 */
const upstreamDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** POST routes forwarded to a serving endpoint (chat or Responses-only). */
const PROXY_PATHS = new Set([
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/completions",
  "/completions",
  "/v1/embeddings",
  "/embeddings",
]);

/** GET routes that list the resolvable model catalogue. */
const MODELS_PATHS = new Set(["/v1/models", "/models"]);

/** POST routes that carry an OpenAI Responses API body (native passthrough). */
const RESPONSES_PATHS = new Set(["/v1/responses", "/responses"]);

/**
 * Extra request fields to strip before forwarding, on top of
 * `openaiChat.UNSUPPORTED_CHAT_FIELDS`. Comma-separated in `PROXY_DROP_FIELDS`.
 *
 * An escape hatch: when a workspace or a new client version trips a field
 * Databricks rejects, an operator can unblock themselves immediately instead of
 * waiting on a release of this package.
 */
function extraDropFields(): string[] {
  return string.parseList(config.text("PROXY_DROP_FIELDS", config.ENV_ONLY));
}

/** Options shared by {@link createProxyServer} and {@link startProxyServer}. */
export interface ProxyServerOptions {
  /**
   * When set, local clients must present this value as a bearer token
   * (`Authorization: Bearer <key>`). Unset leaves the proxy open, which is fine
   * for a loopback bind but should be paired with a key on a wider one.
   */
  apiKey?: string;
  /**
   * Policy for absorbing upstream 429s. Omitted defaults to {@link
   * DEFAULT_RETRY} (retry on). See {@link RetryConfig}.
   */
  retry?: RetryConfig;
}

/** Options for {@link startProxyServer}, adding the listen address. */
export interface StartProxyOptions extends ProxyServerOptions {
  host?: string;
  port?: number;
}

/** Minimal backend contract consumed by the HTTP proxy and its test doubles. */
export interface ModelProxyBackend {
  authHeaders(): Promise<Record<string, string>>;
  invocationsUrl(endpoint: string): string;
  isResponsesOnly(endpoint: string): boolean;
  models(force?: boolean): Promise<ServingEndpointSummary[]>;
  resolve(
    model: string,
    options?: { requiresTools?: boolean },
  ): Promise<{ modelId: string; matched: boolean; score?: number }>;
  responsesUrl(endpoint: string): string;
}

/** Build (but do not start) the proxy HTTP server. */
export function createProxyServer(
  backend: ModelProxyBackend,
  options: ProxyServerOptions = {},
): Server {
  const server = createServer((req, res) => {
    void handleRequest(backend, options, req, res);
  });
  // Match the upstream policy on the INBOUND side: never cut a client off
  // mid-turn. Node's defaults (300s `requestTimeout`, 60s `headersTimeout`)
  // are sized for ordinary web traffic, not for holding a streamed model
  // response open, and a client that hits one gets a dead socket rather than
  // an error it can act on. `0` disables each; the turn now ends when the
  // model is done or the client disconnects.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  return server;
}

/**
 * Signal that aborts when the client hangs up.
 *
 * Removing the timeouts means nothing else will ever end a forgotten request,
 * so the client's own disconnect becomes the only backstop against an upstream
 * call running on with no one to receive it. Passing this to `fetch` is what
 * makes a cancelled turn (Ctrl-C, a closed tab, a killed CLI) release the
 * Databricks-side stream instead of leaking it for the life of the process.
 *
 * Keyed off the RESPONSE, not the request: `IncomingMessage` emits `close` as
 * soon as its body has been fully consumed, which on every POST here happens
 * before the upstream call is even made - watching that would abort each turn
 * instantly. `ServerResponse` emits `close` when the response finishes or the
 * connection drops, so the `writableFinished` check separates "client left"
 * from "we replied".
 */
function clientAbortSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

/**
 * POST a JSON body to a serving endpoint on the no-timeout
 * {@link upstreamDispatcher}, cancelled via `signal`.
 *
 * Every upstream call goes through here so the timeout and cancellation policy
 * is stated once. `dispatcher` is an undici extension that the DOM
 * `RequestInit` Node compiles against does not declare, hence the local
 * intersection type rather than a cast at each call site.
 */
async function upstreamFetch(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  const init: RequestInit = { method: "POST", headers, body, signal };
  // `dispatcher` is an undici extension the DOM `RequestInit` doesn't declare,
  // and it can't simply be typed on: `@types/node` pins its own `undici-types`
  // copy, so the `Agent` from our `undici` dependency is a structurally
  // identical but nominally different type than the one the global `fetch`
  // signature expects. Attaching it structurally sidesteps a version skew that
  // no cast expresses cleanly, and `fetch` reads it at runtime all the same.
  Reflect.set(init, "dispatcher", upstreamDispatcher);
  return fetch(url, init);
}

/**
 * Delay (ms) a `429` response asks us to wait, from its `Retry-After` header,
 * or `undefined` when absent/unparseable. Handles both header forms: an integer
 * count of seconds, and an HTTP date to wait until (clamped to `>= 0`).
 */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = object.toNumber(trimmed, { separators: false, percent: false });
  if (seconds !== undefined) return Math.max(0, seconds) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - nowMs);
}

/**
 * Backoff (ms) before retry `attempt` (0-based): exponential from
 * `baseDelayMs`, capped at `maxDelayMs`, with up to +50% jitter so concurrent
 * retries from one agent don't resynchronize into the next burst. A server-sent
 * `Retry-After` wins outright (still capped), since the server knows better
 * than our schedule when it will accept traffic again.
 */
export function backoffDelayMs(
  attempt: number,
  retry: RetryConfig,
  retryAfterMs: number | undefined,
  jitter: number,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, retry.maxDelayMs);
  const exponential = retry.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, retry.maxDelayMs);
  return Math.round(capped * (1 + jitter * 0.5));
}

/**
 * {@link upstreamFetch} with in-proxy `429` handling. When `retry.enabled`, a
 * 429 is retried up to `retry.maxRetries` times with {@link backoffDelayMs}
 * backoff instead of being surfaced; the throttled response body is drained
 * each time so the connection is released. The retry happens BEFORE the caller
 * writes any status line, so it is transparent to both streaming and
 * non-streaming paths - the client only ever sees the final response.
 *
 * Bails early (returning the 429) when retries are exhausted, when the client
 * has hung up (`signal.aborted`), or when the response carries no `Retry-After`
 * and we would otherwise loop blind past the cap.
 */
async function upstreamFetchRetrying(
  backend: ModelProxyBackend,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  res: ServerResponse,
  retry: RetryConfig,
): Promise<Response> {
  const signal = clientAbortSignal(res);
  const payload = JSON.stringify(body);
  let response = await upstreamFetch(url, headers, payload, signal);
  if (!retry.enabled) return response;

  for (let attempt = 0; response.status === 429 && attempt < retry.maxRetries; attempt++) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
    const delayMs = backoffDelayMs(attempt, retry, retryAfterMs, jitterFraction());
    // Release the throttled response's socket before waiting; its body is an
    // error payload we are choosing not to relay.
    await response.body?.cancel().catch(() => {});
    logger.warn("upstream 429; backing off", {
      attempt: attempt + 1,
      maxRetries: retry.maxRetries,
      delayMs,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
    try {
      await sharedAsync.sleep(delayMs, signal);
    } catch {
      // Client hung up mid-wait: return the last 429 rather than issue a
      // request no one is listening for.
      return response;
    }
    // Fresh auth header per attempt so a long backoff can't outlive the token.
    const retryHeaders = { ...headers, ...(await backend.authHeaders()) };
    response = await upstreamFetch(url, retryHeaders, payload, signal);
  }
  return response;
}

/**
 * Jitter fraction in `[0, 1)`. Split out so tests can stub determinism;
 * `Math.random` is fine for spreading retry timing.
 */
function jitterFraction(): number {
  return Math.random();
}

/**
 * Build and start the proxy, resolving once it is accepting connections.
 * Returns the server and its base URL (with the actually-bound port, so a
 * `port: 0` request surfaces the OS-assigned port).
 */
export async function startProxyServer(
  backend: ModelProxyBackend,
  options: StartProxyOptions = {},
): Promise<{ server: Server; url: string }> {
  const host = options.host ?? DEFAULT_BIND_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const server = createProxyServer(backend, options);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://${host}:${boundPort}` };
}

async function handleRequest(
  backend: ModelProxyBackend,
  options: ProxyServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawUrl = req.url ?? "/";
  const [path, query = ""] = rawUrl.split("?");
  const routePath = path ?? "/";
  try {
    if (req.method === "GET" && (routePath === "/health" || routePath === "/")) {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (options.apiKey && !isAuthorized(req, options.apiKey)) {
      sendJson(res, 401, errorBody("invalid api key", "invalid_request_error"));
      return;
    }
    if (req.method === "GET" && MODELS_PATHS.has(routePath)) {
      // Codex always sends `?client_version=…`; use that to pick its list shape.
      const wantsCodexShape = new URLSearchParams(query).has("client_version");
      await handleModels(backend, res, wantsCodexShape);
      return;
    }
    const retry = options.retry ?? DEFAULT_RETRY;
    if (req.method === "POST" && RESPONSES_PATHS.has(routePath)) {
      await handleResponses(backend, req, res, retry);
      return;
    }
    if (req.method === "POST" && PROXY_PATHS.has(routePath)) {
      await handleProxy(backend, req, res, retry);
      return;
    }
    sendJson(
      res,
      404,
      errorBody(`unsupported route ${req.method ?? "?"} ${routePath}`, "invalid_request_error"),
    );
  } catch (err) {
    const message = error.errorMessage(err);
    logger.error("request failed", { path: routePath, error: message });
    if (!res.headersSent) sendJson(res, 500, errorBody(message, "proxy_error"));
    else res.end();
  }
}

/**
 * `GET /v1/models`: surface the serving catalogue. Two shapes:
 *
 *   - OpenAI (default): `{object:"list", data:[{id,object,created,owned_by}]}`,
 *     what the `openai` SDK and most tools expect.
 *   - Codex (`codexShape`): `{models:[{slug, display_name, …}]}`, the ChatGPT
 *     backend shape the Codex CLI decodes. A response missing the top-level
 *     `models` field makes Codex log "failed to decode models response", so it
 *     gets its own envelope. Only chat endpoints are advertised to Codex.
 */
async function handleModels(
  backend: ModelProxyBackend,
  res: ServerResponse,
  codexShape: boolean,
): Promise<void> {
  const endpoints = await backend.models(true);
  if (codexShape) {
    const models = endpoints
      .filter((endpoint) => classify.endpointCapabilities(endpoint).tools)
      .map((endpoint) => ({
        slug: endpoint.name,
        display_name: endpoint.displayName ?? endpoint.name,
        ...(endpoint.description ? { description: endpoint.description } : {}),
        // Fields Codex's strict decoder requires on every model entry.
        default_reasoning_level: "medium",
        supported_reasoning_levels: [] as string[],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
      }));
    sendJson(res, 200, { models });
    return;
  }
  const data = endpoints.map((endpoint) => ({
    id: endpoint.name,
    object: "model",
    created: 0,
    owned_by: "databricks",
  }));
  sendJson(res, 200, { object: "list", data });
}

/**
 * Resolve the request's model and forward a Chat Completions body. Responses-
 * only models (Codex) are translated to a Responses request and posted to
 * `/serving-endpoints/responses`; everything else goes to `/invocations`.
 */
async function handleProxy(
  backend: ModelProxyBackend,
  req: IncomingMessage,
  res: ServerResponse,
  retry: RetryConfig,
): Promise<void> {
  const body = await readJsonBody(req);
  const requested = typeof body.model === "string" ? body.model : undefined;
  if (!requested) {
    sendJson(res, 400, errorBody("missing 'model' in request body", "invalid_request_error"));
    return;
  }

  const requiresTools = Array.isArray(body.tools) && body.tools.length > 0;
  const resolved = await resolveRequestedModel(backend, requested, requiresTools, res);
  if (!resolved) return;
  body.model = resolved.modelId;

  if (backend.isResponsesOnly(resolved.modelId)) {
    await proxyChatViaResponses(
      backend,
      body,
      requested,
      resolved.modelId,
      resolved.matched,
      res,
      retry,
    );
    return;
  }

  // This route forwards the client's body as-is, so anything Databricks refuses
  // to parse fails the turn. Drop the known offenders rather than relaying a
  // 400 the client can do nothing about.
  const dropped = openaiChat.stripUnsupportedChatFields(body, extraDropFields());

  const wantsStream = body.stream === true;
  const headers = await backend.authHeaders();
  headers["content-type"] = "application/json";
  headers.accept = wantsStream ? "text/event-stream" : "application/json";

  logger.info("proxy", {
    requested,
    resolved: resolved.modelId,
    matched: resolved.matched,
    upstream: "invocations",
    stream: wantsStream,
    ...(dropped.length > 0 ? { dropped } : {}),
  });

  const upstream = await upstreamFetchRetrying(
    backend,
    backend.invocationsUrl(resolved.modelId),
    headers,
    body,
    res,
    retry,
  );

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "x-resolved-model": resolved.modelId,
  });
  await streamBody(upstream, res);
}

/**
 * Chat Completions client → Responses-only Databricks model: translate the
 * request, POST to `/serving-endpoints/responses`, translate the reply back.
 * Streaming is not translated yet - those clients should use `/v1/responses`.
 */
async function proxyChatViaResponses(
  backend: ModelProxyBackend,
  body: Record<string, unknown>,
  requested: string,
  modelId: string,
  matched: boolean,
  res: ServerResponse,
  retry: RetryConfig,
): Promise<void> {
  const { responses, stream } = chatToResponsesRequest(body);
  responses.model = modelId;

  if (stream) {
    sendJson(
      res,
      400,
      errorBody(
        `model ${modelId} only supports the Responses API; use POST /v1/responses for streaming`,
        "invalid_request_error",
      ),
    );
    return;
  }

  const headers = await backend.authHeaders();
  headers["content-type"] = "application/json";
  headers.accept = "application/json";

  const upstreamUrl = backend.responsesUrl(modelId);
  const forward = upstreamUrl.includes("/open-responses")
    ? sanitizeOpenResponsesRequest(responses)
    : responses;

  logger.info("proxy", {
    requested,
    resolved: modelId,
    matched,
    upstream: upstreamUrl,
    stream: false,
  });

  const upstream = await upstreamFetchRetrying(backend, upstreamUrl, headers, forward, res, retry);

  if (!upstream.ok) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text || JSON.stringify(errorBody("upstream error", "proxy_error")));
    return;
  }

  const responseJson = (await upstream.json()) as Record<string, unknown>;
  sendJson(res, 200, responseToChatCompletion(responseJson, modelId));
}

/**
 * `POST /v1/responses`: forward the Responses body to Databricks' native
 * Responses / Open Responses surface (model stays in the body; URL is
 * workspace-level). Streaming and non-streaming both pass through as-is.
 *
 * Open Responses (Claude/Gemini/…) only accepts `function` tools and
 * `input_*` content part types, and rejects replayed Claude thinking
 * blocks — so Codex's built-in tools, prior-turn `output_text`, and
 * `redacted_thinking` / `thinking` / `reasoning` parts are rewritten or
 * stripped there. The OpenAI `/responses` path keeps them - GPT supports
 * those shapes.
 */
async function handleResponses(
  backend: ModelProxyBackend,
  req: IncomingMessage,
  res: ServerResponse,
  retry: RetryConfig,
): Promise<void> {
  const body = await readJsonBody(req);
  const requested = typeof body.model === "string" ? body.model : undefined;
  if (!requested) {
    sendJson(res, 400, errorBody("missing 'model' in request body", "invalid_request_error"));
    return;
  }

  const requiresTools = Array.isArray(body.tools) && body.tools.length > 0;
  const resolved = await resolveRequestedModel(backend, requested, requiresTools, res);
  if (!resolved) return;
  body.model = resolved.modelId;

  const upstreamUrl = backend.responsesUrl(resolved.modelId);
  // Cross-provider Open Responses rejects non-function tools and `output_*`
  // content parts in `input`; OpenAI `/responses` keeps Codex's native shapes.
  const forward = upstreamUrl.includes("/open-responses")
    ? sanitizeOpenResponsesRequest(body)
    : body;

  const wantsStream = forward.stream === true;
  const headers = await backend.authHeaders();
  headers["content-type"] = "application/json";
  headers.accept = wantsStream ? "text/event-stream" : "application/json";

  const stripped =
    Array.isArray(body.tools) &&
    (!Array.isArray(forward.tools) || forward.tools.length !== body.tools.length);

  logger.info("responses", {
    requested,
    resolved: resolved.modelId,
    matched: resolved.matched,
    upstream: upstreamUrl,
    stream: wantsStream,
    ...(stripped ? { strippedNonFunctionTools: true } : {}),
  });

  const upstream = await upstreamFetchRetrying(backend, upstreamUrl, headers, forward, res, retry);

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "x-resolved-model": resolved.modelId,
  });
  await streamBody(upstream, res);
}

/**
 * Resolve one request, filtering fuzzy candidates by tool capability and
 * rejecting an explicit/unknown id that cannot complete the same round-trip.
 */
async function resolveRequestedModel(
  backend: ModelProxyBackend,
  requested: string,
  requiresTools: boolean,
  res: ServerResponse,
): Promise<{ modelId: string; matched: boolean; score?: number } | undefined> {
  const resolved = await backend.resolve(requested, requiresTools ? { requiresTools: true } : {});
  if (!requiresTools) return resolved;
  const endpoint = (await backend.models()).find(
    (candidate) => candidate.name === resolved.modelId,
  );
  if (endpoint && classify.endpointCapabilities(endpoint).tools) return resolved;
  sendJson(
    res,
    400,
    errorBody(`model ${resolved.modelId} does not support function tools`, "invalid_request_error"),
  );
  return undefined;
}

/**
 * Pump an upstream `fetch` Response body to the Node response, chunk by chunk.
 *
 * A mid-stream upstream failure is logged rather than thrown: the status line
 * and some number of chunks have already gone out, so there is no way left to
 * turn it into an HTTP error and the only honest move is to end the response
 * and say why in the log. Without this the read loop rejected into the caller's
 * catch, which found `headersSent` and ended the response silently - making an
 * upstream teardown indistinguishable from a clean finish.
 */
async function streamBody(upstream: Response, res: ServerResponse): Promise<void> {
  const body = upstream.body;
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !res.writableEnded) res.write(Buffer.from(value));
      if (res.writableEnded) break;
    }
  } catch (err) {
    // An aborted request is the expected shape of a client hanging up, not a
    // fault worth reporting at error level.
    const aborted = res.writableEnded || !res.writable;
    logger[aborted ? "info" : "error"]("stream ended early", {
      error: error.errorMessage(err),
    });
  } finally {
    await reader.cancel().catch(() => {});
    res.end();
  }
}

/** True when the request carries the expected bearer token. */
function isAuthorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  return header.replace(/^Bearer\s+/i, "").trim() === apiKey;
}

/**
 * Drain a request body and parse it as a JSON object. An empty, malformed, or
 * non-object body yields `{}`, which the callers reject as a missing `model`.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return json.parseRecord(Buffer.concat(chunks).toString("utf8")) ?? {};
}

/** Serialize and send a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** OpenAI-shaped error envelope. */
function errorBody(message: string, type: string): { error: { message: string; type: string } } {
  return { error: { message, type } };
}
