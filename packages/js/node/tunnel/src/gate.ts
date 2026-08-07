/**
 * The tunnel's in-app AUTH GATE - Express middleware + login routes the
 * {@link AuthGatePlugin} registers on the app's OWN server via `this.context`.
 *
 * The gate is MIDDLEWARE, not a reverse proxy - the app is the process, so there is
 * nothing to forward to. It either short-circuits (401, or answers the open login
 * routes) or calls `next()` to let the app's real handlers run. It is the
 * "stands in for AppKit auth" path:
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

import type { IncomingMessage } from "node:http";
import { log, token } from "@dbx-tools/shared-core";
import type { RequestHandler, Response } from "express";
import { toHeaderPolicy, type HeaderPolicy } from "./headers.ts";
import type { AuthGateApi } from "./plugin.ts";

const logger = log.logger("tunnel:gate");

type WebRequestInput = IncomingMessage & {
  body?: unknown;
  originalUrl?: string;
};

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
export function isTunnelHost(req: IncomingMessage, publicDomain: string | undefined): boolean {
  if (!publicDomain) return false;
  const host = (req.headers.host ?? "").toLowerCase().split(":")[0];
  return host === publicDomain.toLowerCase().split(":")[0];
}

/**
 * Client IP for rate-limiting: the RIGHTMOST `x-forwarded-for` entry (the value
 * the nearest trusted hop - portr - wrote), else the socket address. Reading the
 * rightmost, not the leftmost, stops a caller minting a fresh rate-limit bucket by
 * varying the header. Called before {@link stripHeaders}.
 */
export function clientIp(req: IncomingMessage): string {
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
function stripSessionCookie(req: IncomingMessage): void {
  const raw = req.headers.cookie;
  if (!raw) return;
  const kept = raw
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith("dbx-tools-auth=") && !c.startsWith("dbx-tools-passkey="));
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
function injectIdentity(req: IncomingMessage, email: string): void {
  req.headers[token.USER_ID_HEADER] = email;
  req.headers[token.USER_EMAIL_HEADER] = email;
}

/** Read the raw request body as text (AppKit parses JSON, but the gate routes
 * are mounted before that runs for tunnel traffic, so read defensively). */
function readBody(req: WebRequestInput): Promise<string> {
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

export function webHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

export async function webRequest(req: WebRequestInput): Promise<globalThis.Request> {
  const host = req.headers.host ?? "localhost";
  const hostname = host.split(":")[0]?.toLowerCase();
  const protocol = hostname === "localhost" || hostname === "127.0.0.1" ? "http" : "https";
  const method = (req.method ?? "GET").toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
  return new globalThis.Request(`${protocol}://${host}${req.originalUrl || req.url}`, {
    method,
    headers: webHeaders(req),
    ...(body ? { body } : {}),
  });
}

export async function sendWebResponse(res: Response, response: globalThis.Response): Promise<void> {
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);
  const body = Buffer.from(await response.arrayBuffer());
  res.status(response.status).send(body);
}

/**
 * What the caller should do with a request, from {@link gateRequest}.
 *
 *   - `pass` - not tunnel traffic, or an open login route. Forward untouched.
 *   - `allow` - tunnel traffic that is authorized. The request's headers have
 *     ALREADY been rewritten (policy applied, identity injected, session cookie
 *     stripped), so forward it as it now stands.
 *   - `deny` - tunnel traffic with no valid session. Answer `401` with
 *     {@link AUTH_PREFIX} as the login path.
 */
export type GateAction = "pass" | "allow" | "deny";

/**
 * THE gating decision, for one request, independent of how it will be answered.
 *
 * Both paths call this: the Express middleware below (where the app is the
 * process) and `@dbx-tools/cli-tunnel`'s reverse proxy (where the app is a child
 * process on a private port). A divergence between them would be a security bug
 * the second path could not be tested into agreement - one path forgetting to
 * strip `x-forwarded-access-token` is enough - so the decision, the header
 * rewriting, and the identity injection live here once and the transports only
 * differ in how they WRITE the outcome.
 *
 * Mutates `req.headers` on the `allow`/`pass`-with-cookie paths, which is exactly
 * what both callers want: Express hands the same object to the app's handlers, and
 * the proxy forwards it upstream.
 */
export async function gateRequest(
  req: IncomingMessage,
  options: GateOptions & { headerPolicy?: HeaderPolicy },
): Promise<GateAction> {
  const { gate, publicDomain } = options;
  // Not tunnel traffic (platform front door, or any other local caller): the
  // request is already authenticated, or is not ours to gate.
  if (!isTunnelHost(req, publicDomain)) return "pass";

  const path = (req.url ?? "/").split("?")[0] ?? "/";
  // The login flow is open so the browser can render <AuthGate> and sign in.
  if (path.startsWith(AUTH_PREFIX)) return "pass";

  // Anti-spoof: only the gate may assert identity on tunnel traffic.
  const policy = options.headerPolicy ?? toHeaderPolicy(options.forwardHeaders);
  const removed = policy.apply(req.headers as Record<string, unknown>);
  if (removed.length) logger.debug("stripped inbound headers", { removed });

  // Static (non-API) loads freely so the SPA can render; drop the gate cookie.
  if (!path.startsWith("/api/")) {
    stripSessionCookie(req);
    return "pass";
  }

  // Every other /api/* needs a valid Better Auth session.
  const email = await gate.session(webHeaders(req));
  if (!email) return "deny";
  injectIdentity(req, email);
  stripSessionCookie(req);
  return "allow";
}

/** The body of a `deny`, shared so both paths answer a 401 identically. */
export const UNAUTHORIZED_BODY = {
  error: "authentication required",
  loginPath: AUTH_PREFIX,
} as const;

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
  _addRoute: (method: "get" | "post", path: string, handler: RequestHandler) => void,
  addMiddleware: (path: string, handler: RequestHandler) => void,
): void {
  const { gate, publicDomain, forwardHeaders } = opts;
  const headerPolicy = toHeaderPolicy(forwardHeaders);
  logger.debug("gate mounted", { publicDomain, forward: headerPolicy.patterns });

  // Better Auth and the compatibility routes share one fetch-compatible
  // handler in both hosting modes.
  const authHandler = (async (req, res) => {
    if (!isTunnelHost(req, publicDomain)) {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (path.endsWith("/status")) {
        res.status(200).json({ authenticated: false, enabled: false, passkeysEnabled: false });
      } else {
        res.status(404).json({ error: "not found" });
      }
      return;
    }
    await sendWebResponse(res, await gate.handler(await webRequest(req)));
  }) as RequestHandler;
  addMiddleware(AUTH_PREFIX, authHandler);

  // --- The gate middleware (runs before static + the app's /api handlers) ---

  const gateMiddleware = (async (req, res, next) => {
    const action = await gateRequest(req, { gate, publicDomain, headerPolicy });
    if (action === "deny") res.status(401).json(UNAUTHORIZED_BODY);
    else next();
  }) as RequestHandler;

  addMiddleware("/", gateMiddleware);
}
