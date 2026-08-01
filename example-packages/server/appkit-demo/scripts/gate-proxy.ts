#!/usr/bin/env -S bun
/**
 * Email-OTP GATE reverse-proxy for the public portr tunnel.
 *
 * AppKit's plugin middleware runs AFTER every plugin's route sub-router, so the
 * in-app `@dbx-tools/email` gate cannot protect sibling APIs (e.g.
 * `/api/mastra/*`). Under `NODE_ENV=development` (which the tunnel requires so
 * the agent falls back to the service principal when the front door strips the
 * user token) those APIs would otherwise serve data to anyone with the tunnel
 * URL. This proxy closes that gap by sitting IN FRONT of the app: portr tunnels
 * to the proxy, the proxy validates the session cookie and only then forwards to
 * the app.
 *
 * Ports: the proxy binds `DATABRICKS_APP_PORT` (what portr tunnels); the AppKit
 * app binds `APP_INTERNAL_PORT` (loopback). start.sh sets both.
 *
 * Open paths (forwarded WITHOUT a session, so login can happen):
 *   - `/api/email/auth/*` - the OTP request/verify/status/logout routes (the app
 *     owns the real logic + email sending; the proxy just relays).
 *   - everything that is NOT `/api/*` - the SPA shell, JS/CSS, favicons - so the
 *     browser can load the client and render the `<AuthGate>` login screen.
 * Every other `/api/*` request requires a valid session cookie or gets 401.
 *
 * The session cookie + its `jose` verification are the SAME ones the in-app gate
 * issues (`@dbx-tools/email` `authOtp.verifySession` + `SESSION_COOKIE`), so a
 * code verified through the app sets a cookie this proxy accepts - one gate, two
 * enforcement points.
 */
import { authOtp, SESSION_COOKIE } from "@dbx-tools/email";
import { http } from "@dbx-tools/shared-core";

const publicPort = Number(process.env.DATABRICKS_APP_PORT ?? 8000);
const internalPort = Number(process.env.APP_INTERNAL_PORT ?? 8001);
const target = `http://127.0.0.1:${internalPort}`;

/** Paths reachable without a session: the login flow + all non-API (static) paths. */
function isOpen(path: string): boolean {
  if (path.startsWith("/api/email/auth")) return true;
  return !path.startsWith("/api/");
}

/** Forward a request to the app unchanged (method, headers, body, cookies). */
async function forward(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const upstream = `${target}${url.pathname}${url.search}`;
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: req.headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half"; // required by fetch when streaming a request body
  }
  return fetch(upstream, init);
}

Bun.serve({
  port: publicPort,
  hostname: "0.0.0.0",
  idleTimeout: 0, // don't cut long model streams
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (isOpen(pathname)) return forward(req);
    const token = http.parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
    const email = await authOtp.verifySession(token);
    if (!email) {
      return new Response(
        JSON.stringify({ error: "authentication required", loginPath: "/api/email/auth" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    return forward(req);
  },
});

console.log(`[gate-proxy] listening on 0.0.0.0:${publicPort} -> ${target} (session-gated)`);
