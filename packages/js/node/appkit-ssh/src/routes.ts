import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { USER_EMAIL_HEADER, USER_ID_HEADER } from "@dbx-tools/appkit";
import type { SshRoute } from "@dbx-tools/shared-ssh";
import type { NextFunction, Request, Response } from "express";
import ProxyModule from "http-proxy-3";
import type { ClientChannel } from "ssh2";
import type { SshSession } from "./session.ts";

const MAX_PENDING_BYTES = 1024 * 1024;

interface RouteInput {
  ownerId: string;
  machineId: string;
  remoteHost: string;
  remotePort: number;
  path?: string;
  stripPrefix?: boolean;
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
  server?: Server;
  executor?: RouteExecutor;
}

/** Owns user-scoped AppKit paths that proxy to HTTP ports over SSH forwarding. */
export class SshRouteRegistry {
  private readonly routes = new Map<string, RouteTarget>();
  private readonly proxy = ProxyModule.createProxyServer({ ws: true, xfwd: true });

  constructor(private readonly prefix: string) {
    this.proxy.on("error", (_error, _request, response) => {
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
    const bridge = createServer((socket) => {
      bridgeSocket(socket, session.forwardOut(input.remoteHost, input.remotePort));
    });
    const target = await listenTarget(bridge, prepared.route.id);
    this.routes.set(prepared.route.id, {
      route: prepared.route,
      ownerId: input.ownerId,
      target,
      server: bridge,
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
    });
    return prepared.route;
  }

  async remove(routeId: string, ownerId?: string): Promise<boolean> {
    const entry = this.routes.get(routeId);
    if (!entry || (ownerId && entry.ownerId !== ownerId)) return false;
    this.routes.delete(routeId);
    if (entry.server) await new Promise<void>((resolve) => entry.server?.close(() => resolve()));
    if (entry.target?.socketPath) await rm(entry.target.socketPath, { force: true });
    return true;
  }

  middleware() {
    return (request: Request, response: Response, next: NextFunction) => {
      const match = [...this.routes.values()]
        .filter(
          (entry) =>
            request.path === entry.route.path || request.path.startsWith(`${entry.route.path}/`),
        )
        .sort((left, right) => right.route.path.length - left.route.path.length)[0];
      if (!match) return next();
      const requestUser = request.header(USER_ID_HEADER) ?? request.header(USER_EMAIL_HEADER);
      if (requestUser && requestUser !== match.ownerId) return next();
      if (match.route.stripPrefix) {
        const queryIndex = request.url.indexOf("?");
        const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
        const path = request.path.slice(match.route.path.length) || "/";
        request.url = `${path}${query}`;
      }
      if (match.executor) {
        void match
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
      this.proxy.web(request, response, { target: match.target! });
    };
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
  const normalized = `/${path.split("/").filter(Boolean).join("/")}`;
  if (normalized === "/api" || normalized.startsWith("/api/")) {
    throw new Error("SSH routes cannot overlap AppKit API routes");
  }
  return normalized;
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
    () => {
      pending.destroy();
      socket.destroy();
    },
  );
}
