/**
 * Development-only proxy from the authenticated AppKit server to Bun's client
 * dev server, including its HMR WebSocket.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { AuthGateApi } from "@dbx-tools/tunnel";
import { webHeaders } from "@dbx-tools/tunnel";
import type { Application, NextFunction, Request, Response } from "express";
import ProxyModule from "http-proxy-3";

const BUN_PATH_PREFIX = "/_bun/";
const BUN_HMR_PATH = "/_bun/hmr";
export const CLIENT_DEVELOPMENT_CONFIG_PATH = "/__dbx_tools_appkit_client_config__";
const APPKIT_CONFIG_HEADER = "x-dbx-tools-appkit-client-config";

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
  let appkitOrigin: string | undefined;
  let configScripts: Promise<string> | undefined;
  const proxy = ProxyModule.createProxyServer({
    target: targetUrl.origin,
    changeOrigin: true,
    ws: true,
  });

  const configure = (application: Application) => {
    application.use((request: Request, response: Response, next: NextFunction) => {
      if (
        request.path === CLIENT_DEVELOPMENT_CONFIG_PATH &&
        request.header(APPKIT_CONFIG_HEADER) === "1"
      ) {
        next();
        return;
      }
      if (!shouldProxyRequest(request)) {
        next();
        return;
      }
      void canProxy(request)
        .then((allowed) => {
          if (!allowed) {
            next();
          } else if (request.path.startsWith(BUN_PATH_PREFIX)) {
            proxy.web(request, response, (error) => next(error));
          } else {
            void serveHtml(request, response).catch(next);
          }
        })
        .catch(next);
    });
  };

  const appkitConfigScripts = async (): Promise<string> => {
    if (!appkitOrigin) throw new Error("AppKit server is not attached");
    const response = await fetch(`${appkitOrigin}${CLIENT_DEVELOPMENT_CONFIG_PATH}`, {
      headers: {
        Accept: "text/html",
        [APPKIT_CONFIG_HEADER]: "1",
      },
    });
    if (!response.ok) throw new Error(`AppKit config HTML returned ${response.status}`);
    return extractAppKitConfigScripts(await response.text());
  };

  const serveHtml = async (request: Request, response: Response): Promise<void> => {
    const upstream = await fetch(new URL(request.originalUrl, targetUrl), {
      headers: { Accept: "text/html" },
    });
    const contentType = upstream.headers.get("content-type") ?? "";
    const html = await upstream.text();
    if (!contentType.includes("text/html")) {
      response.status(upstream.status);
      if (contentType) response.set("Content-Type", contentType);
      response.set("Cache-Control", "no-store");
      if (request.method === "HEAD") response.end();
      else response.send(html);
      return;
    }
    configScripts ??= appkitConfigScripts().catch((error) => {
      configScripts = undefined;
      throw error;
    });
    const body = injectAppKitConfig(html, await configScripts);
    response.status(upstream.status);
    response.set("Content-Type", contentType || "text/html; charset=utf-8");
    response.set("Cache-Control", "no-store");
    if (request.method === "HEAD") response.end();
    else response.send(body);
  };

  const canProxy = async (request: IncomingMessage): Promise<boolean> => {
    if (!authGate) return true;
    const headers = webHeaders(request);
    return !authGate.isProtectedHost(headers) || Boolean(await authGate.session(headers));
  };

  const attach = (server: HttpServer) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("AppKit server is not listening");
    appkitOrigin = `http://127.0.0.1:${address.port}`;
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

function extractAppKitConfigScripts(html: string): string {
  const firstStart = html.indexOf('<script id="__appkit__"');
  if (firstStart < 0) throw new Error("AppKit config script is missing");
  const firstEnd = html.indexOf("</script>", firstStart);
  const secondStart = html.indexOf("<script", firstEnd + 9);
  const secondEnd = html.indexOf("</script>", secondStart);
  if (firstEnd < 0 || secondStart < 0 || secondEnd < 0) {
    throw new Error("AppKit config bootstrap is incomplete");
  }
  return html.slice(firstStart, secondEnd + 9);
}

function injectAppKitConfig(html: string, scripts: string): string {
  if (!html.includes("<body>")) return html;
  return html.replace("<body>", `<body>${scripts}`);
}

function shouldProxyRequest(request: Request): boolean {
  if (request.path.startsWith(BUN_PATH_PREFIX)) return true;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.path.startsWith("/.well-known/") || request.path.endsWith(".json")) return false;
  return Boolean(request.accepts("html"));
}
