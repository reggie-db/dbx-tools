/**
 * The tunnel's in-app AUTH GATE - Express middleware + login routes the
 * {@link AuthGatePlugin} registers on the app's OWN server via `this.context`.
 *
 * This replaces the old standalone reverse-proxy (`proxy.ts`): the app is now the
 * process, so there is nothing to forward to. Instead the gate is middleware that
 * either short-circuits (401, or answers the open login routes) or calls `next()`
 * to let the app's real handlers run. It is the "stands in for AppKit auth" path:
 * a portr caller proves an email via OTP, and on success the gate injects the
 * identity headers AppKit reads, so a gated request runs like a front-door one.
 *
 * WHICH TRAFFIC IS GATED - the `Host` header, not the socket. portr's client
 * forwards with Go's `httputil.NewSingleHostReverseProxy` and a `Director` that
 * PRESERVES the original `Host`, so tunnel requests arrive with
 * `Host: <subdomain>.<server>` (the public domain). A local process hitting the
 * app directly sends `Host: 127.0.0.1:<port>` / `localhost`. So ONLY requests whose
 * `Host` matches the configured public domain are gated; the platform front door
 * and any other local client pass through untouched. There is no portr-injected
 * identifying header and no TCP/source-IP signal to use instead (the client dials
 * the target over plain loopback).
 *
 * @module
 */

import { http, json, log, token } from "@dbx-tools/shared-core";
import type { Request, RequestHandler, Response } from "express";
import { authRequestSchema, authVerifySchema, SESSION_COOKIE_NAME } from "@dbx-tools/shared-email";
import { toHeaderPolicy } from "./headers.ts";
import type { AuthGateApi } from "./plugin.ts";

const logger = log.logger("tunnel:gate");

/** Route prefix the login flow lives under (open, answered in-process). */
export const AUTH_PREFIX = "/api/email/auth";

/** Options for {@link mountGate}. */
export interface GateOptions {
  /** The in-process gate API (session/request/verify/status). */
  gate: AuthGateApi;
  /**
   * The public `<subdomain>.<server>` that identifies portr traffic by `Host`.
   * When absent, no request is ever classified as tunnel traffic and the gate is
   * inert (everything passes through) - a tunnel with no public domain gates
   * nothing.
   */
  publicDomain?: string;
  /**
   * Extra `x-` request headers tunnel traffic may forward (unioned with the
   * built-in allow-list). Every other `x-` header is stripped from tunnel traffic.
   */
  forwardHeaders?: readonly string[];
}

/**
 * True when the request's `Host` is the tunnel's public domain - i.e. it came in
 * over portr. Case-insensitive; the optional `:port` is ignored. When no public
 * domain is configured, nothing is tunnel traffic.
 */
export function isTunnelHost(req: Request, publicDomain: string | undefined): boolean {
  if (!publicDomain) return false;
  const host = (req.headers.host ?? "").toLowerCase().split(":")[0];
  return host === publicDomain.toLowerCase().split(":")[0];
}

/** The session cookie for a verified email, as a Set-Cookie string. */
function sessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    // Real enforcement in production: the session cookie must be Secure so it is
    // never sent over plaintext. Local dev (http) omits it so the cookie works.
    process.env.NODE_ENV === "production" ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Client IP for rate-limiting: the RIGHTMOST `x-forwarded-for` entry (the value
 * the nearest trusted hop - portr - wrote), else the socket address. Reading the
 * rightmost, not the leftmost, stops a caller minting a fresh rate-limit bucket by
 * varying the header. Called before {@link stripHeaders}.
 */
function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chain.at(-1) ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Remove the gate's session cookie from the `Cookie` header before the app's
 * handlers run, so the app never sees `dbx_auth` (it is the gate's concern).
 * Preserves other cookies; deletes the header when it becomes empty.
 */
function stripSessionCookie(req: Request): void {
  const raw = req.headers.cookie;
  if (!raw) return;
  const kept = raw
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (kept.length) req.headers.cookie = kept.join("; ");
  else delete req.headers.cookie;
}

/**
 * Present an OTP-authenticated caller to the app the SAME way a platform front
 * door does: set the front-door identity headers to the verified address (AppKit
 * reads {@link token.USER_ID_HEADER} for the OBO user id), so the app needs no
 * gate-specific code path.
 *
 * What the gate CANNOT set is {@link token.ACCESS_TOKEN_HEADER}: an OTP session
 * proves an email, not possession of a Databricks credential. Its absence is what
 * `@dbx-tools/appkit`'s `identity: "auto"` detects, so a gated request runs as the
 * app service principal instead of throwing.
 */
function injectIdentity(req: Request, email: string): void {
  req.headers[token.USER_ID_HEADER] = email;
  req.headers[token.USER_EMAIL_HEADER] = email;
}

function sendJson(res: Response, status: number, body: unknown, setCookie?: string): void {
  if (setCookie) res.setHeader("set-cookie", setCookie);
  res.status(status).json(body);
}

/** Read the raw request body as text (AppKit parses JSON, but the gate routes
 * are mounted before that runs for tunnel traffic, so read defensively). */
function readBody(req: Request): Promise<string> {
  // AppKit's json body-parser may have already populated req.body; prefer it.
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  }
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(data));
  });
}

/**
 * Register the login routes and the gating middleware on the app's Express
 * instance. Called from {@link AuthGatePlugin} with the router AppKit hands
 * `injectRoutes`, plus `this.context.addMiddleware` for the global gate.
 *
 * `addRoute`/`addMiddleware` are used (via the passed callbacks) because the login
 * routes live at an ABSOLUTE path (`/api/email/auth/*`, the client's contract),
 * not under the plugin's `/api/authGate` base.
 */
export function mountGate(
  opts: GateOptions,
  addRoute: (method: "get" | "post", path: string, handler: RequestHandler) => void,
  addMiddleware: (path: string, handler: RequestHandler) => void,
): void {
  const { gate, publicDomain, forwardHeaders } = opts;
  const headerPolicy = toHeaderPolicy(forwardHeaders);
  logger.debug("gate mounted", { publicDomain, forward: headerPolicy.patterns });

  const applyHeaderPolicy = (req: Request): void => {
    const removed = headerPolicy.apply(req.headers as Record<string, unknown>);
    if (removed.length) logger.debug("stripped inbound headers", { removed });
  };

  // --- Login routes (open on tunnel traffic; answered in-process) ---

  const statusHandler = (async (req, res) => {
    const cookie = http.parseCookies(req.headers.cookie ?? null)[SESSION_COOKIE_NAME];
    sendJson(res, 200, await gate.status(cookie));
  }) as RequestHandler;

  const requestHandler = (async (req, res) => {
    const parsed = authRequestSchema.safeParse(json.parseRecord(await readBody(req)));
    if (!parsed.success) return sendJson(res, 200, { ok: true }); // anti-enumeration
    sendJson(res, 200, await gate.request(parsed.data.email, clientIp(req)));
  }) as RequestHandler;

  const verifyHandler = (async (req, res) => {
    const parsed = authVerifySchema.safeParse(json.parseRecord(await readBody(req)));
    if (!parsed.success) return sendJson(res, 200, { ok: false });
    const result = await gate.verify(parsed.data.email, parsed.data.code, clientIp(req));
    const cookie =
      result.ok && result.token ? sessionCookie(result.token, gate.sessionTtlSeconds) : undefined;
    sendJson(
      res,
      200,
      { ok: result.ok, ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) },
      cookie,
    );
  }) as RequestHandler;

  const logoutHandler = ((_req, res) => {
    sendJson(res, 200, { ok: true }, `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
  }) as RequestHandler;

  addRoute("get", `${AUTH_PREFIX}/status`, statusHandler);
  addRoute("post", `${AUTH_PREFIX}/request`, requestHandler);
  addRoute("post", `${AUTH_PREFIX}/verify`, verifyHandler);
  addRoute("post", `${AUTH_PREFIX}/logout`, logoutHandler);

  // --- The gate middleware (runs before static + the app's /api handlers) ---

  const gateMiddleware = (async (req, res, next) => {
    // Not tunnel traffic (platform front door, or any other local caller): the
    // request is already authenticated (or is not ours to gate). Pass through.
    if (!isTunnelHost(req, publicDomain)) return next();

    const path = (req.url ?? "/").split("?")[0] ?? "/";

    // The login flow is open so the browser can render <AuthGate> and sign in.
    if (path.startsWith(AUTH_PREFIX)) return next();

    // Anti-spoof: only the gate may assert identity on tunnel traffic.
    applyHeaderPolicy(req);

    // Static (non-API) loads freely so the SPA can render; drop the gate cookie.
    if (!path.startsWith("/api/")) {
      stripSessionCookie(req);
      return next();
    }

    // Every other /api/* needs a valid OTP session.
    const cookie = http.parseCookies(req.headers.cookie ?? null)[SESSION_COOKIE_NAME];
    const email = await gate.session(cookie);
    if (!email) {
      sendJson(res, 401, { error: "authentication required", loginPath: AUTH_PREFIX });
      return;
    }
    injectIdentity(req, email);
    stripSessionCookie(req);
    next();
  }) as RequestHandler;

  addMiddleware("/", gateMiddleware);
}
