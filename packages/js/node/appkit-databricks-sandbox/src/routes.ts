import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { USER_EMAIL_HEADER, USER_ID_HEADER } from "@dbx-tools/appkit";
import { log } from "@dbx-tools/shared-core";
import type { SshRoute } from "@dbx-tools/shared-databricks-sandbox";
import type { NextFunction, Request, Response } from "express";
import ProxyModule from "http-proxy-3";
import type { ClientChannel } from "ssh2";
import WebSocket, { WebSocketServer } from "ws";
import type { SshSession } from "./session.ts";

const MAX_PENDING_BYTES = 1024 * 1024;
const logger = log.logger("appkit-databricks-sandbox:routes");

interface RouteInput {
  ownerId: string;
  machineId: string;
  remoteHost: string;
  remotePort: number;
  path?: string;
  stripPrefix?: boolean;
  browserPaths?: string[];
  browserRelay?: boolean;
  redirectToSlash?: boolean;
}

interface RouteTarget {
  route: SshRoute;
  ownerId: string;
  session: SshSession;
  target?: { host: string; port: number; protocol: string; socketPath?: string };
  server?: Server;
  sockets: Set<Socket>;
  browserPaths: string[];
  browserRelayPath?: string;
  redirectToSlash: boolean;
}

interface RouteMatch {
  entry: RouteTarget;
  stripPrefix?: string;
}

/** Owns user-scoped AppKit paths that proxy to HTTP ports over SSH forwarding. */
export class SshRouteRegistry {
  private readonly routes = new Map<string, RouteTarget>();
  private readonly activeBrowserRoutes = new Map<string, string>();
  private readonly proxy = ProxyModule.createProxyServer({ ws: true, xfwd: true });
  private readonly websocketServer = new WebSocketServer({ noServer: true });

  constructor(private readonly prefix: string) {
    this.proxy.on("error", (error, request, response) => {
      logger.warn("SSH route proxy failed", {
        method: request.method,
        path: request.url,
        errorName: error.name,
        errorMessage: error.message,
      });
      if ("writeHead" in response && !response.headersSent) response.writeHead(502);
      if ("end" in response) response.end("SSH route unavailable");
    });
  }

  list(machineId?: string, ownerId?: string): SshRoute[] {
    return [...this.routes.values()]
      .filter((entry) => !ownerId || entry.ownerId === ownerId)
      .map((entry) => entry.route)
      .filter((route) => !machineId || route.machineId === machineId);
  }

  async add(session: SshSession, input: RouteInput): Promise<SshRoute> {
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
    });
    return prepared.route;
  }

  async remove(routeId: string, ownerId?: string): Promise<boolean> {
    const entry = this.routes.get(routeId);
    if (!entry || (ownerId && entry.ownerId !== ownerId)) return false;
    this.routes.delete(routeId);
    if (this.activeBrowserRoutes.get(entry.ownerId) === routeId) {
      this.activeBrowserRoutes.delete(entry.ownerId);
    }
    entry.sockets.forEach((socket) => socket.destroy());
    if (entry.server) await closeServer(entry.server);
    if (entry.target?.socketPath) await rm(entry.target.socketPath, { force: true });
    return true;
  }

  async removeMachine(machineId: string, ownerId: string): Promise<void> {
    const routeIds = [...this.routes.values()]
      .filter((entry) => entry.ownerId === ownerId && entry.route.machineId === machineId)
      .map((entry) => entry.route.id);
    await Promise.all(routeIds.map((routeId) => this.remove(routeId, ownerId)));
  }

  middleware() {
    return (request: Request, response: Response, next: NextFunction) => {
      const match = this.match(
        request.path,
        request.headers,
        request.header(USER_ID_HEADER) ?? request.header(USER_EMAIL_HEADER),
      );
      if (!match) return next();
      if (request.path === match.entry.route.path && match.entry.browserRelayPath) {
        this.activeBrowserRoutes.set(match.entry.ownerId, match.entry.route.id);
        response.setHeader("set-cookie", routeCookie(match.entry.route.id));
        sendBrowserRelayBootstrap(response, match.entry.route.path, match.entry.route.id);
        return;
      }
      if (request.path === match.entry.route.path && match.entry.redirectToSlash) {
        response.statusCode = 308;
        response.setHeader("location", routeRedirectUrl(request.url, match.entry.route.path));
        response.end();
        return;
      }
      if (match.stripPrefix) rewriteRequestUrl(request, match.stripPrefix);
      this.proxy.web(request, response, { target: match.entry.target!, changeOrigin: true });
    };
  }

  /** Proxies matching HTTP upgrade requests, including WebSocket routes. */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestUser =
      headerValue(request.headers[USER_ID_HEADER]) ??
      headerValue(request.headers[USER_EMAIL_HEADER]);
    const match = this.match(url.pathname, request.headers, requestUser);
    if (!match) return false;
    if (match.stripPrefix) rewriteIncomingUrl(request, match.stripPrefix, url.pathname);
    proxyWebSocket(request, socket, head, match.entry, this.websocketServer);
    return true;
  }

  async close(): Promise<void> {
    await Promise.all([...this.routes.keys()].map((routeId) => this.remove(routeId)));
    this.proxy.close();
  }

  private prepare(input: RouteInput): { route: SshRoute; previous?: RouteTarget } {
    const requestedPath = normalizeRoutePath(
      input.path ?? `${this.prefix}/${slug(input.machineId)}-${input.remotePort}`,
    );
    const path =
      requestedPath === this.prefix || requestedPath.startsWith(`${this.prefix}/`)
        ? requestedPath
        : normalizeRoutePath(`${this.prefix}/${requestedPath}`);
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
        (input.redirectToSlash ?? false) !== previous.redirectToSlash
      ) {
        throw new Error(`SSH route path ${path} already has different browser behavior`);
      }
      return { route: previous.route, previous };
    }
    const id = randomBytes(16).toString("hex");
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

  private match(
    path: string,
    headers: IncomingMessage["headers"],
    requestUser: string | undefined,
  ): RouteMatch | undefined {
    const direct = [...this.routes.values()]
      .filter((entry) => path === entry.route.path || path.startsWith(`${entry.route.path}/`))
      .sort((left, right) => right.route.path.length - left.route.path.length)[0];
    if (direct && requestUser === direct.ownerId) {
      return {
        entry: direct,
        ...(direct.route.stripPrefix ? { stripPrefix: direct.route.path } : {}),
      };
    }

    const cookieRouteId = cookieValue(headers.cookie, ROUTE_COOKIE);
    const referer = headerValue(headers.referer);
    const activeRouteId = requestUser ? this.activeBrowserRoutes.get(requestUser) : undefined;
    const browserRelay = [...this.routes.values()].find(
      (entry) =>
        entry.browserRelayPath &&
        pathMatches(path, entry.browserRelayPath) &&
        (!requestUser || requestUser === entry.ownerId),
    );
    if (browserRelay) return { entry: browserRelay, stripPrefix: browserRelay.browserRelayPath };
    return [...this.routes.values()]
      .filter((entry) => !requestUser || requestUser === entry.ownerId)
      .filter((entry) => entry.browserPaths.some((alias) => pathMatches(path, alias)))
      .filter(
        (entry) =>
          cookieRouteId === entry.route.id ||
          activeRouteId === entry.route.id ||
          Boolean(referer && pathMatches(refererPath(referer) ?? "", entry.route.path)),
      )
      .map((entry) => ({ entry }))[0];
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
  return `${ROUTE_COOKIE}=${encodeURIComponent(routeId)}; Path=/; HttpOnly; SameSite=Lax`;
}

function routeRedirectUrl(url: string, routePath: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.pathname = `${routePath}/`;
  return `${parsed.pathname}${parsed.search}`;
}

function browserRelayPath(routeId: string): string {
  return `/__srv/${routeId}`;
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
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
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
          errorName: error.name,
          errorMessage: error.message,
        });
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
    })
    .catch((error: unknown) => {
      logger.warn("SSH route WebSocket forwarding failed", {
        path: request.url,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
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
    "connection",
    "host",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
    "upgrade",
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
