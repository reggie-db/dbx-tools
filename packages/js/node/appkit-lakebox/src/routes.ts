import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { type Duplex, PassThrough, Readable } from "node:stream";
import { ACCESS_TOKEN_HEADER, USER_EMAIL_HEADER, USER_ID_HEADER } from "@dbx-tools/appkit";
import type { SshSession } from "@dbx-tools/lakebox/session";
import { errorUtils, log } from "@dbx-tools/shared-core";
import type { LakeboxUser } from "@dbx-tools/shared-lakebox";
import type { NextFunction, Request, Response } from "express";
import ProxyModule from "http-proxy-3";
import type { LakeboxServiceRoute } from "./services.ts";

const MAX_PENDING_BYTES = 1024 * 1024;
const FORWARDING_READY_TIMEOUT_MS = 15_000;
const logger = log.logger("appkit-lakebox:routes");

/** Result of resolving one user's service for a routed request. */
export type LakeboxRouteResolution =
  | { kind: "ready"; session: SshSession; route: LakeboxServiceRoute }
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "missing" };

/** Runtime callbacks that authorize and resolve deterministic routes. */
export interface LakeboxRouteResolver {
  /** Returns the authenticated Lakebox user for request headers, or `undefined`. */
  user(headers: IncomingHttpHeaders): LakeboxUser | undefined;
  /**
   * Resolves a running service. Returns `loading` after starting the Lakebox
   * or service in the background, and `missing` for an unknown service.
   */
  resolve(user: LakeboxUser, service: string): Promise<LakeboxRouteResolution>;
  /** Reports that a ready service refused a forwarded connection. */
  unavailable(user: LakeboxUser, service: string): void;
}

interface RouteMatch {
  userHash: string;
  service: string;
  mount: string;
}

interface Bridge {
  session: SshSession;
  server: Server;
  target: { host: string; port: number; protocol: string };
  sockets: Set<Socket>;
}

interface PendingResponse {
  user: LakeboxUser;
  service: string;
  head?: string;
}

/**
 * Proxies `<prefix>/<user-hash>/<service>` to that user's service port.
 *
 * The user hash is the only routing key. A request is forwarded only when its
 * authenticated identity hashes to the same value, and the port is derived from
 * the hash and service name, so there is no stored route table. Requests
 * without an identity are rejected with 404, including WebSocket upgrades.
 */
export class LakeboxRouteRegistry {
  private readonly bridges = new Map<number, Bridge>();
  private readonly upgrades = new Set<Socket>();
  private readonly pending = new WeakMap<IncomingMessage, PendingResponse>();
  private readonly proxy = ProxyModule.createProxyServer({ ws: true, xfwd: true });
  private shuttingDown = false;

  /** Creates a registry beneath one AppKit route prefix. */
  constructor(
    private readonly prefix: string,
    private readonly resolver: LakeboxRouteResolver,
    private readonly forwardingReadyTimeoutMs = FORWARDING_READY_TIMEOUT_MS,
  ) {
    this.proxy.on("error", (error, request, response) => {
      if (this.shuttingDown && isConnectionClosureError(error)) {
        response.destroy();
        return;
      }
      const pending = this.pending.get(request);
      if (pending && "writeHead" in response && !response.headersSent) {
        this.resolver.unavailable(pending.user, pending.service);
        sendLoadingResponse(request.headers.accept, response);
        return;
      }
      logger.warn("Lakebox route proxy failed", {
        method: request.method,
        path: request.url,
        error,
      });
      if ("writeHead" in response) {
        if (response.headersSent) {
          response.destroy();
        } else {
          response.writeHead(502);
          response.end("Lakebox route unavailable");
        }
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
    this.proxy.on("proxyRes", (proxyResponse, request, response) => {
      const pending = this.pending.get(request);
      if (pending && [502, 503, 504].includes(proxyResponse.statusCode ?? 0)) {
        proxyResponse.resume();
        this.resolver.unavailable(pending.user, pending.service);
        sendLoadingResponse(request.headers.accept, response);
        return;
      }
      if (pending?.head) {
        void injectHtmlHead(proxyResponse, response, pending.head);
        return;
      }
      pipeProxyResponse(proxyResponse, response);
    });
  }

  /** Returns the route path segment match for a request path. */
  match(path: string): RouteMatch | undefined {
    const root = this.prefix.replace(/\/+$/, "");
    if (!path.startsWith(`${root}/`)) return undefined;
    const [userHash, service] = path.slice(root.length + 1).split("/");
    if (!userHash || !service) return undefined;
    return { userHash, service, mount: `${root}/${userHash}/${service}` };
  }

  /** Express middleware that authorizes, rewrites, and proxies matching requests. */
  middleware() {
    return async (request: Request, response: Response, next: NextFunction) => {
      const match = this.match(request.path);
      if (!match) return next();
      const user = this.authorize(request.headers, match);
      if (!user) {
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }
      if (request.path === match.mount) {
        response.statusCode = 308;
        response.setHeader("location", routeRedirectUrl(request.url, match.mount));
        response.end();
        return;
      }
      let resolution: LakeboxRouteResolution;
      try {
        resolution = await this.resolver.resolve(user, match.service);
      } catch (error) {
        return next(error);
      }
      if (resolution.kind === "missing") {
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }
      if (resolution.kind === "loading") {
        sendLoadingResponse(request.header("accept"), response);
        return;
      }
      if (resolution.kind === "failed") {
        response.statusCode = 502;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end(`Lakebox service failed: ${resolution.message}`);
        return;
      }
      const bridge = await this.bridge(resolution.session, resolution.route.port);
      const head =
        request.method === "GET" && request.path === `${match.mount}/`
          ? resolution.route.htmlHead
          : undefined;
      if (head) request.headers["accept-encoding"] = "identity";
      this.pending.set(request, { user, service: match.service, ...(head ? { head } : {}) });
      const replayBody = replayParsedJsonBody(request);
      if (resolution.route.stripPrefix) request.url = outboundPath(request.url, match.mount);
      stripIdentityHeaders(request);
      this.proxy.web(request, response, {
        target: bridge.target,
        changeOrigin: true,
        selfHandleResponse: true,
        ...(replayBody ? { buffer: replayBody } : {}),
      });
    };
  }

  /** Number of open forwarded HTTP and WebSocket connections. */
  activeConnections(): number {
    let count = this.upgrades.size;
    for (const bridge of this.bridges.values()) count += bridge.sockets.size;
    return count;
  }

  /** Returns whether an upgrade path belongs to the Lakebox route prefix. */
  canHandleUpgrade(path: string): boolean {
    return Boolean(this.match(path));
  }

  /** Proxies an authorized WebSocket upgrade. Returns false when it was not handled. */
  async handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = this.match(url.pathname);
    if (!match) return false;
    const user = this.authorize(request.headers, match);
    if (!user) return false;
    const resolution = await this.resolver.resolve(user, match.service);
    if (resolution.kind !== "ready") return false;
    if (resolution.route.stripPrefix) request.url = outboundPath(request.url, match.mount);
    this.upgrades.add(socket);
    socket.once("close", () => this.upgrades.delete(socket));
    proxyWebSocket(
      request,
      socket,
      head,
      resolution.session,
      resolution.route.port,
      this.forwardingReadyTimeoutMs,
    );
    return true;
  }

  /** Closes every forwarding bridge, for example after the Lakebox stops. */
  async closeBridges(): Promise<void> {
    this.upgrades.forEach((socket) => socket.destroy());
    this.upgrades.clear();
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.all(bridges.map(closeBridge));
  }

  /** Suppresses expected proxy errors once shutdown begins. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** Closes bridges and the shared proxy. */
  async close(): Promise<void> {
    this.beginShutdown();
    await this.closeBridges();
    this.proxy.close();
  }

  private authorize(headers: IncomingHttpHeaders, match: RouteMatch): LakeboxUser | undefined {
    const user = this.resolver.user(headers);
    return user?.hash === match.userHash ? user : undefined;
  }

  private async bridge(session: SshSession, port: number): Promise<Bridge> {
    const existing = this.bridges.get(port);
    if (existing?.session === session) return existing;
    if (existing) {
      this.bridges.delete(port);
      void closeBridge(existing);
    }
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      bridgeSocket(socket, session.forwardOut("127.0.0.1", port), this.forwardingReadyTimeoutMs);
    });
    const target = await listenTarget(server);
    const bridge = { session, server, target, sockets };
    const raced = this.bridges.get(port);
    if (raced?.session === session) {
      void closeBridge(bridge);
      return raced;
    }
    this.bridges.set(port, bridge);
    return bridge;
  }
}

async function closeBridge(bridge: Bridge): Promise<void> {
  bridge.sockets.forEach((socket) => socket.destroy());
  await closeServer(bridge.server);
}

function stripIdentityHeaders(request: IncomingMessage): void {
  for (const name of [ACCESS_TOKEN_HEADER, "authorization", "cookie"]) delete request.headers[name];
}

function sendLoadingResponse(
  accept: string | string[] | undefined,
  response: Pick<ServerResponse, "statusCode" | "setHeader" | "end">,
): void {
  response.statusCode = 202;
  response.setHeader("cache-control", "no-store");
  response.setHeader("retry-after", "2");
  const acceptsHtml = (Array.isArray(accept) ? accept.join(",") : (accept ?? ""))
    .toLowerCase()
    .includes("text/html");
  if (!acceptsHtml) {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ status: "loading", message: "Starting Lakebox service" }));
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="2">
<title>Starting Lakebox service</title>
<style>
html{color-scheme:light dark;font-family:system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;background:Canvas;color:CanvasText}.loading{display:flex;align-items:center;gap:.75rem}.spinner{width:1.25rem;height:1.25rem;border:.2rem solid color-mix(in srgb,CanvasText 20%,transparent);border-top-color:CanvasText;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body><div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>Starting Lakebox service</span></div></body>
</html>`);
}

function isConnectionClosureError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ERR_STREAM_DESTROYED"
  );
}

function replayParsedJsonBody(request: Request): Readable | undefined {
  if (!request.readableEnded || request.body === undefined) return undefined;
  if (!request.header("content-type")?.toLowerCase().includes("json")) return undefined;
  const body = Buffer.from(JSON.stringify(request.body));
  request.headers["content-length"] = String(body.byteLength);
  delete request.headers["transfer-encoding"];
  return Readable.from(body);
}

async function injectHtmlHead(
  proxyResponse: IncomingMessage,
  response: ServerResponse,
  head: string,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of proxyResponse) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const source = Buffer.concat(chunks).toString("utf8");
    const body = source.includes("<head>")
      ? source.replace("<head>", `<head>${head}`)
      : source.includes("</head>")
        ? source.replace("</head>", `${head}</head>`)
        : source;
    for (const [name, value] of Object.entries(proxyResponse.headers)) {
      if (value === undefined || name === "content-length" || name === "transfer-encoding") {
        continue;
      }
      response.setHeader(name, value);
    }
    response.statusCode = proxyResponse.statusCode ?? 200;
    if (proxyResponse.statusMessage) response.statusMessage = proxyResponse.statusMessage;
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
  } catch (error) {
    logger.warn("Lakebox route HTML injection failed", {
      error: errorUtils.toError(error),
    });
    if (!response.headersSent) response.writeHead(502);
    response.end("Lakebox route unavailable");
  }
}

function pipeProxyResponse(proxyResponse: IncomingMessage, response: ServerResponse): void {
  for (const [name, value] of Object.entries(proxyResponse.headers)) {
    if (value !== undefined) response.setHeader(name, value);
  }
  response.statusCode = proxyResponse.statusCode ?? 200;
  if (proxyResponse.statusMessage) response.statusMessage = proxyResponse.statusMessage;
  proxyResponse.pipe(response);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function routeRedirectUrl(url: string, routePath: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.pathname = `${routePath}/`;
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Keep the AppKit request URL on the inbound IncomingMessage so AppKit's
 * request logging and tracing see the public route. Prefix
 * stripping is applied only on the outbound proxy request.
 */
function outboundPath(requestUrl: string | undefined, stripPrefix?: string): string {
  const url = requestUrl && requestUrl.length > 0 ? requestUrl : "/";
  const queryIndex = url.indexOf("?");
  const pathname = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const query = queryIndex >= 0 ? url.slice(queryIndex) : "";
  if (!stripPrefix) return url.startsWith("/") ? url : `/${url}`;
  return `${pathname.slice(stripPrefix.length) || "/"}${query}`;
}

async function listenTarget(
  server: Server,
): Promise<{ host: string; port: number; protocol: string }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind Lakebox route bridge");
  }
  return { host: "127.0.0.1", port: address.port, protocol: "http:" };
}

function bridgeSocket(
  socket: Socket,
  channelPromise: Promise<Duplex>,
  readyTimeoutMs: number,
  initialData?: Buffer,
): void {
  const pending = new PassThrough({ highWaterMark: MAX_PENDING_BYTES });
  let channel: Duplex | undefined;
  let timedOut = false;
  const readyTimeout = setTimeout(() => {
    timedOut = true;
    pending.destroy();
    channel?.destroy();
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  }, readyTimeoutMs);
  readyTimeout.unref?.();
  const clearReadyTimeout = () => clearTimeout(readyTimeout);
  if (initialData) pending.write(initialData);
  socket.once("error", () => {
    clearReadyTimeout();
    pending.destroy();
    channel?.destroy();
  });
  socket.pipe(pending);
  socket.once("close", () => {
    clearReadyTimeout();
    pending.destroy();
    channel?.destroy();
  });

  void channelPromise.then(
    (openedChannel) => {
      if (timedOut || socket.destroyed) {
        pending.destroy();
        openedChannel.destroy();
        return;
      }
      channel = openedChannel;
      clearReadyTimeout();
      let channelEnded = false;
      channel.once("end", () => {
        channelEnded = true;
      });
      channel.once("close", () => {
        if (!channelEnded && !socket.destroyed) socket.destroy();
      });
      channel.once("error", () => socket.destroy());
      channel.pipe(socket);
      pending.pipe(channel);
    },
    (error) => {
      clearReadyTimeout();
      if (!timedOut && !socket.destroyed) {
        logger.warn("Lakebox route forwarding channel failed", {
          error: errorUtils.toError(error),
        });
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
      pending.destroy();
      if (timedOut || socket.destroyed) socket.destroy();
    },
  );
}

function proxyWebSocket(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  session: SshSession,
  port: number,
  readyTimeoutMs: number,
): void {
  stripWebsocketIdentityHeaders(request);
  request.headers.origin = `http://127.0.0.1:${port}`;
  request.headers.host = `127.0.0.1:${port}`;
  bridgeSocket(
    socket,
    session.forwardOut("127.0.0.1", port),
    readyTimeoutMs,
    serializeUpgradeRequest(request, head),
  );
}

function stripWebsocketIdentityHeaders(request: IncomingMessage): void {
  for (const name of [
    "authorization",
    "cookie",
    ACCESS_TOKEN_HEADER,
    USER_EMAIL_HEADER,
    USER_ID_HEADER,
  ]) {
    delete request.headers[name];
  }
}

function serializeUpgradeRequest(request: IncomingMessage, head: Buffer): Buffer {
  const lines = [
    `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion || "1.1"}`,
  ];
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${name}: ${item}`);
    }
  }
  lines.push("", "");
  return Buffer.concat([Buffer.from(lines.join("\r\n")), head]);
}
