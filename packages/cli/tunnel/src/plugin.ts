/**
 * `authGate()` - the AppKit plugin behind the tunnel's email-OTP gate.
 *
 * It has NO routes of its own: the tunnel PROXY (not an HTTP server) calls the
 * handlers this plugin exposes via {@link AuthGatePlugin.exports}. The plugin
 * owns the allow-list, the per-email/per-IP rate limiters, the CacheManager-backed
 * one-time-code store, and the session JWT. `createApp` (with no `server()`) is
 * used only to auto-init `CacheManager` + prime the sibling `email` transport;
 * this plugin is where the gate logic lives.
 *
 * Options come from CLI flags OR env, with sensible defaults - see
 * {@link resolveAuthGateConfig}. The one runtime dependency the plugin can't
 * resolve itself is HOW to email the code, so it takes a `sendCode` callback the
 * app wires to the email plugin.
 *
 * @module
 */

import { Plugin, toPlugin, type BasePluginConfig, type PluginManifest } from "@databricks/appkit";
import { log, string } from "@dbx-tools/shared-core";
import type { AuthStatus } from "@dbx-tools/shared-email";
import { looksLikeEmail, matchesAllowlist } from "./allowlist.ts";
import { CodeStore, signSession, verifySession } from "./otp.ts";
import { RateLimiter } from "./rate-limit.ts";

const logger = log.logger("tunnel:auth");

/** Options for the {@link authGate} plugin (all resolvable from env - see below). */
export interface AuthGateConfig extends BasePluginConfig {
  /** Allow-list patterns (domain / glob / `/regex/`). Empty = allow nobody. Env EMAIL_AUTH_ALLOW. */
  allow?: string | string[];
  /** Subject line for the code email. Env AUTH_SUBJECT. */
  subject?: string;
  /** Product/brand name used in the email + login copy. Env AUTH_BRAND_NAME. */
  brandName?: string;
  /** One-line message shown above the code in the email. Env AUTH_MESSAGE. */
  message?: string;
  /** Session lifetime (seconds). Env AUTH_SESSION_TTL. Default 43200 (12h). */
  sessionTtlSeconds?: number;
  /** One-time-code lifetime (seconds). Env AUTH_CODE_TTL. Default 600 (10m). */
  codeTtlSeconds?: number;
  /** Max verify attempts per issued code. Default 5. */
  maxAttempts?: number;
  /** Deliver a code to an address. Wired by the app to the email plugin. */
  sendCode?: (email: string, code: string, opts: SendCodeOptions) => Promise<void>;
}

/** Branding/messaging passed to {@link AuthGateConfig.sendCode}. */
export interface SendCodeOptions {
  subject: string;
  brandName: string;
  message: string;
}

/** Resolved gate config with env fallbacks + defaults applied. */
export interface ResolvedAuthGateConfig {
  allow: string[];
  subject: string;
  brandName: string;
  message: string;
  sessionTtlSeconds: number;
  codeTtlSeconds: number;
  maxAttempts: number;
}

const DEFAULTS = {
  subject: "Your sign-in code",
  brandName: "This app",
  message: "Your one-time sign-in code is:",
  sessionTtlSeconds: 43200,
  codeTtlSeconds: 600,
  maxAttempts: 5,
};

/** Positive finite number from a value / env string, else the fallback. */
function num(value: number | undefined, env: string | undefined, fallback: number): number {
  const raw = value ?? (env ? Number(env) : undefined);
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Merge {@link AuthGateConfig} over env over defaults into a resolved config. */
export function resolveAuthGateConfig(config: AuthGateConfig): ResolvedAuthGateConfig {
  return {
    allow: [...string.parseList(config.allow), ...string.parseList(process.env.EMAIL_AUTH_ALLOW)],
    subject: config.subject ?? process.env.AUTH_SUBJECT?.trim() ?? DEFAULTS.subject,
    brandName: config.brandName ?? process.env.AUTH_BRAND_NAME?.trim() ?? DEFAULTS.brandName,
    message: config.message ?? process.env.AUTH_MESSAGE?.trim() ?? DEFAULTS.message,
    sessionTtlSeconds: num(
      config.sessionTtlSeconds,
      process.env.AUTH_SESSION_TTL,
      DEFAULTS.sessionTtlSeconds,
    ),
    codeTtlSeconds: num(config.codeTtlSeconds, process.env.AUTH_CODE_TTL, DEFAULTS.codeTtlSeconds),
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
  };
}

/** The handlers the proxy calls in-process (returned by {@link AuthGatePlugin.exports}). */
export interface AuthGateApi {
  /** Handle a code request. Always resolves `{ ok: true }` (anti-enumeration). */
  request(email: string, ip: string): Promise<{ ok: true; retryAfter?: number }>;
  /** Handle a code verification. On success returns the session token to cookie. */
  verify(
    email: string,
    code: string,
    ip: string,
  ): Promise<{ ok: boolean; token?: string; retryAfter?: number }>;
  /** Resolve the authenticated email for a session token, or undefined. */
  session(token: string | undefined): Promise<string | undefined>;
  /** Session TTL in seconds (for the cookie Max-Age). */
  readonly sessionTtlSeconds: number;
  /** The gate status payload (`enabled` is always true when this plugin runs). */
  status(token: string | undefined): Promise<AuthStatus>;
}

/** AppKit plugin owning the email-OTP gate's logic (no HTTP routes; proxy-driven). */
export class AuthGatePlugin extends Plugin<AuthGateConfig> {
  static manifest = {
    name: "authGate",
    displayName: "Auth Gate",
    description: "Email one-time-password access gate for a public tunnel.",
    stability: "beta",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"authGate">;

  private resolved!: ResolvedAuthGateConfig;
  private codes!: CodeStore;
  // Requesting a code is email-spam-prone; verifying is a brute-force surface.
  // Per-email AND per-IP so neither axis alone is a bypass.
  private readonly requestLimiter = new RateLimiter(5, 15 * 60 * 1000);
  private readonly verifyLimiter = new RateLimiter(10, 15 * 60 * 1000);

  override async setup(): Promise<void> {
    this.resolved = resolveAuthGateConfig(this.config);
    this.codes = new CodeStore(this.resolved.codeTtlSeconds, this.resolved.maxAttempts);
    logger.info("ready", {
      patterns: this.resolved.allow.length,
      sessionTtlSeconds: this.resolved.sessionTtlSeconds,
    });
  }

  override exports(): AuthGateApi {
    return {
      sessionTtlSeconds: this.resolved.sessionTtlSeconds,
      request: (email, ip) => this.handleRequest(email, ip),
      verify: (email, code, ip) => this.handleVerify(email, code, ip),
      session: (token) => verifySession(token),
      status: async (token) => ({
        authenticated: Boolean(await verifySession(token)),
        email: (await verifySession(token)) ?? undefined,
        enabled: true,
      }),
    };
  }

  private async handleRequest(
    email: string,
    ip: string,
  ): Promise<{ ok: true; retryAfter?: number }> {
    const address = email.trim().toLowerCase();
    const byIp = this.requestLimiter.hit(`ip:${ip}`);
    const byEmail = this.requestLimiter.hit(`email:${address}`);
    if (!byIp.allowed || !byEmail.allowed) {
      return { ok: true, retryAfter: byIp.retryAfter ?? byEmail.retryAfter };
    }
    if (looksLikeEmail(address) && matchesAllowlist(address, this.resolved.allow)) {
      const code = await this.codes.issue(address);
      try {
        await this.config.sendCode?.(address, code, {
          subject: this.resolved.subject,
          brandName: this.resolved.brandName,
          message: this.resolved.message,
        });
      } catch (error) {
        logger.warn("failed to send OTP email", { error });
      }
    }
    return { ok: true };
  }

  private async handleVerify(
    email: string,
    code: string,
    ip: string,
  ): Promise<{ ok: boolean; token?: string; retryAfter?: number }> {
    const address = email.trim().toLowerCase();
    const byIp = this.verifyLimiter.hit(`ip:${ip}`);
    const byEmail = this.verifyLimiter.hit(`email:${address}`);
    if (!byIp.allowed || !byEmail.allowed) {
      return { ok: false, retryAfter: byIp.retryAfter ?? byEmail.retryAfter };
    }
    if ((await this.codes.verify(address, code.trim())) !== "ok") return { ok: false };
    this.requestLimiter.reset(`email:${address}`);
    this.verifyLimiter.reset(`email:${address}`);
    return { ok: true, token: await signSession(address, this.resolved.sessionTtlSeconds) };
  }
}

/** Factory: `authGate({ allow, subject, ... })` for an AppKit `plugins` array. */
export const authGate = toPlugin(AuthGatePlugin);
