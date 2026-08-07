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
import {
  authRequestSchema,
  authVerifySchema,
  type AuthStatus,
  SESSION_COOKIE_NAME,
} from "@dbx-tools/shared-auth";
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
    trustedOrigins: [origin],
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
          if (!(await config.authorizeIdentity(address))) return;
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
    if (path === `${basePath}/request` && request.method === "POST") {
      const parsed = authRequestSchema.safeParse(await requestJson(request));
      if (parsed.success) {
        await auth.api
          .sendVerificationOTP({
            body: { email: normalizeEmail(parsed.data.email), type: "sign-in" },
            headers: request.headers,
          })
          .catch(() => undefined);
      }
      return jsonResponse({ ok: true });
    }
    if (path === `${basePath}/verify` && request.method === "POST") {
      const parsed = authVerifySchema.safeParse(await requestJson(request));
      if (!parsed.success) return jsonResponse({ ok: false });
      try {
        const response = await auth.api.signInEmailOTP({
          body: {
            email: normalizeEmail(parsed.data.email),
            otp: parsed.data.code,
            name: displayName(parsed.data.email),
          },
          headers: request.headers,
          asResponse: true,
        });
        return compatibilityResponse(response, { ok: response.ok });
      } catch {
        return jsonResponse({ ok: false });
      }
    }
    if (path === `${basePath}/logout` && request.method === "POST") {
      const response = await auth.api.signOut({
        headers: request.headers,
        asResponse: true,
      });
      return compatibilityResponse(response, { ok: response.ok });
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

function normalizeEmail(email: string | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function displayName(email: string): string {
  return normalizeEmail(email).split("@")[0] || "User";
}

async function requestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
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
