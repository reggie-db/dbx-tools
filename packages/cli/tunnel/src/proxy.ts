/**
 * The tunnel gate reverse-proxy.
 *
 * Binds the PUBLIC port (the container's `DATABRICKS_APP_PORT`) and forwards to
 * the real app on a private loopback port. It is the single front door for both
 * traffic paths into the container:
 *
 *   - **portr client** (same container, connects over LOOPBACK) - the public
 *     tunnel. This is what the gate protects.
 *   - **the hosting platform's front door** (Databricks Apps' control plane, or
 *     any other host reaching the `0.0.0.0` port from a NON-loopback
 *     container-network address) - passed through UNGATED, per the rule "if it's
 *     not from the portr client, let it in". The platform already authenticates
 *     that path; the gate exists for the tunnel, which nothing else protects.
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
import { http, json, log, token } from "@dbx-tools/shared-core";
import { authRequestSchema, authVerifySchema, SESSION_COOKIE_NAME } from "@dbx-tools/shared-email";
import ProxyModule from "http-proxy-3";
import { toHeaderPolicy, type HeaderPolicy } from "./headers.ts";
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
  /**
   * Extra `x-` request headers tunnel traffic may forward, as literals, globs, or
   * `/regex/`es - unioned with {@link DEFAULT_FORWARD_HEADERS}. Every other `x-`
   * header is stripped, and {@link PROTECTED_HEADERS} is stripped regardless. See
   * `./headers.ts` for why the policy is an allow-list.
   */
  forwardHeaders?: readonly string[];
}

/** Start the gate proxy. Resolves once it is listening. */
export function startProxy({
  publicPort,
  appPort,
  gate,
  forwardHeaders,
}: ProxyOptions): Promise<void> {
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

  // Compiled once: the inbound-header allow-list applied to every gated request.
  const headerPolicy = toHeaderPolicy(forwardHeaders);
  logger.debug("inbound header policy", { forward: headerPolicy.patterns });

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

  /**
   * Client IP for rate-limiting: the portr client's forwarded XFF, else the socket.
   *
   * Deliberately the RIGHTMOST `x-forwarded-for` entry, not the leftmost. The
   * list grows left-to-right as each hop appends, so the last entry is the one
   * the nearest trusted proxy (portr) wrote and every earlier entry is a value
   * the caller could have sent. Reading the leftmost lets a client vary one
   * header to get a fresh rate-limit bucket per request, which defeats both the
   * per-IP code-request and verify-attempt limiters. Called BEFORE
   * {@link HeaderPolicy.apply} strips the header, so the honest hop value is
   * still available here.
   */
  const clientIp = (req: IncomingMessage): string => {
    const forwarded = req.headers["x-forwarded-for"];
    const chain = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return chain.at(-1) ?? req.socket.remoteAddress ?? "unknown";
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
   * Present an OTP-authenticated caller to the app the SAME way a platform front
   * door does: set the front door's own identity headers to the verified address
   * (AppKit reads {@link token.USER_ID_HEADER} for the OBO user id), so the app
   * needs no gate-specific code path. The names come from
   * `@dbx-tools/shared-core`'s `token` module - the same constants AppKit-side
   * code reads them by - rather than being re-spelled here.
   *
   * What the gate CANNOT set is {@link token.ACCESS_TOKEN_HEADER}: an OTP session
   * proves an email address, not possession of a Databricks credential, and
   * there is no way to mint one for the caller. Its absence is exactly what
   * `@dbx-tools/appkit`'s `identity` `"auto"` mode detects, so a gated request
   * runs as the app's service principal instead of throwing.
   */
  const injectIdentity = (req: IncomingMessage, email: string): void => {
    req.headers[token.USER_ID_HEADER] = email;
    req.headers[token.USER_EMAIL_HEADER] = email;
  };

  /**
   * Apply the inbound-header policy to a tunnel request: every `x-` header the
   * allow-list does not name is deleted, and the platform identity/transport set
   * is deleted regardless. See `./headers.ts` for the reasoning; the
   * security-critical case is {@link token.ACCESS_TOKEN_HEADER}, which the gate
   * never sets but an app running `identity: "auto"` treats as proof the request
   * can do OBO.
   *
   * `xfwd: true` on the proxy re-adds `x-forwarded-for`/`-proto`/`-port`/`-host`
   * afterwards from the real socket, so the app still sees those - it just sees
   * the honest values rather than the caller's claim.
   */
  const applyHeaderPolicy = (req: IncomingMessage): void => {
    const removed = headerPolicy.apply(req.headers as Record<string, unknown>);
    if (removed.length) logger.debug("stripped inbound headers", { removed });
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;

    // Insecure/open mode (no gate) OR non-loopback traffic (the hosting
    // platform's front door / control plane): forward ungated.
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

    // Anti-spoof: apply the inbound-header allow-list to portr traffic - only the
    // gate may assert identity, and it does so below for a verified session.
    applyHeaderPolicy(req);

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
      // Present the OTP user like a platform front door, and drop the gate
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
    applyHeaderPolicy(req);
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
