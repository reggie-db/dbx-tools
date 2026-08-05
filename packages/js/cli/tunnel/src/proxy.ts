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
import { http, json, log } from "@dbx-tools/shared-core";
import { authRequestSchema, authVerifySchema, SESSION_COOKIE_NAME } from "@dbx-tools/shared-email";
import { gate as gateModule, headers as headersModule, type AuthGateApi } from "@dbx-tools/tunnel";
import ProxyModule from "http-proxy-3";

const logger = log.logger("tunnel:proxy");

export interface ProxyOptions {
  /** The port this proxy listens on - the port portr and the platform route to. */
  publicPort: number;
  /** The private loopback port the wrapped app listens on. */
  appPort: number;
  /** The gate handlers. Omitted (an `--insecure` run) forwards everything. */
  gate?: AuthGateApi;
  /** Extra `x-` headers tunnel traffic may forward. */
  forwardHeaders?: readonly string[];
}

/** Read a request body as text; a transport error yields whatever arrived. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", () => resolve(body));
  });
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

function sessionCookieValue(request: IncomingMessage): string | undefined {
  return http.parseCookies(request.headers.cookie ?? null)[SESSION_COOKIE_NAME];
}

/**
 * Answer one of the four login routes, or return `false` when the request is not
 * one of them. Mirrors the plugin's route handlers: `request` always reports
 * success (anti-enumeration) and `verify` sets the session cookie on success.
 */
async function handleAuthRoute(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  gate: AuthGateApi,
): Promise<boolean> {
  const prefix = gateModule.AUTH_PREFIX;
  const ip = gateModule.clientIp(request);

  if (path === `${prefix}/status`) {
    sendJson(response, 200, await gate.status(sessionCookieValue(request)));
    return true;
  }
  if (path === `${prefix}/request` && request.method === "POST") {
    const parsed = authRequestSchema.safeParse(json.parseRecord(await readBody(request)));
    sendJson(
      response,
      200,
      parsed.success ? await gate.request(parsed.data.email, ip) : { ok: true },
    );
    return true;
  }
  if (path === `${prefix}/verify` && request.method === "POST") {
    const parsed = authVerifySchema.safeParse(json.parseRecord(await readBody(request)));
    if (!parsed.success) {
      sendJson(response, 200, { ok: false });
      return true;
    }
    const result = await gate.verify(parsed.data.email, parsed.data.code, ip);
    const cookie =
      result.ok && result.token
        ? gateModule.sessionSetCookie(result.token, gate.sessionTtlSeconds)
        : undefined;
    sendJson(
      response,
      200,
      { ok: result.ok, ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) },
      cookie,
    );
    return true;
  }
  if (path === `${prefix}/logout` && request.method === "POST") {
    sendJson(response, 200, { ok: true }, gateModule.LOGOUT_SET_COOKIE);
    return true;
  }
  return false;
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
export function startProxy(options: ProxyOptions): Promise<void> {
  const proxy = ProxyModule.createProxyServer({
    target: `http://127.0.0.1:${options.appPort}`,
    ws: true,
    xfwd: true,
  });
  const headerPolicy = headersModule.toHeaderPolicy(options.forwardHeaders);
  const gate = options.gate;

  const decide = (request: IncomingMessage): Promise<gateModule.GateAction> =>
    gate
      ? gateModule.gateRequest(request, {
          gate,
          publicDomain: (request.headers.host ?? "").split(":")[0] || "localhost",
          headerPolicy,
        })
      : Promise.resolve<gateModule.GateAction>("pass");

  const server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (gate && (await handleAuthRoute(request, response, path, gate))) return;
      if ((await decide(request)) === "deny") {
        sendJson(response, 401, gateModule.UNAUTHORIZED_BODY);
        return;
      }
      proxy.web(request, response);
    })().catch((error: unknown) => {
      logger.error("proxy request failed", { error });
      if (!response.headersSent) sendJson(response, 502, { error: "bad gateway" });
      else response.end();
    });
  });

  // A websocket upgrade cannot be answered with a 401 body, so a denied one is
  // destroyed - the client sees the handshake fail, which is what a browser's
  // WebSocket error handler expects.
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void decide(request)
      .then((action) => {
        if (action === "deny") socket.destroy();
        else proxy.ws(request, socket, head);
      })
      .catch(() => socket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(options.publicPort, "0.0.0.0", () => {
      logger.info("proxy listening", { publicPort: options.publicPort, appPort: options.appPort });
      resolve();
    });
  });
}
