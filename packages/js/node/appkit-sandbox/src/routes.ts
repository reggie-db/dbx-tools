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
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const logger = log.logger("appkit-sandbox:routes");

type UpgradeSocket = Socket & { destroySoon?: () => void };

interface RouteInput {
  id?: string;
  ownerId?: string;
  ownerIds?: readonly string[];
  machineId: string;
  remoteHost: string;
  remotePort: number;
  path?: string;
  stripPrefix?: boolean;
  redirectToSlash?: boolean;
  htmlHead?: string;
  internal?: boolean;
  authorizeOwner?: (ownerId: string) => Promise<boolean>;
  ownerExpirations?: Readonly<Record<string, number>>;
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
  ownerIds: Set<string>;
  session: SshSession;
  target?: { host: string; port: number; protocol: string };
  server?: Server;
  retiredServers: Set<Server>;
  sockets: Set<Socket>;
  retiredSockets: Set<Socket>;
  ownerSockets: Map<string, Set<Socket>>;
  ownerTimers: Map<string, ReturnType<typeof setTimeout>>;
  redirectToSlash: boolean;
  htmlHead?: string;
  internal: boolean;
  authorizeOwner?: (ownerId: string) => Promise<boolean>;
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
  private readonly retiredSessionSockets = new Map<SshSession, Set<Socket>>();
  private readonly sessionDrainWaiters = new Map<SshSession, Set<() => void>>();
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
      .filter((entry) => !ownerId || entry.ownerIds.has(ownerId))
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
    if (prepared.previous) {
      const previous = prepared.previous;
      if (previous.session !== session) {
        const sockets = new Set<Socket>();
        const bridge = createBridge(session, input, sockets);
        const target = await listenTarget(bridge);
        const previousServer = previous.server;
        const previousSession = previous.session;
        for (const socket of previous.sockets) {
          previous.retiredSockets.add(socket);
          socket.once("close", () => previous.retiredSockets.delete(socket));
        }
        this.trackRetiredSession(previousSession, previous.sockets);
        previous.session = session;
        previous.target = target;
        previous.server = bridge;
        previous.sockets = sockets;
        this.notifySessionDrained(previousSession);
        if (previousServer) {
          previous.retiredServers.add(previousServer);
          previousServer.close(() => previous.retiredServers.delete(previousServer));
        }
      }
      this.updateOwners(previous, input);
      return previous.route;
    }
    const sockets = new Set<Socket>();
    const bridge = createBridge(session, input, sockets);
    const target = await listenTarget(bridge);
    this.routes.set(prepared.route.id, {
      route: prepared.route,
      ownerIds: routeOwners(input),
      session,
      target,
      server: bridge,
      retiredServers: new Set(),
      sockets,
      retiredSockets: new Set(),
      ownerSockets: new Map(),
      ownerTimers: new Map(),
      redirectToSlash: input.redirectToSlash ?? false,
      ...optionalHtmlHead(input.htmlHead),
      internal: input.internal ?? false,
      ...(input.authorizeOwner ? { authorizeOwner: input.authorizeOwner } : {}),
    });
    this.updateOwners(this.routes.get(prepared.route.id)!, input);
    return prepared.route;
  }

  /** Removes an owned route, closes active sockets, and deletes its local bridge. */
  async remove(routeId: string, ownerId?: string): Promise<boolean> {
    const entry = this.routes.get(routeId);
    if (!entry || (ownerId && !entry.ownerIds.has(ownerId))) return false;
    this.routes.delete(routeId);
    entry.ownerTimers.forEach((timer) => clearTimeout(timer));
    entry.ownerTimers.clear();
    entry.ownerSockets.forEach((sockets) => sockets.forEach((socket) => socket.destroy()));
    entry.ownerSockets.clear();
    entry.sockets.forEach((socket) => socket.destroy());
    entry.retiredSockets.forEach((socket) => socket.destroy());
    entry.retiredSockets.clear();
    await Promise.all([
      ...(entry.server ? [closeServer(entry.server)] : []),
      ...[...entry.retiredServers].map(closeServer),
    ]);
    entry.retiredServers.clear();
    this.notifySessionDrained(entry.session);
    return true;
  }

  /** Removes every matching route for one machine and optional owner. */
  async removeMachine(machineId: string, ownerId?: string): Promise<void> {
    const entries = [...this.routes.values()].filter(
      (entry) => entry.route.machineId === machineId,
    );
    if (ownerId) {
      entries
        .filter((entry) => entry.internal)
        .forEach((entry) => this.revokeRouteOwner(entry, ownerId));
    }
    const routeIds = entries
      .filter((entry) => !ownerId || (!entry.internal && entry.ownerIds.has(ownerId)))
      .map((entry) => entry.route.id);
    await Promise.all(routeIds.map((routeId) => this.remove(routeId, ownerId)));
  }

  /** Revokes one owner's active and future access to machine-owned service routes. */
  revokeOwner(machineId: string, ownerId: string): void {
    for (const entry of this.routes.values()) {
      if (entry.route.machineId !== machineId || !entry.internal) continue;
      this.revokeRouteOwner(entry, ownerId);
    }
  }

  /** Resolves after a replaced SSH session no longer backs routes or forwarded sockets. */
  whenSessionDrained(session: SshSession): Promise<void> {
    if (!this.sessionInUse(session)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.sessionDrainWaiters.get(session) ?? new Set<() => void>();
      waiters.add(resolve);
      this.sessionDrainWaiters.set(session, waiters);
    });
  }

  /**
   * Returns Express middleware that authorizes, rewrites, and proxies matching
   * HTTP requests. Unmatched requests continue to the next AppKit handler.
   */
  middleware() {
    return async (request: Request, response: Response, next: NextFunction) => {
      const requestUser = request.header(USER_ID_HEADER) ?? request.header(USER_EMAIL_HEADER);
      const direct = this.directRoute(request.path);
      if (direct && !(await ownerIsAuthorized(direct, requestUser))) {
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
  async handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestUser =
      headerValue(request.headers[USER_ID_HEADER]) ??
      headerValue(request.headers[USER_EMAIL_HEADER]);
    const match = this.match(url.pathname, requestUser);
    if (!match) return false;
    if (!(await ownerIsAuthorized(match.entry, requestUser))) return false;
    if (match.stripPrefix) {
      this.outboundPaths.set(request, outboundPath(request.url, match.stripPrefix));
    }
    proxyWebSocket(request, socket, head, match.entry, requestUser!, this.proxy);
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

  private updateOwners(entry: RouteTarget, input: RouteInput): void {
    const owners = routeOwners(input);
    [...entry.ownerIds]
      .filter((ownerId) => !owners.has(ownerId))
      .forEach((ownerId) => this.revokeRouteOwner(entry, ownerId));
    entry.ownerIds = owners;
    entry.authorizeOwner = input.authorizeOwner;
    entry.ownerTimers.forEach((timer) => clearTimeout(timer));
    entry.ownerTimers.clear();
    for (const ownerId of owners) {
      const expiresAt = input.ownerExpirations?.[ownerId];
      if (expiresAt === undefined) continue;
      const delay = expiresAt - Date.now();
      if (delay <= 0) {
        this.revokeRouteOwner(entry, ownerId);
        continue;
      }
      this.scheduleOwnerExpiration(entry, ownerId, expiresAt);
    }
  }

  private revokeRouteOwner(entry: RouteTarget, ownerId: string): void {
    entry.ownerIds.delete(ownerId);
    const timer = entry.ownerTimers.get(ownerId);
    if (timer) clearTimeout(timer);
    entry.ownerTimers.delete(ownerId);
    entry.ownerSockets.get(ownerId)?.forEach((socket) => socket.destroy());
    entry.ownerSockets.delete(ownerId);
    if (entry.ownerIds.size === 0) void this.remove(entry.route.id);
  }

  private scheduleOwnerExpiration(entry: RouteTarget, ownerId: string, expiresAt: number): void {
    const schedule = () => {
      if (!entry.ownerIds.has(ownerId)) return;
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        this.revokeRouteOwner(entry, ownerId);
        return;
      }
      const timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
      timer.unref?.();
      entry.ownerTimers.set(ownerId, timer);
    };
    schedule();
  }

  private trackRetiredSession(session: SshSession, sockets: ReadonlySet<Socket>): void {
    if (sockets.size === 0) {
      this.notifySessionDrained(session);
      return;
    }
    const tracked = this.retiredSessionSockets.get(session) ?? new Set<Socket>();
    this.retiredSessionSockets.set(session, tracked);
    for (const socket of sockets) {
      tracked.add(socket);
      socket.once("close", () => {
        tracked.delete(socket);
        if (tracked.size === 0) {
          this.retiredSessionSockets.delete(session);
          this.notifySessionDrained(session);
        }
      });
    }
  }

  private sessionInUse(session: SshSession): boolean {
    return (
      [...this.routes.values()].some((entry) => entry.session === session) ||
      (this.retiredSessionSockets.get(session)?.size ?? 0) > 0
    );
  }

  private notifySessionDrained(session: SshSession): void {
    if (this.sessionInUse(session)) return;
    this.sessionDrainWaiters.get(session)?.forEach((resolve) => resolve());
    this.sessionDrainWaiters.delete(session);
  }

  private prepare(input: RouteInput): { route: SshForwardedRoute; previous?: RouteTarget } {
    const path = input.internal
      ? normalizeRoutePath(requiredInternalPath(input.path))
      : this.userRoutePath(input);
    const stripPrefix = input.stripPrefix ?? path !== "/";
    const previous = [...this.routes.values()].find((entry) => entry.route.path === path);
    if (previous) {
      const owners = routeOwners(input);
      if (!previous.internal && !sameOwners(previous.ownerIds, owners)) {
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
    if (!input.ownerId) throw new Error("User SSH routes require one owner");
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
    if (direct && requestUser && direct.ownerIds.has(requestUser)) {
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

async function ownerIsAuthorized(
  entry: RouteTarget,
  ownerId: string | undefined,
): Promise<boolean> {
  return Boolean(
    ownerId &&
    entry.ownerIds.has(ownerId) &&
    (!entry.authorizeOwner || (await entry.authorizeOwner(ownerId))),
  );
}

function routeOwners(input: RouteInput): Set<string> {
  const owners = new Set(input.ownerIds ?? []);
  if (input.ownerId) owners.add(input.ownerId);
  if (owners.size === 0) throw new Error("SSH routes require at least one owner");
  return owners;
}

function sameOwners(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((owner) => right.has(owner));
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
  ownerId: string,
  proxy: { ws: (request: IncomingMessage, socket: Socket, head: Buffer, options?: object) => void },
): void {
  if (!entry.target) {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const ownerSockets = entry.ownerSockets.get(ownerId) ?? new Set<Socket>();
  ownerSockets.add(socket);
  entry.ownerSockets.set(ownerId, ownerSockets);
  socket.once("close", () => {
    ownerSockets.delete(socket);
    if (ownerSockets.size === 0) entry.ownerSockets.delete(ownerId);
  });
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
