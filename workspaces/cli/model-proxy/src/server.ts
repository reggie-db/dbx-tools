/**
 * OpenAI-compatible HTTP proxy in front of Databricks Model Serving.
 *
 * Databricks serving endpoints speak OpenAI wire formats, so this server is a
 * thin pass-through: it resolves the request's (possibly fuzzy) `model` to a
 * real endpoint id via the {@link DatabricksBackend}, stamps a fresh auth
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
import { error, log } from "@dbx-tools/shared-core";
import { classify, openaiChat, openaiResponses } from "@dbx-tools/shared-model";

import type { DatabricksBackend } from "./backend";
import { DEFAULT_BIND_HOST, DEFAULT_PORT } from "./defaults";

const { chatToResponsesRequest, responseToChatCompletion, sanitizeResponsesTools } =
  openaiResponses;

const logger = log.logger("model-proxy/server");

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
  return (process.env.PROXY_DROP_FIELDS ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

/** Options shared by {@link createProxyServer} and {@link startProxyServer}. */
export interface ProxyServerOptions {
  /**
   * When set, local clients must present this value as a bearer token
   * (`Authorization: Bearer <key>`). Unset leaves the proxy open, which is fine
   * for a loopback bind but should be paired with a key on a wider one.
   */
  apiKey?: string;
}

/** Options for {@link startProxyServer}, adding the listen address. */
export interface StartProxyOptions extends ProxyServerOptions {
  host?: string;
  port?: number;
}

/** Build (but do not start) the proxy HTTP server. */
export function createProxyServer(
  backend: DatabricksBackend,
  options: ProxyServerOptions = {},
): Server {
  return createServer((req, res) => {
    void handleRequest(backend, options, req, res);
  });
}

/**
 * Build and start the proxy, resolving once it is accepting connections.
 * Returns the server and its base URL (with the actually-bound port, so a
 * `port: 0` request surfaces the OS-assigned port).
 */
export async function startProxyServer(
  backend: DatabricksBackend,
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
  backend: DatabricksBackend,
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
    if (req.method === "POST" && RESPONSES_PATHS.has(routePath)) {
      await handleResponses(backend, req, res);
      return;
    }
    if (req.method === "POST" && PROXY_PATHS.has(routePath)) {
      await handleProxy(backend, req, res);
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
  backend: DatabricksBackend,
  res: ServerResponse,
  codexShape: boolean,
): Promise<void> {
  const endpoints = await backend.models(true);
  if (codexShape) {
    const models = endpoints
      .filter((endpoint) => classify.endpointCapabilities(endpoint).chat)
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
  backend: DatabricksBackend,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const requested = typeof body.model === "string" ? body.model : undefined;
  if (!requested) {
    sendJson(res, 400, errorBody("missing 'model' in request body", "invalid_request_error"));
    return;
  }

  const resolved = await backend.resolve(requested);
  body.model = resolved.modelId;

  if (backend.isResponsesOnly(resolved.modelId)) {
    await proxyChatViaResponses(backend, body, requested, resolved.modelId, resolved.matched, res);
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

  const upstream = await fetch(backend.invocationsUrl(resolved.modelId), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

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
  backend: DatabricksBackend,
  body: Record<string, unknown>,
  requested: string,
  modelId: string,
  matched: boolean,
  res: ServerResponse,
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

  logger.info("proxy", {
    requested,
    resolved: modelId,
    matched,
    upstream: "responses",
    stream: false,
  });

  const upstream = await fetch(backend.responsesUrl(modelId), {
    method: "POST",
    headers,
    body: JSON.stringify(responses),
  });

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
 * Open Responses (Claude/Gemini/…) only accepts `function` tools, so Codex's
 * built-in `web_search` / `local_shell` / … are stripped there. The OpenAI
 * `/responses` path keeps them - GPT models support those tool types.
 */
async function handleResponses(
  backend: DatabricksBackend,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const requested = typeof body.model === "string" ? body.model : undefined;
  if (!requested) {
    sendJson(res, 400, errorBody("missing 'model' in request body", "invalid_request_error"));
    return;
  }

  const resolved = await backend.resolve(requested);
  body.model = resolved.modelId;

  const upstreamUrl = backend.responsesUrl(resolved.modelId);
  // Cross-provider Open Responses rejects non-function tool types; OpenAI
  // `/responses` keeps Codex built-ins (web_search, local_shell, custom, …).
  const forward = upstreamUrl.includes("/open-responses")
    ? sanitizeResponsesTools(body)
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

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(forward),
  });

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "x-resolved-model": resolved.modelId,
  });
  await streamBody(upstream, res);
}

/** Pump an upstream `fetch` Response body to the Node response, chunk by chunk. */
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

/** Drain a request body and parse it as JSON (empty body parses to `{}`). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
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
