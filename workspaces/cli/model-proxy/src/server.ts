/**
 * OpenAI-compatible HTTP proxy in front of Databricks Model Serving.
 *
 * Databricks serving endpoints already speak the OpenAI wire format, so this
 * server is a thin pass-through: it resolves the request's (possibly fuzzy)
 * `model` to a real endpoint id via the {@link DatabricksBackend}, stamps a
 * fresh auth header, and forwards the body to that endpoint's `invocations`
 * URL, streaming the response straight back to the client. Any
 * OpenAI-compatible tool (iTerm, editors, the `openai` SDK) can point its base
 * URL at this server and use loose model names.
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
 *   - `POST /v1/responses`               OpenAI Responses API, translated to a
 *     chat-completions `invocations` call and back (Databricks endpoints speak
 *     only chat completions). This is the surface the Codex CLI uses to chat.
 *
 * @module
 */

import { error, log } from "@dbx-tools/shared-core";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { DatabricksBackend } from "./backend";
import { DEFAULT_BIND_HOST, DEFAULT_PORT } from "./defaults";
import {
  chatToResponse,
  createResponsesStreamTranslator,
  responsesToChat,
} from "./responses";

const logger = log.logger("model-proxy/server");

/** POST routes forwarded verbatim to a serving endpoint's invocations URL. */
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

/** POST routes that carry an OpenAI Responses API body (translated to chat). */
const RESPONSES_PATHS = new Set(["/v1/responses", "/responses"]);

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
      .filter((endpoint) => endpoint.task === "llm/v1/chat")
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
 * Resolve the request's model to a real endpoint, then forward the body to that
 * endpoint's invocations URL with fresh auth, streaming the upstream response
 * (SSE or JSON) straight back to the client.
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
  // Address the endpoint by URL; rewrite the body's `model` to the real id so
  // pay-per-token endpoints that echo it still see a valid value.
  body.model = resolved.modelId;

  const wantsStream = body.stream === true;
  const headers = await backend.authHeaders();
  headers["content-type"] = "application/json";
  headers.accept = wantsStream ? "text/event-stream" : "application/json";

  logger.info("proxy", {
    requested,
    resolved: resolved.modelId,
    matched: resolved.matched,
    stream: wantsStream,
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
 * `POST /v1/responses`: accept an OpenAI Responses request (what the Codex CLI
 * sends), translate it to a chat-completions call against the resolved
 * Databricks endpoint, and translate the reply back to the Responses shape —
 * streaming (SSE) or not, matching the request's `stream` flag.
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
  const { chat, stream } = responsesToChat(body);
  chat.model = resolved.modelId; // address by URL; keep a valid echoed id

  const headers = await backend.authHeaders();
  headers["content-type"] = "application/json";
  headers.accept = stream ? "text/event-stream" : "application/json";

  logger.info("responses", {
    requested,
    resolved: resolved.modelId,
    matched: resolved.matched,
    stream,
  });

  const upstream = await fetch(backend.invocationsUrl(resolved.modelId), {
    method: "POST",
    headers,
    body: JSON.stringify(chat),
  });

  // Upstream error: forward its status with an OpenAI-shaped body rather than
  // half-opening an SSE stream Codex can't parse.
  if (!upstream.ok) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text || JSON.stringify(errorBody("upstream error", "proxy_error")));
    return;
  }

  const responseId = `resp_${resolved.modelId}_${Date.now().toString(36)}`;

  if (!stream) {
    const chatJson = (await upstream.json()) as Record<string, unknown>;
    sendJson(res, 200, chatToResponse(chatJson, resolved.modelId));
    return;
  }

  // Streaming: translate the upstream chat SSE into the Responses SSE stream.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-resolved-model": resolved.modelId,
  });
  await translateChatSseToResponses(upstream, res, resolved.modelId, responseId);
}

/**
 * Read an upstream chat-completions SSE stream and write the translated
 * Responses SSE stream to `res`. Parses the `data:` lines, hands each
 * `chat.completion.chunk` to the translator, and emits the closing
 * `response.completed` on the terminal `[DONE]` (or stream end).
 */
async function translateChatSseToResponses(
  upstream: Response,
  res: ServerResponse,
  model: string,
  responseId: string,
): Promise<void> {
  const translator = createResponsesStreamTranslator(model, responseId);
  const bodyStream = upstream.body;
  if (!bodyStream) {
    res.end(translator.finish());
    return;
  }
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const flushDone = () => {
    if (finished) return;
    finished = true;
    if (!res.writableEnded) res.write(translator.finish());
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines; process complete lines.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          flushDone();
          continue;
        }
        try {
          const chunk = JSON.parse(payload) as Record<string, unknown>;
          const out = translator.feed(chunk);
          if (out && !res.writableEnded) res.write(out);
        } catch {
          // Ignore keepalives / partial or non-JSON data lines.
        }
        if (res.writableEnded) break;
      }
      if (res.writableEnded) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    flushDone();
    res.end();
  }
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
