/**
 * Development-only proxy from the authenticated AppKit server to Bun's client
 * dev server, including its HMR WebSocket.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { AuthGateApi } from "@dbx-tools/tunnel";
import { gate } from "@dbx-tools/tunnel";
import type { Application, NextFunction, Request, Response } from "express";
import ProxyModule from "http-proxy-3";

const BUN_PATH_PREFIX = "/_bun/";
const BUN_HMR_PATH = "/_bun/hmr";

type UpgradeSocket = Socket & { destroySoon?: () => void };

/** Development client proxy mounted on the AppKit server. */
export interface ClientDevelopmentProxy {
  configure(application: Application): void;
  attach(server: HttpServer): void;
}

/** Create the HTTP and WebSocket bridge to one Bun client dev server. */
export function createClientDevelopmentProxy(
  target: string,
  authGate?: Pick<AuthGateApi, "isProtectedHost" | "session">,
): ClientDevelopmentProxy {
  const targetUrl = new URL(target);
  const proxy = ProxyModule.createProxyServer({
    target: targetUrl.origin,
    changeOrigin: true,
    ws: true,
  });

  const configure = (application: Application) => {
    application.use((request: Request, response: Response, next: NextFunction) => {
      if (!shouldProxyRequest(request)) {
        next();
        return;
      }
      void canProxy(request)
        .then((allowed) => {
          if (!allowed) next();
          else proxy.web(request, response, (error) => next(error));
        })
        .catch(next);
    });
  };

  const canProxy = async (request: IncomingMessage): Promise<boolean> => {
    if (!authGate) return true;
    const headers = gate.webHeaders(request);
    return !authGate.isProtectedHost(headers) || Boolean(await authGate.session(headers));
  };

  const attach = (server: HttpServer) => {
    const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const upgradeSocket = socket as UpgradeSocket;
      upgradeSocket.destroySoon ??= () => upgradeSocket.end();
      void (async () => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path !== BUN_HMR_PATH) return;

        if (!(await canProxy(request))) {
          upgradeSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          upgradeSocket.destroy();
          return;
        }

        proxy.ws(request, upgradeSocket, head);
      })();
    };
    server.on("upgrade", upgrade);
    server.once("close", () => server.off("upgrade", upgrade));
  };

  return { configure, attach };
}

function shouldProxyRequest(request: Request): boolean {
  if (request.path.startsWith(BUN_PATH_PREFIX)) return true;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return Boolean(request.accepts("html"));
}
