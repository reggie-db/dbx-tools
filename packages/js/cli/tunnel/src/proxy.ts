/**
 * The reverse proxy that makes the wrapper path possible.
 *
 * The wrapper claims the PUBLIC port and the wrapped app runs as a child process
 * on a private loopback port, so - unlike the in-process plugin - there is no
 * middleware chain to insert the gate into. This proxy is that insertion point: it
 * answers the login routes itself, applies the gate to everything else, and
 * forwards what survives to the child.
 *
 * The gating DECISION is not reimplemented here. `@dbx-tools/tunnel`'s
 * `gate.gateRequest` makes it - the same function the Express middleware calls -
 * and this module only differs in how the outcome is written: a proxied request
 * instead of `next()`, a `writeHead` instead of `res.json`. That is deliberate:
 * two independent implementations of "which requests are gated and which headers
 * are stripped" is the one way this package could become a security bug.
 *
 * @module
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { log } from "@dbx-tools/shared-core";
import {
  gate as tunnelGate,
  headers as tunnelHeaders,
  loginPage as tunnelLoginPage,
  type AuthGateApi,
} from "@dbx-tools/tunnel";
import ProxyModule from "http-proxy-3";

const logger = log.logger("tunnel:proxy");

type UpgradeSocket = Socket & { destroySoon?: () => void };

export interface ProxyOptions {
  /** The port this proxy listens on - the port portr and the platform route to. */
  publicPort: number;
  /** The private loopback port the wrapped app listens on. */
  appPort: number;
  /** The gate handlers. Omitted (an `--insecure` run) forwards everything. */
  gate?: AuthGateApi;
  /** Extra `x-` headers tunnel traffic may forward. */
  forwardHeaders?: readonly string[];
  /** Path prefixes to gate beyond `/api/` (e.g. `/ws` for a WebSocket app). */
  gatePaths?: readonly string[];
  /** Brand name for the hosted login page shown on a denied browser navigation. */
  brandName?: string;
  /**
   * Addresses to listen on. Defaults to a single `0.0.0.0` (every interface),
   * the portr/platform case. Pass specific interface IPs to expose the gate on
   * only those - e.g. an overlay/LAN address while loopback reaches the upstream
   * directly and ungated.
   */
  bindHosts?: readonly string[];
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  setCookie?: string,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...(setCookie ? { "set-cookie": setCookie } : {}),
  });
  response.end(JSON.stringify(body));
}

/**
 * Hand every Better Auth and compatibility route to the shared gate runtime.
 */
async function handleAuthRoute(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  gate: AuthGateApi,
): Promise<boolean> {
  const prefix = tunnelGate.AUTH_PREFIX;
  if (!path.startsWith(prefix)) return false;
  const result = await gate.handler(await tunnelGate.webRequest(request));
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of result.headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") headers[name] = value;
  }
  const cookies = result.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  response.writeHead(result.status, headers);
  response.end(Buffer.from(await result.arrayBuffer()));
  return true;
}

/**
 * Start the proxy and resolve once it is listening.
 *
 * `publicDomain` is intentionally NOT passed to `gateRequest`: on this path every
 * request arrived on the public port, so it IS tunnel traffic by construction -
 * whereas the in-process gate shares a port with the platform front door and has
 * to tell them apart by `Host`. Passing the request's own host keeps the shared
 * decision function's contract satisfied without weakening it.
 */
export async function startProxy(options: ProxyOptions): Promise<void> {
  const proxy = ProxyModule.createProxyServer({
    target: `http://127.0.0.1:${options.appPort}`,
    ws: true,
    xfwd: true,
  });
  const headerPolicy = tunnelHeaders.toHeaderPolicy(options.forwardHeaders);
  const gate = options.gate;

  const decide = (request: IncomingMessage): Promise<tunnelGate.GateAction> =>
    gate
      ? tunnelGate.gateRequest(request, {
          gate,
          publicDomain: (request.headers.host ?? "").split(":")[0] || "localhost",
          headerPolicy,
          gatePaths: options.gatePaths,
        })
      : Promise.resolve<tunnelGate.GateAction>("pass");

  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (gate && (await handleAuthRoute(request, response, path, gate))) return;
      if ((await decide(request)) === "deny") {
        // A denied browser navigation gets the hosted login page; anything else
        // (an XHR, a /ws upgrade probe, a non-HTML fetch) gets the 401 JSON.
        if (gate && tunnelGate.wantsLoginPage(request)) {
          const html = tunnelLoginPage.loginPageHtml({
            brandName: options.brandName ?? "this app",
          });
          response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
          response.end(html);
        } else {
          sendJson(response, 401, tunnelGate.UNAUTHORIZED_BODY);
        }
        return;
      }
      proxy.web(request, response);
    })().catch((error: unknown) => {
      logger.error("proxy request failed", { error });
      if (!response.headersSent) sendJson(response, 502, { error: "bad gateway" });
      else response.end();
    });
  };

  // A websocket upgrade cannot be answered with a 401 body, so a denied one is
  // destroyed - the client sees the handshake fail, which is what a browser's
  // WebSocket error handler expects.
  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const upgradeSocket = socket as UpgradeSocket;
    upgradeSocket.destroySoon ??= () => upgradeSocket.end();
    void decide(request)
      .then((action) => {
        if (action === "deny") upgradeSocket.destroy();
        else proxy.ws(request, upgradeSocket, head);
      })
      .catch(() => upgradeSocket.destroy());
  };

  // One net.Server binds one address, so listen each host on its own server that
  // shares the same handlers. Binding specific interface IPs (rather than the
  // default 0.0.0.0) is what lets the gate front an overlay/LAN address while
  // loopback reaches the upstream ungated.
  const hosts = options.bindHosts?.length ? options.bindHosts : ["0.0.0.0"];
  await Promise.all(
    hosts.map(
      (host) =>
        new Promise<void>((resolve) => {
          const server = createServer(onRequest);
          server.on("upgrade", onUpgrade);
          server.listen(options.publicPort, host, () => {
            logger.info("proxy listening", {
              host,
              publicPort: options.publicPort,
              appPort: options.appPort,
            });
            resolve();
          });
        }),
    ),
  );
}
