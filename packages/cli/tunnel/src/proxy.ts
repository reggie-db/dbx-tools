/**
 * The tunnel gate reverse-proxy.
 *
 * Binds the PUBLIC port (the container's `DATABRICKS_APP_PORT`) and forwards to
 * the real app on a private loopback port. It is the single front door for both
 * traffic paths into the container:
 *
 *   - **portr client** (same container, connects over LOOPBACK) - the public
 *     tunnel. This is what the gate protects.
 *   - **Databricks control plane / front door** (reaches the `0.0.0.0` port from
 *     a NON-loopback container-network address) - passed through UNGATED, per the
 *     rule "if it's not from the portr client, let it in".
 *
 * The distinguisher is the connection's source address: a loopback
 * `req.socket.remoteAddress` is the portr client; anything else is the platform.
 *
 * For portr traffic the gate is a standard SPA gate: static assets + the login
 * flow (`/api/email/auth/*`, answered IN-PROCESS by this proxy via the
 * {@link AuthGateApi}) are open so the browser can load the client and render the
 * `<AuthGate>`; every other `/api/*` needs a valid session cookie or gets 401.
 * WebSocket upgrades are gated the same way and forwarded with `http-proxy-3`.
 *
 * @module
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { http, json, log } from "@dbx-tools/shared-core";
import { authRequestSchema, authVerifySchema, SESSION_COOKIE_NAME } from "@dbx-tools/shared-email";
import ProxyModule from "http-proxy-3";
import type { AuthGateApi } from "./plugin.ts";

const logger = log.logger("tunnel:proxy");

/** Route prefix the login flow lives under (open, answered in-process). */
const AUTH_PREFIX = "/api/email/auth";

/** True when a socket address is loopback (the portr client, same container). */
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  // Normalize IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and bare IPv6 loopback.
  const a = addr.replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a.startsWith("127.") || a === "::1" || a === "localhost";
}

/** Read the whole request body as text (small JSON payloads only). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(data));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, setCookie?: string): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (setCookie) headers["set-cookie"] = setCookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** Options for {@link startProxy}. */
export interface ProxyOptions {
  /** Public port to listen on (the container's DATABRICKS_APP_PORT). */
  publicPort: number;
  /** Private port the real app listens on (loopback). */
  appPort: number;
  /**
   * The in-process gate API, or `undefined` to run OPEN (insecure mode): every
   * request - including portr traffic - is forwarded ungated. Used when the
   * operator passed `--insecure` / `TUNNEL_INSECURE=true`.
   */
  gate?: AuthGateApi;
}

/** Start the gate proxy. Resolves once it is listening. */
export function startProxy({ publicPort, appPort, gate }: ProxyOptions): Promise<void> {
  const proxy = ProxyModule.createProxyServer({
    target: { host: "127.0.0.1", port: appPort },
    ws: true,
    xfwd: true,
  });
  proxy.on("error", (err: Error, _req: unknown, res: unknown) => {
    logger.warn("upstream proxy error", { error: err.message });
    const r = res as ServerResponse | undefined;
    if (r && "writeHead" in r && !r.headersSent) {
      sendJson(r, 502, { error: "upstream unavailable" });
    }
  });

  /** The session cookie for a verified email, as a Set-Cookie string. */
  const sessionCookie = (token: string, maxAgeSeconds: number): string =>
    [
      `${SESSION_COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
      process.env.NODE_ENV === "production" ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ");

  /** Client IP for rate-limiting: the portr-forwarded XFF, else the socket. */
  const clientIp = (req: IncomingMessage): string => {
    const fwd = req.headers["x-forwarded-for"];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
    return (first ?? req.socket.remoteAddress ?? "unknown").trim();
  };

  /**
   * Remove the gate's session cookie from the `Cookie` header before forwarding,
   * so the app never sees `dbx_auth` (it is the proxy's concern, not the app's).
   * Preserves any other cookies. Removes the header entirely when it becomes empty.
   */
  const stripSessionCookie = (req: IncomingMessage): void => {
    const raw = req.headers.cookie;
    if (!raw) return;
    const kept = raw
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${SESSION_COOKIE_NAME}=`));
    if (kept.length) req.headers.cookie = kept.join("; ");
    else delete req.headers.cookie;
  };

  /**
   * Present an OTP-authenticated caller to the app the SAME way the Databricks
   * front door does: set `x-forwarded-user` / `x-forwarded-email` to the verified
   * address (AppKit reads `x-forwarded-user` for the OBO user id). Any inbound
   * copies are overwritten so a client can't spoof identity through the gate.
   */
  const injectIdentity = (req: IncomingMessage, email: string): void => {
    req.headers["x-forwarded-user"] = email;
    req.headers["x-forwarded-email"] = email;
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;

    // Insecure/open mode (no gate) OR non-loopback traffic (the Databricks front
    // door / control plane): forward ungated.
    if (!gate || !isLoopback(req.socket.remoteAddress)) {
      proxy.web(req, res);
      return;
    }

    // --- portr traffic: the gate applies ---

    // The login flow is answered IN-PROCESS (the app has no server to forward to).
    if (path === `${AUTH_PREFIX}/status`) {
      const token = http.parseCookies(req.headers.cookie ?? null)[SESSION_COOKIE_NAME];
      sendJson(res, 200, await gate.status(token));
      return;
    }
    if (path === `${AUTH_PREFIX}/request` && req.method === "POST") {
      const parsed = authRequestSchema.safeParse(json.parseRecord(await readBody(req)));
      if (!parsed.success) return sendJson(res, 200, { ok: true }); // anti-enumeration
      return sendJson(res, 200, await gate.request(parsed.data.email, clientIp(req)));
    }
    if (path === `${AUTH_PREFIX}/verify` && req.method === "POST") {
      const parsed = authVerifySchema.safeParse(json.parseRecord(await readBody(req)));
      if (!parsed.success) return sendJson(res, 200, { ok: false });
      const result = await gate.verify(parsed.data.email, parsed.data.code, clientIp(req));
      const cookie =
        result.ok && result.token ? sessionCookie(result.token, gate.sessionTtlSeconds) : undefined;
      return sendJson(
        res,
        200,
        { ok: result.ok, ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) },
        cookie,
      );
    }
    if (path === `${AUTH_PREFIX}/logout` && req.method === "POST") {
      return sendJson(
        res,
        200,
        { ok: true },
        `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
      );
    }

    // Anti-spoof: strip any inbound identity headers on portr traffic - only the
    // gate may set them, below, for a verified session.
    delete req.headers["x-forwarded-user"];
    delete req.headers["x-forwarded-email"];

    // Static (non-API) loads freely so the SPA + <AuthGate> can render. Strip the
    // session cookie so it never leaks to the static handler.
    if (!path.startsWith("/api/")) {
      stripSessionCookie(req);
      proxy.web(req, res);
      return;
    }

    // Every other /api/* requires a valid session.
    const token = http.parseCookies(req.headers.cookie ?? null)[SESSION_COOKIE_NAME];
    const email = await gate.session(token);
    if (email) {
      // Present the OTP user like the Databricks front door, and drop the gate
      // cookie so the app sees a clean, front-door-shaped request.
      injectIdentity(req, email);
      stripSessionCookie(req);
      proxy.web(req, res);
    } else {
      sendJson(res, 401, { error: "authentication required", loginPath: AUTH_PREFIX });
    }
  });

  // WebSocket upgrades: forward front-door traffic untouched; gate loopback
  // (portr) API upgrades the same way as HTTP (strip cookie + inject identity).
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!gate || !isLoopback(req.socket.remoteAddress)) {
      proxy.ws(req, socket, head);
      return;
    }
    delete req.headers["x-forwarded-user"];
    delete req.headers["x-forwarded-email"];
    if (!(req.url ?? "").startsWith("/api/")) {
      stripSessionCookie(req);
      proxy.ws(req, socket, head);
      return;
    }
    const token = http.parseCookies(req.headers.cookie ?? null)[SESSION_COOKIE_NAME];
    void gate.session(token).then((email) => {
      if (!email) {
        socket.destroy();
        return;
      }
      injectIdentity(req, email);
      stripSessionCookie(req);
      proxy.ws(req, socket, head);
    });
  });

  return new Promise((resolve) => {
    server.listen(publicPort, "0.0.0.0", () => {
      logger.info(`gate proxy on 0.0.0.0:${publicPort} -> app 127.0.0.1:${appPort}`);
      resolve();
    });
  });
}
