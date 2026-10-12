import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { ACCESS_TOKEN_HEADER, USER_EMAIL_HEADER, USER_ID_HEADER } from "@dbx-tools/appkit";
import { errorUtils, hash, log } from "@dbx-tools/shared-core";
import type { NextFunction, Request, Response } from "express";
import ProxyModule from "http-proxy-3";
import type { ClientChannel } from "ssh2";
import type { SshSession } from "./session.ts";

const MAX_PENDING_BYTES = 1024 * 1024;
const logger = log.logger("appkit-sandbox:routes");

type UpgradeSocket = Socket & { destroySoon?: () => void };

interface RouteInput {
  id?: string;
  ownerId: string;
  machineId: string;
  remoteHost: string;
  remotePort: number;
  path?: string;
  stripPrefix?: boolean;
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
  target?: { host: string; port: number; protocol: string };
  server?: Server;
  sockets: Set<Socket>;
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
  private readonly outboundPaths = new WeakMap<IncomingMessage, string>();
  private readonly proxy = ProxyModule.createProxyServer({ ws: true, xfwd: true });

  /** Creates an empty registry beneath one normalized AppKit route prefix. */
  constructor(private readonly prefix: string) {
    this.proxy.on("error", (error, request, response) => {
      logger.warn("SSH route proxy failed", {
        method: request.method,
        path: request.url,
        error,
      });
      if ("writeHead" in response) {
        if (!response.headersSent) response.writeHead(502);
        response.end("SSH route unavailable");
      } else if (!response.destroyed) {
        response.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    });
    this.proxy.on("proxyRes", (proxyResponse, request, response) => {
      const head = this.responseHeadInjections.get(request);
      if (!head) return;
      this.responseHeadInjections.delete(request);
      void injectHtmlHead(proxyResponse, response, head);
    });
    this.proxy.on("proxyReq", (proxyRequest, request) => {
      const path = this.outboundPaths.get(request);
      if (path) proxyRequest.path = path;
    });
    this.proxy.on("proxyReqWs", (proxyRequest, request) => {
      const path = this.outboundPaths.get(request);
      if (path) proxyRequest.path = path;
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
    const target = await listenTarget(bridge);
    this.routes.set(prepared.route.id, {
      route: prepared.route,
      ownerId: input.ownerId,
      session,
      target,
      server: bridge,
      sockets,
      redirectToSlash: input.redirectToSlash ?? false,
      ...optionalHtmlHead(input.htmlHead),
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
      const match = this.match(request.path, requestUser);
      if (!match) return next();
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
      if (injectHead) {
        request.headers["accept-encoding"] = "identity";
        this.responseHeadInjections.set(request, injectHead);
      }
      const replayBody = replayParsedJsonBody(request);
      if (match.stripPrefix) {
        this.outboundPaths.set(request, outboundPath(request.url, match.stripPrefix));
      }
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
    const match = this.match(url.pathname, requestUser);
    if (!match) return false;
    if (match.stripPrefix) {
      this.outboundPaths.set(request, outboundPath(request.url, match.stripPrefix));
    }
    proxyWebSocket(request, socket, head, match.entry, this.proxy);
    return true;
  }

  /** Returns whether an upgrade path belongs to a registered route or browser relay. */
  canHandleUpgrade(path: string): boolean {
    return Boolean(this.directRoute(path));
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
      if (
        (input.redirectToSlash ?? false) !== previous.redirectToSlash ||
        input.htmlHead !== previous.htmlHead ||
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

  private match(path: string, requestUser: string | undefined): RouteMatch | undefined {
    const direct = this.directRoute(path);
    if (direct && requestUser === direct.ownerId) {
      return {
        entry: direct,
        ...(direct.route.stripPrefix ? { stripPrefix: direct.route.path } : {}),
      };
    }
    return undefined;
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

function pathMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function routeRedirectUrl(url: string, routePath: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.pathname = `${routePath}/`;
  return `${parsed.pathname}${parsed.search}`;
}

function optionalHtmlHead(htmlHead: string | undefined): { htmlHead?: string } {
  return htmlHead ? { htmlHead } : {};
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Keep the AppKit request URL on the inbound IncomingMessage so AppKit's
 * `/metrics` log/trace exclusions still match `/sandbox/metrics/...`. Prefix
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
  proxy: { ws: (request: IncomingMessage, socket: Socket, head: Buffer, options?: object) => void },
): void {
  if (!entry.target) {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  entry.sockets.add(socket);
  socket.once("close", () => entry.sockets.delete(socket));
  stripWebsocketIdentityHeaders(request);
  request.headers.origin = `http://${entry.route.remoteHost}:${entry.route.remotePort}`;
  const upgradeSocket = socket as UpgradeSocket;
  upgradeSocket.destroySoon ??= () => upgradeSocket.end();
  proxy.ws(request, upgradeSocket, head, {
    target: entry.target,
    changeOrigin: true,
  });
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
