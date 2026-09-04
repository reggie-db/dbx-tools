/**
 * Better Auth passwordless runtime with email OTP and passkeys.
 *
 * Callers provide authorization, delivery, storage, origin, and secret. Better
 * Auth owns users, OTP verification records, sessions, rate limits, passkey
 * credentials, and their native HTTP routes.
 *
 * @module
 */

import { passkey } from "@better-auth/passkey";
import { type AuthStatus, SESSION_COOKIE_NAME } from "@dbx-tools/shared-auth";
import { log } from "@dbx-tools/shared-core";
import { APIError, betterAuth, type BetterAuthOptions } from "better-auth";
import { emailOTP } from "better-auth/plugins";

import type { AuthStorage } from "./storage.ts";
import { migrateAuth } from "./storage.ts";

const logger = log.logger("auth");

export type AuthorizeIdentity = (email: string) => boolean | Promise<boolean>;

export interface AuthEmailOptions {
  subject: string;
  brandName: string;
  message: string;
  codeTtlSeconds: number;
}

export interface PasswordlessAuthOptions {
  storage: AuthStorage;
  baseURL: string;
  basePath?: string;
  appName: string;
  secret: string;
  sessionCookieName?: string;
  /** Same-origin path returned after logout. Defaults to `/`. */
  logoutRedirectPath?: string;
  sessionTtlSeconds: number;
  sessionCutoffMs?: number;
  codeTtlSeconds: number;
  maxAttempts: number;
  authorizeIdentity: AuthorizeIdentity;
  sendCode(email: string, code: string, options: AuthEmailOptions): Promise<void>;
  subject?: string;
  message?: string;
}

export interface PasswordlessAuthRuntime {
  readonly basePath: string;
  readonly passkeysEnabled: boolean;
  handler(request: Request): Promise<Response>;
  session(headers: Headers): Promise<string | undefined>;
  status(headers: Headers): Promise<AuthStatus>;
  close(): Promise<void>;
}

export async function createPasswordlessAuth(
  config: PasswordlessAuthOptions,
): Promise<PasswordlessAuthRuntime> {
  const origin = new URL(config.baseURL).origin;
  const rpID = new URL(origin).hostname;
  const basePath = config.basePath ?? "/api/auth";
  const logoutRedirectPath = normalizeLogoutRedirectPath(config.logoutRedirectPath);
  const emailOptions: AuthEmailOptions = {
    subject: config.subject ?? "Your verification code",
    brandName: config.appName,
    message: config.message ?? "Your verification code is:",
    codeTtlSeconds: config.codeTtlSeconds,
  };

  const options = {
    appName: config.appName,
    baseURL: origin,
    basePath,
    database: config.storage.database,
    secret: config.secret,
    // The gate fronts the app on whatever interface address the tunnel binds
    // (an overlay/LAN IP, localhost, or a public domain) — not just `baseURL`.
    // Better Auth's origin check would reject every other host with
    // INVALID_ORIGIN and block sign-in. Trust the request's own origin here:
    // this endpoint sits behind the OTP gate and the tunnel preserves the
    // browser's Host, so the fixed-origin CSRF check adds nothing while breaking
    // legitimate access. Same-origin requests (no Origin header) are allowed too.
    trustedOrigins: (request?: Request) => {
      const requestOrigin = request?.headers.get("origin");
      return requestOrigin ? [requestOrigin, origin] : [origin];
    },
    session: {
      expiresIn: config.sessionTtlSeconds,
      updateAge: Math.min(24 * 60 * 60, config.sessionTtlSeconds),
    },
    verification: {
      storeIdentifier: "hashed",
      storeInDatabase: true,
    },
    rateLimit: {
      enabled: true,
      window: 15 * 60,
      max: 10,
      customRules: {
        "/email-otp/send-verification-otp": { window: 15 * 60, max: 5 },
        "/sign-in/email-otp": { window: 15 * 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: origin.startsWith("https://"),
      ipAddress: {
        ipAddressHeaders: ["x-real-ip"],
        disableIpTracking: false,
      },
      cookies: {
        session_token: {
          name: config.sessionCookieName ?? SESSION_COOKIE_NAME,
          attributes: {
            httpOnly: true,
            sameSite: "lax",
            secure: origin.startsWith("https://"),
            path: "/",
          },
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            if (!(await config.authorizeIdentity(normalizeEmail(user.email)))) {
              throw new APIError("FORBIDDEN", { message: "Identity is not authorized" });
            }
            return { data: user };
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: config.codeTtlSeconds,
        allowedAttempts: config.maxAttempts,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return;
          const address = normalizeEmail(email);
          if (!(await config.authorizeIdentity(address))) {
            // Accept any address and fail SILENTLY for one not on the allow-list:
            // the request still returns 200 (so the gate never reveals who is
            // allowed), and no code is sent. Logged at debug for diagnostics, not
            // as a warning — an unknown address hitting the login page is normal.
            logger.debug("verification code suppressed: identity not authorized", {
              email: address,
            });
            return;
          }
          logger.info("sending verification code", { email: address });
          void config.sendCode(address, otp, emailOptions).catch((error: unknown) => {
            logger.error("verification email failed", { email: address, error });
          });
        },
      }),
      passkey({
        rpID,
        rpName: config.appName,
        origin,
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
        registration: { requireSession: true },
      }),
    ] as const,
  } satisfies BetterAuthOptions;

  await migrateAuth(options, config.storage);
  const auth = betterAuth(options);

  const session = async (headers: Headers): Promise<string | undefined> => {
    const current = await auth.api.getSession({ headers });
    const email = normalizeEmail(current?.user.email);
    const createdAt = current?.session.createdAt;
    const createdAtMs = createdAt ? new Date(createdAt).getTime() : Number.NaN;
    if (config.sessionCutoffMs && !(createdAtMs >= config.sessionCutoffMs)) return undefined;
    if (!email || !(await config.authorizeIdentity(email))) return undefined;
    return email;
  };

  const handleCompatibilityRoute = async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (path === `${basePath}/status`) {
      const email = await session(request.headers);
      return jsonResponse({
        authenticated: Boolean(email),
        ...(email ? { email } : {}),
        enabled: true,
        passkeysEnabled: true,
      });
    }
    // OTP send + verify go straight to better-auth's native emailOTP endpoints
    // (`/email-otp/send-verification-otp`, `/sign-in/email-otp`); there is no
    // compatibility wrapper for them. Failures there are logged by the plugin's
    // sendVerificationOTP hook, not swallowed behind an always-ok response.
    if (path === `${basePath}/logout` && request.method === "POST") {
      const response = await auth.api.signOut({
        headers: request.headers,
        asResponse: true,
      });
      return compatibilityResponse(response, { ok: response.ok, redirectTo: logoutRedirectPath });
    }
    if (path === `${basePath}/logout` && request.method === "GET") {
      const response = await auth.api.signOut({
        headers: request.headers,
        asResponse: true,
      });
      return redirectResponse(response, logoutRedirectPath);
    }
    return undefined;
  };

  return {
    basePath,
    passkeysEnabled: true,
    handler: async (request) => (await handleCompatibilityRoute(request)) ?? auth.handler(request),
    session,
    status: async (headers) => {
      const email = await session(headers);
      return {
        authenticated: Boolean(email),
        ...(email ? { email } : {}),
        enabled: true,
        passkeysEnabled: true,
      };
    },
    close: () => config.storage.close(),
  };
}

/** Restrict logout redirects to one same-origin application path. */
export function normalizeLogoutRedirectPath(value: string | undefined): string {
  const path = value?.trim();
  return path?.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/";
}

function normalizeEmail(email: string | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function compatibilityResponse(response: Response, body: unknown): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function redirectResponse(response: Response, location: string): Response {
  const headers = new Headers({ location });
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
