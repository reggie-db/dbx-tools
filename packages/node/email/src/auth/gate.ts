/**
 * The email-OTP access gate: runtime + Express middleware + request handlers.
 *
 * {@link AuthGate} owns the allow-list, rate limiters, code store, and session
 * signing. The plugin wires four routes to it (`request`/`verify`/`logout`/
 * `status`) and mounts {@link AuthGate.middleware} so every OTHER request needs a
 * valid session cookie.
 *
 * Design points:
 *   - `request` ALWAYS resolves `{ ok: true }` (anti-enumeration): a code is only
 *     generated + emailed when the address is allow-listed AND under the rate
 *     limit, but the caller can't tell the difference.
 *   - the session lives in an HttpOnly + SameSite=Lax cookie (Secure in prod), so
 *     it survives reloads and is not readable by page scripts.
 *   - fail-open on a missing signing secret (see `otp.ts`): a Databricks App is
 *     already access-limited; an unset `AUTH_JWT_SECRET` degrades to
 *     non-durable sessions, not a lockout.
 *
 * @module
 */

import type { CookieOptions, NextFunction, Request, Response } from "express";
import { http, log } from "@dbx-tools/shared-core";
import type { AuthStatus } from "@dbx-tools/shared-email";
import { looksLikeEmail, matchesAllowlist } from "./allowlist.ts";
import { CodeStore, signSession, verifySession } from "./otp.ts";
import { RateLimiter } from "./rate-limit.ts";

const logger = log.logger("email:auth");

/** Cookie the session JWT rides in. */
export const SESSION_COOKIE = "dbx_auth";

/** Route prefix (under the plugin base `/api/email`) the gate leaves open. */
const AUTH_PATH_PREFIX = "/auth";

/** Resolved gate configuration. */
export interface AuthGateOptions {
  /** Allow-list patterns (domain / glob / `/regex/`). Empty = allow nobody. */
  readonly allow: readonly string[];
  /** Session lifetime in seconds. */
  readonly sessionTtlSeconds: number;
  /** One-time code lifetime in seconds. */
  readonly codeTtlSeconds: number;
  /** Max verify attempts per issued code. */
  readonly maxAttempts: number;
  /** Send the code email. Returns nothing; failures are logged, not surfaced. */
  readonly sendCode: (email: string, code: string) => Promise<void>;
  /** True in production (sets the `Secure` cookie flag). */
  readonly secureCookies: boolean;
}

/** The email-OTP gate for one app. */
export class AuthGate {
  private readonly codes: CodeStore;
  // Separate limiters: requesting a code is cheap-to-abuse (email spam), verifying
  // is a brute-force surface. Per-email AND per-IP so neither axis alone is a bypass.
  private readonly requestLimiter = new RateLimiter(5, 15 * 60 * 1000);
  private readonly verifyLimiter = new RateLimiter(10, 15 * 60 * 1000);

  constructor(private readonly options: AuthGateOptions) {
    this.codes = new CodeStore(options.codeTtlSeconds * 1000, options.maxAttempts);
  }

  /**
   * Handle `POST /auth/request`. Always resolves `{ ok: true }` (plus a
   * `retryAfter` when rate-limited); a code is issued + emailed only for an
   * allow-listed address under the limit. Errors in sending are swallowed so the
   * response never reveals whether an address exists / is allowed.
   */
  async handleRequest(email: string, ip: string): Promise<{ ok: true; retryAfter?: number }> {
    const address = email.trim().toLowerCase();
    const byIp = this.requestLimiter.hit(`ip:${ip}`);
    const byEmail = this.requestLimiter.hit(`email:${address}`);
    if (!byIp.allowed || !byEmail.allowed) {
      return { ok: true, retryAfter: byIp.retryAfter ?? byEmail.retryAfter };
    }
    if (looksLikeEmail(address) && matchesAllowlist(address, this.options.allow)) {
      const code = this.codes.issue(address);
      try {
        await this.options.sendCode(address, code);
      } catch (error) {
        logger.warn("failed to send OTP email", { error });
      }
    }
    return { ok: true };
  }

  /**
   * Handle `POST /auth/verify`. On a correct code, returns the session `token`
   * plus the `cookieOptions` for it so the route sets it with Express's own
   * `res.cookie(SESSION_COOKIE, token, options)` (no hand-rolled Set-Cookie).
   * Failures return `{ ok: false }` with a generic reason.
   */
  async handleVerify(
    email: string,
    code: string,
    ip: string,
    secure: boolean,
  ): Promise<{ ok: boolean; token?: string; cookieOptions?: CookieOptions; retryAfter?: number }> {
    const address = email.trim().toLowerCase();
    const byIp = this.verifyLimiter.hit(`ip:${ip}`);
    const byEmail = this.verifyLimiter.hit(`email:${address}`);
    if (!byIp.allowed || !byEmail.allowed) {
      return { ok: false, retryAfter: byIp.retryAfter ?? byEmail.retryAfter };
    }
    if (this.codes.verify(address, code.trim()) !== "ok") return { ok: false };
    // Correct code: clear the caller's request/verify budget and mint a session.
    this.requestLimiter.reset(`email:${address}`);
    this.verifyLimiter.reset(`email:${address}`);
    const token = await signSession(address, this.options.sessionTtlSeconds);
    return { ok: true, token, cookieOptions: this.cookieOptions(secure) };
  }

  /** Express cookie options for the session (used with `res.cookie`/`res.clearCookie`). */
  cookieOptions(secure: boolean): CookieOptions {
    return {
      httpOnly: true,
      sameSite: "lax",
      secure: secure || this.options.secureCookies,
      path: "/",
      maxAge: this.options.sessionTtlSeconds * 1000,
    };
  }

  /** Resolve the authenticated email for a request, or `undefined`. */
  async authenticate(req: Request): Promise<string | undefined> {
    // Reuse shared-core's cookie parser (accepts an Express req directly) rather
    // than re-implementing header splitting here.
    const token = http.parseCookies(req)[SESSION_COOKIE];
    return verifySession(token);
  }

  /** The `GET /auth/status` payload for a request. */
  async status(req: Request): Promise<AuthStatus> {
    const email = await this.authenticate(req);
    return { authenticated: Boolean(email), email, enabled: true };
  }

  /**
   * Express middleware gating the app's DATA APIs behind a session.
   *
   * It gates `/api/*` and returns 401 for an unauthenticated caller - EXCEPT the
   * login flow itself (`<emailBase>/auth/*`), which must stay open so a caller
   * can obtain a session. Static assets (the SPA shell, JS/CSS, favicons) are
   * NOT gated: the browser has to load the client so the `<AuthGate>` React
   * component can render the login screen and call these endpoints. A gated
   * `/api` request from the un-logged-in SPA simply 401s, which the client
   * treats as "show the login". This is the standard SPA gate shape - protect
   * the data, serve the shell.
   *
   * `emailBase` is the email plugin's mount path (e.g. `/api/email`), so both the
   * open login prefix and the gated API prefix are matched on the full path.
   */
  middleware(emailBase: string): (req: Request, res: Response, next: NextFunction) => void {
    const openPrefix = `${emailBase}${AUTH_PATH_PREFIX}`;
    return (req, res, next) => {
      // Only API traffic is gated; static assets load freely so the login UI can.
      if (!req.path.startsWith("/api/") || req.path.startsWith(openPrefix)) {
        next();
        return;
      }
      void this.authenticate(req).then((email) => {
        if (email) {
          next();
        } else {
          res.status(401).json({ error: "authentication required", loginPath: openPrefix });
        }
      });
    };
  }
}
