import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ACCESS_TOKEN_HEADER, USER_EMAIL_HEADER, USER_ID_HEADER } from "@dbx-tools/appkit";
import { errorUtils, hash, log } from "@dbx-tools/shared-core";
import type { NextFunction, Request, Response } from "express";
import ProxyModule from "http-proxy-3";
import type { ClientChannel } from "ssh2";
import WebSocket, { WebSocketServer } from "ws";
import type { SshSession } from "./session.ts";

const MAX_PENDING_BYTES = 1024 * 1024;
const logger = log.logger("appkit-sandbox:routes");

interface RouteInput {
  id?: string;
  ownerId: string;
  machineId: string;
  remoteHost: string;
  remotePort: number;
  path?: string;
  stripPrefix?: boolean;
  browserPaths?: string[];
  browserRelay?: boolean;
  redirectToSlash?: boolean;
  htmlHead?: string;
  internal?: boolean;
}

/** In-process forwarding state used by the AppKit proxy. */
export interface SshForwardedRoute {
  id: string;
  machineId: string;
  path: string;
  remoteHost: string;
  remotePort: number;
  stripPrefix: boolean;
  state: "ready";
}

interface RouteTarget {
  route: SshForwardedRoute;
  ownerId: string;
  session: SshSession;
  target?: { host: string; port: number; protocol: string; socketPath?: string };
  server?: Server;
  sockets: Set<Socket>;
  browserPaths: string[];
  browserRelayPath?: string;
  redirectToSlash: boolean;
  htmlHead?: string;
  internal: boolean;
}

interface RouteMatch {
  entry: RouteTarget;
  stripPrefix?: string;
}

/**
 * Owns user-scoped AppKit paths that proxy to HTTP ports over SSH forwarding.
 *
 * Route ownership is checked against AppKit request identity before HTTP or
 * WebSocket traffic reaches the remote service. User hashes only prevent path
 * collisions and do not replace ownership checks.
 */
export class SshRouteRegistry {
  private readonly routes = new Map<string, RouteTarget>();
  private readonly responseHeadInjections = new WeakMap<IncomingMessage, string>();
  private readonly proxy = ProxyModule.createProxyServer({ ws: true, xfwd: true });
  private readonly websocketServer = new WebSocketServer({ noServer: true });

  /** Creates an empty registry beneath one normalized AppKit route prefix. */
  constructor(private readonly prefix: string) {
    this.proxy.on("error", (error, request, response) => {
      logger.warn("SSH route proxy failed", {
        method: request.method,
        path: request.url,
        error,
      });
      if ("writeHead" in response && !response.headersSent) response.writeHead(502);
      if ("end" in response) response.end("SSH route unavailable");
    });
    this.proxy.on("proxyRes", (proxyResponse, request, response) => {
      const head = this.responseHeadInjections.get(request);
      if (!head) return;
      this.responseHeadInjections.delete(request);
      void injectHtmlHead(proxyResponse, response, head);
    });
  }

  /** Lists routes, optionally filtered by machine and owner. Internal routes are excluded by default. */
  list(
    machineId?: string,
    ownerId?: string,
    options: { includeInternal?: boolean } = {},
  ): SshForwardedRoute[] {
    return [...this.routes.values()]
      .filter((entry) => !ownerId || entry.ownerId === ownerId)
      .filter((entry) => options.includeInternal || !entry.internal)
      .map((entry) => entry.route)
      .filter((route) => !machineId || route.machineId === machineId);
  }

  /** Returns the collision-avoidance path namespace for one authenticated user. */
  userPathPrefix(ownerId: string): string {
    return normalizeRoutePath(`${this.prefix}/${hash.fnvHash(ownerId)}`);
  }

  /**
   * Registers or reuses a route and starts its local SSH forwarding bridge.
   *
   * User-created paths are placed beneath {@link userPathPrefix}. Internal
   * built-in service paths must provide their complete reserved path.
   */
  async add(session: SshSession, input: RouteInput): Promise<SshForwardedRoute> {
    const prepared = this.prepare(input);
    if (prepared.previous) return prepared.previous.route;
    const sockets = new Set<Socket>();
    const bridge = createBridge(session, input, sockets);
    const target = await listenTarget(bridge, prepared.route.id);
    this.routes.set(prepared.route.id, {
      route: prepared.route,
      ownerId: input.ownerId,
      session,
      target,
      server: bridge,
      sockets,
      browserPaths: normalizeBrowserPaths(input.browserPaths),
      ...(input.browserRelay ? { browserRelayPath: browserRelayPath(prepared.route.id) } : {}),
      redirectToSlash: input.redirectToSlash ?? false,
      ...optionalHtmlHead(routeHtmlHead(prepared.route.id, input.browserRelay, input.htmlHead)),
      internal: input.internal ?? false,
    });
    return prepared.route;
  }

  /** Removes an owned route, closes active sockets, and deletes its local bridge. */
  async remove(routeId: string, ownerId?: string): Promise<boolean> {
    const entry = this.routes.get(routeId);
    if (!entry || (ownerId && entry.ownerId !== ownerId)) return false;
    this.routes.delete(routeId);
    entry.sockets.forEach((socket) => socket.destroy());
    if (entry.server) await closeServer(entry.server);
    if (entry.target?.socketPath) await rm(entry.target.socketPath, { force: true });
    return true;
  }

  /** Removes every matching route for one machine and optional owner. */
  async removeMachine(machineId: string, ownerId?: string): Promise<void> {
    const routeIds = [...this.routes.values()]
      .filter((entry) => !ownerId || entry.ownerId === ownerId)
      .filter((entry) => entry.route.machineId === machineId)
      .map((entry) => entry.route.id);
    await Promise.all(routeIds.map((routeId) => this.remove(routeId, ownerId)));
  }

  /**
   * Returns Express middleware that authorizes, rewrites, and proxies matching
   * HTTP requests. Unmatched requests continue to the next AppKit handler.
   */
  middleware() {
    return (request: Request, response: Response, next: NextFunction) => {
      const requestUser = request.header(USER_ID_HEADER) ?? request.header(USER_EMAIL_HEADER);
      const direct = this.directRoute(request.path);
      if (direct && requestUser !== direct.ownerId) {
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }
      const match = this.match(request.path, request.headers, requestUser);
      if (!match) return next();
      if (
        match.entry.browserRelayPath &&
        requestUser === match.entry.ownerId &&
        pathMatches(request.path, match.entry.route.path)
      ) {
        response.setHeader("set-cookie", routeCookie(match.entry.route.id));
      }
      if (request.path === match.entry.route.path && match.entry.browserRelayPath) {
        sendBrowserRelayBootstrap(response, match.entry.route.path, match.entry.route.id);
        return;
      }
      if (request.path === match.entry.route.path && match.entry.redirectToSlash) {
        response.statusCode = 308;
        response.setHeader("location", routeRedirectUrl(request.url, match.entry.route.path));
        response.end();
        return;
      }
      const injectHead =
        request.method === "GET" && request.path === `${match.entry.route.path}/`
          ? match.entry.htmlHead
          : undefined;
      if (match.stripPrefix) rewriteRequestUrl(request, match.stripPrefix);
      if (injectHead) {
        request.headers["accept-encoding"] = "identity";
        this.responseHeadInjections.set(request, injectHead);
      }
      const replayBody = replayParsedJsonBody(request);
      this.proxy.web(request, response, {
        target: match.entry.target!,
        changeOrigin: true,
        selfHandleResponse: Boolean(injectHead),
        ...(replayBody ? { buffer: replayBody } : {}),
      });
    };
  }

  /** Proxies an authorized matching HTTP Upgrade request, including WebSockets. */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestUser =
      headerValue(request.headers[USER_ID_HEADER]) ??
      headerValue(request.headers[USER_EMAIL_HEADER]);
    const match = this.match(url.pathname, request.headers, requestUser);
    if (!match) {
      if (pathMatches(url.pathname, "/__srv")) {
        socket.destroy();
        return true;
      }
      return false;
    }
    if (match.stripPrefix) rewriteIncomingUrl(request, match.stripPrefix, url.pathname);
    proxyWebSocket(request, socket, head, match.entry, this.websocketServer);
    return true;
  }

  /** Returns whether an upgrade path belongs to a registered route or browser relay. */
  canHandleUpgrade(path: string): boolean {
    if (this.directRoute(path)) return true;
    return [...this.routes.values()].some(
      (entry) =>
        Boolean(entry.browserRelayPath && pathMatches(path, entry.browserRelayPath)) ||
        entry.browserPaths.some((alias) => pathMatches(path, alias)),
    );
  }

  /** Removes every route and closes the shared HTTP/WebSocket proxy. */
  async close(): Promise<void> {
    await Promise.all([...this.routes.keys()].map((routeId) => this.remove(routeId)));
    this.proxy.close();
  }

  private prepare(input: RouteInput): { route: SshForwardedRoute; previous?: RouteTarget } {
    const path = input.internal
      ? normalizeRoutePath(requiredInternalPath(input.path))
      : this.userRoutePath(input);
    const stripPrefix = input.stripPrefix ?? path !== "/";
    const previous = [...this.routes.values()].find((entry) => entry.route.path === path);
    if (previous) {
      if (previous.ownerId !== input.ownerId) {
        throw new Error(`SSH route path ${path} is already owned by another user`);
      }
      if (
        previous.route.machineId !== input.machineId ||
        previous.route.remoteHost !== input.remoteHost ||
        previous.route.remotePort !== input.remotePort ||
        previous.route.stripPrefix !== stripPrefix
      ) {
        throw new Error(`SSH route path ${path} already forwards to a different target`);
      }
      const requestedBrowserPaths = normalizeBrowserPaths(input.browserPaths);
      if (requestedBrowserPaths.join("\0") !== previous.browserPaths.join("\0")) {
        throw new Error(`SSH route path ${path} already has different browser aliases`);
      }
      if (
        Boolean(input.browserRelay) !== Boolean(previous.browserRelayPath) ||
        (input.redirectToSlash ?? false) !== previous.redirectToSlash ||
        routeHtmlHead(previous.route.id, input.browserRelay, input.htmlHead) !==
          previous.htmlHead ||
        (input.internal ?? false) !== previous.internal
      ) {
        throw new Error(`SSH route path ${path} already has different browser behavior`);
      }
      return { route: previous.route, previous };
    }
    const id = input.id ?? randomBytes(16).toString("hex");
    return {
      route: {
        id,
        machineId: input.machineId,
        path,
        remoteHost: input.remoteHost,
        remotePort: input.remotePort,
        stripPrefix,
        state: "ready",
      },
    };
  }

  private userRoutePath(input: RouteInput): string {
    const prefix = this.userPathPrefix(input.ownerId);
    if (!input.path) {
      return normalizeRoutePath(`${prefix}/${slug(input.machineId)}-${input.remotePort}`);
    }
    const requested = normalizeRoutePath(input.path);
    if (pathMatches(requested, prefix) && requested !== prefix) return requested;
    if (pathMatches(requested, normalizeRoutePath(this.prefix))) {
      throw new Error(`SSH route path ${requested} must be beneath ${prefix}`);
    }
    return normalizeRoutePath(`${prefix}/${requested}`);
  }

  private match(
    path: string,
    headers: IncomingMessage["headers"],
    requestUser: string | undefined,
  ): RouteMatch | undefined {
    const direct = this.directRoute(path);
    if (direct && requestUser === direct.ownerId) {
      return {
        entry: direct,
        ...(direct.route.stripPrefix ? { stripPrefix: direct.route.path } : {}),
      };
    }

    const cookieRouteId = cookieValue(headers.cookie, ROUTE_COOKIE);
    const referer = headerValue(headers.referer);
    const browserRelay = [...this.routes.values()].find(
      (entry) =>
        entry.browserRelayPath &&
        pathMatches(path, entry.browserRelayPath) &&
        (requestUser ? requestUser === entry.ownerId : cookieRouteId === entry.route.id),
    );
    if (browserRelay) return { entry: browserRelay, stripPrefix: browserRelay.browserRelayPath };
    return [...this.routes.values()]
      .filter((entry) => !requestUser || requestUser === entry.ownerId)
      .filter((entry) => entry.browserPaths.some((alias) => pathMatches(path, alias)))
      .filter(
        (entry) =>
          cookieRouteId === entry.route.id ||
          Boolean(referer && pathMatches(refererPath(referer) ?? "", entry.route.path)),
      )
      .map((entry) => ({ entry }))[0];
  }

  private directRoute(path: string): RouteTarget | undefined {
    return [...this.routes.values()]
      .filter((entry) => path === entry.route.path || path.startsWith(`${entry.route.path}/`))
      .sort((left, right) => right.route.path.length - left.route.path.length)[0];
  }
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
    const body = source.includes("</head>") ? source.replace("</head>", `${head}</head>`) : source;
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
    logger.warn("SSH route HTML injection failed", {
      error: errorUtils.toError(error),
    });
    if (!response.headersSent) response.writeHead(502);
    response.end("SSH route unavailable");
  }
}

function createBridge(session: SshSession, input: RouteInput, sockets: Set<Socket>): Server {
  return createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    bridgeSocket(socket, session.forwardOut(input.remoteHost, input.remotePort));
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const ROUTE_COOKIE = "dbx_tools_ssh_route";

function normalizeBrowserPaths(paths: string[] | undefined): string[] {
  return [...new Set((paths ?? []).map(normalizePath))].sort();
}

function pathMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function routeCookie(routeId: string): string {
  return `${ROUTE_COOKIE}=${encodeURIComponent(routeId)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function routeRedirectUrl(url: string, routePath: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.pathname = `${routePath}/`;
  return `${parsed.pathname}${parsed.search}`;
}

function browserRelayPath(routeId: string): string {
  return `/__srv/${routeId}`;
}

function routeHtmlHead(
  routeId: string,
  browserRelay: boolean | undefined,
  htmlHead: string | undefined,
): string | undefined {
  const relayHead = browserRelay
    ? `<script>localStorage.setItem("dinotty_device_active_server_v1",${JSON.stringify(routeId)})</script>`
    : "";
  return `${htmlHead ?? ""}${relayHead}` || undefined;
}

function optionalHtmlHead(htmlHead: string | undefined): { htmlHead?: string } {
  return htmlHead ? { htmlHead } : {};
}

function sendBrowserRelayBootstrap(response: Response, routePath: string, routeId: string): void {
  const destination = `${routePath}/`;
  const script = `localStorage.setItem("dinotty_device_active_server_v1",${JSON.stringify(routeId)});location.replace(${JSON.stringify(destination)});`;
  response.statusCode = 200;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening terminal</title></head><body><script>${script}</script></body></html>`,
  );
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const pair of header?.split(";") ?? []) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function refererPath(value: string): string | undefined {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

function rewriteRequestUrl(request: Request, routePath: string): void {
  rewriteIncomingUrl(request, routePath, request.path);
}

function rewriteIncomingUrl(request: IncomingMessage, routePath: string, path: string): void {
  const queryIndex = request.url?.indexOf("?") ?? -1;
  const query = queryIndex >= 0 ? request.url?.slice(queryIndex) : "";
  request.url = `${path.slice(routePath.length) || "/"}${query ?? ""}`;
}

async function listenTarget(
  server: Server,
  id: string,
): Promise<{ host: string; port: number; protocol: string; socketPath?: string }> {
  if (process.platform !== "win32") {
    const socketPath = join(tmpdir(), `dbx-tools-ssh-${id}.sock`);
    await rm(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return { host: "localhost", port: 80, protocol: "http:", socketPath };
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind SSH route proxy");
  return { host: "127.0.0.1", port: address.port, protocol: "http:" };
}

function normalizeRoutePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/api" || normalized.startsWith("/api/")) {
    throw new Error("SSH routes cannot overlap AppKit API routes");
  }
  return normalized;
}

function normalizePath(path: string): string {
  return `/${path.split("/").filter(Boolean).join("/")}`;
}

function requiredInternalPath(path: string | undefined): string {
  if (!path) throw new Error("Internal SSH routes require an explicit path");
  return path;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "machine"
  );
}

function bridgeSocket(socket: Socket, channelPromise: Promise<ClientChannel>): void {
  const pending = new PassThrough({ highWaterMark: MAX_PENDING_BYTES });
  let channel: ClientChannel | undefined;
  socket.pipe(pending);
  socket.once("close", () => {
    pending.destroy();
    channel?.destroy();
  });

  void channelPromise.then(
    (openedChannel) => {
      if (socket.destroyed) {
        pending.destroy();
        openedChannel.destroy();
        return;
      }
      channel = openedChannel;
      socket.once("error", () => channel?.destroy());
      channel.once("error", () => socket.destroy());
      channel.pipe(socket);
      pending.pipe(channel);
    },
    (error) => {
      logger.warn("SSH route forwarding channel failed", {
        error: errorUtils.toError(error),
      });
      pending.destroy();
      socket.destroy();
    },
  );
}

function proxyWebSocket(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  entry: RouteTarget,
  websocketServer: WebSocketServer,
): void {
  entry.sockets.add(socket);
  socket.once("close", () => entry.sockets.delete(socket));
  void entry.session
    .forwardOut(entry.route.remoteHost, entry.route.remotePort)
    .then((channel) => {
      if (socket.destroyed) {
        channel.destroy();
        return;
      }
      const protocols = headerValue(request.headers["sec-websocket-protocol"])
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const options = {
        createConnection: () => channel,
        headers: websocketUpstreamHeaders(request.headers),
      };
      const upstream = protocols?.length
        ? new WebSocket(
            `ws://${entry.route.remoteHost}:${entry.route.remotePort}${request.url ?? "/"}`,
            protocols,
            options,
          )
        : new WebSocket(
            `ws://${entry.route.remoteHost}:${entry.route.remotePort}${request.url ?? "/"}`,
            options,
          );
      upstream.once("open", () => {
        websocketServer.handleUpgrade(request, socket, head, (client) => {
          bridgeWebSockets(client, upstream);
        });
      });
      upstream.once("error", (error) => {
        if (socket.destroyed) return;
        logger.warn("SSH route WebSocket upstream failed", {
          path: request.url,
          error,
        });
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
    })
    .catch((error: unknown) => {
      logger.warn("SSH route WebSocket forwarding failed", {
        path: request.url,
        error: errorUtils.toError(error),
      });
      if (!socket.destroyed) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    });
}

function websocketUpstreamHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
  const excluded = new Set([
    "authorization",
    "connection",
    "cookie",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
    "upgrade",
    ACCESS_TOKEN_HEADER,
    USER_EMAIL_HEADER,
    USER_ID_HEADER,
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string | string[]] =>
        entry[1] !== undefined && !excluded.has(entry[0]),
    ),
  );
}

function bridgeWebSockets(client: WebSocket, upstream: WebSocket): void {
  client.on("message", (data, isBinary) => upstream.send(data, { binary: isBinary }));
  upstream.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
  client.once("close", (code, reason) => closeWebSocket(upstream, code, reason));
  upstream.once("close", (code, reason) => closeWebSocket(client, code, reason));
  client.once("error", () => upstream.terminate());
  upstream.once("error", () => client.terminate());
}

function closeWebSocket(socket: WebSocket, code: number, reason: Buffer): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (code === 1005 || code === 1006 || code === 1015) socket.close();
  else socket.close(code, reason);
}
