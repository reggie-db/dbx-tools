import { createHash } from "node:crypto";
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
}

interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

type RouteExecutor = (request: { method: string; url: string }) => Promise<RouteResponse>;

interface RouteTarget {
  route: SshRoute;
  ownerId: string;
  target?: { host: string; port: number; protocol: string; socketPath?: string };
  wsTarget?: { host: string; port: number; protocol: string; socketPath?: string };
  server?: Server;
  wsServer?: Server;
  sockets: Set<Socket>;
  executor?: RouteExecutor;
  browserPaths: string[];
}

interface RouteMatch {
  entry: RouteTarget;
  stripPrefix: boolean;
}

/** Owns user-scoped AppKit paths that proxy to HTTP ports over SSH forwarding. */
export class SshRouteRegistry {
  private readonly routes = new Map<string, RouteTarget>();
  private readonly proxy = ProxyModule.createProxyServer({ ws: true, xfwd: true });

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
    const wsBridge = target.socketPath ? createBridge(session, input, sockets) : undefined;
    let wsTarget = target;
    try {
      if (wsBridge) wsTarget = await listenTarget(wsBridge, `${prepared.route.id}-ws`, true);
    } catch (error) {
      sockets.forEach((socket) => socket.destroy());
      await closeServer(bridge);
      if (target.socketPath) await rm(target.socketPath, { force: true });
      throw error;
    }
    this.routes.set(prepared.route.id, {
      route: prepared.route,
      ownerId: input.ownerId,
      target,
      wsTarget,
      server: bridge,
      ...(wsBridge ? { wsServer: wsBridge } : {}),
      sockets,
      browserPaths: normalizeBrowserPaths(input.browserPaths),
    });
    return prepared.route;
  }

  async addExecutor(input: RouteInput, executor: RouteExecutor): Promise<SshRoute> {
    const prepared = this.prepare(input);
    if (prepared.previous) return prepared.previous.route;
    this.routes.set(prepared.route.id, {
      route: prepared.route,
      ownerId: input.ownerId,
      executor,
      browserPaths: normalizeBrowserPaths(input.browserPaths),
      sockets: new Set(),
    });
    return prepared.route;
  }

  async remove(routeId: string, ownerId?: string): Promise<boolean> {
    const entry = this.routes.get(routeId);
    if (!entry || (ownerId && entry.ownerId !== ownerId)) return false;
    this.routes.delete(routeId);
    entry.sockets.forEach((socket) => socket.destroy());
    if (entry.server) await closeServer(entry.server);
    if (entry.wsServer) await closeServer(entry.wsServer);
    if (entry.target?.socketPath) await rm(entry.target.socketPath, { force: true });
    if (entry.wsTarget?.socketPath) await rm(entry.wsTarget.socketPath, { force: true });
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
      if (match.entry.browserPaths.length > 0 && request.path === match.entry.route.path) {
        response.appendHeader("set-cookie", routeCookie(match.entry.route.id));
      }
      if (match.stripPrefix) rewriteRequestUrl(request, match.entry.route.path);
      if (match.entry.executor) {
        void match.entry
          .executor({ method: request.method, url: request.url })
          .then((result) => {
            response.statusCode = result.status;
            for (const [name, value] of Object.entries(result.headers)) {
              if (!isHopByHopHeader(name)) response.setHeader(name, value);
            }
            response.setHeader("content-length", result.body.byteLength);
            response.end(Buffer.from(result.body));
          })
          .catch(next);
        return;
      }
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
    if (!match || !match.entry.wsTarget) return false;
    if (match.stripPrefix) rewriteIncomingUrl(request, match.entry.route.path, url.pathname);
    this.proxy.ws(request, socket, head, { target: match.entry.wsTarget, changeOrigin: true });
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
      return { route: previous.route, previous };
    }
    const id = createHash("sha256")
      .update(
        `${input.machineId}\0${input.remoteHost}\0${input.remotePort}\0${path}\0${stripPrefix}`,
      )
      .digest("hex")
      .slice(0, 24);
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
    if (direct && (!requestUser || requestUser === direct.ownerId)) {
      return { entry: direct, stripPrefix: direct.route.stripPrefix };
    }

    const cookieRouteId = cookieValue(headers.cookie, ROUTE_COOKIE);
    const referer = headerValue(headers.referer);
    return [...this.routes.values()]
      .filter((entry) => !requestUser || requestUser === entry.ownerId)
      .filter((entry) => entry.browserPaths.some((alias) => pathMatches(path, alias)))
      .filter(
        (entry) =>
          cookieRouteId === entry.route.id ||
          Boolean(referer && pathMatches(refererPath(referer) ?? "", entry.route.path)),
      )
      .map((entry) => ({ entry, stripPrefix: false }))[0];
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
  forceTcp = false,
): Promise<{ host: string; port: number; protocol: string; socketPath?: string }> {
  if (process.platform !== "win32" && !forceTcp) {
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

function isHopByHopHeader(name: string): boolean {
  return /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade)$/i.test(
    name,
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
      pending.pipe(channel).pipe(socket);
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
