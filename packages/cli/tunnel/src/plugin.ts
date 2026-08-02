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
import { brand, env, log, string } from "@dbx-tools/shared-core";
import type { AuthStatus } from "@dbx-tools/shared-email";
import { looksLikeEmail, matchesAllowlist } from "./allowlist.ts";
import { CodeStore, signSession, verifySession } from "./otp.ts";
import { RateLimiter } from "./rate-limit.ts";

const logger = log.logger("tunnel:auth");

/** Options for the {@link authGate} plugin (all resolvable from env - see below). */
export interface AuthGateConfig extends BasePluginConfig {
  /** Allow-list patterns (domain / glob / `/regex/`). Empty = allow nobody. Env EMAIL_AUTH_ALLOW. */
  allow?: string | string[];
  /**
   * Subject line for the code email. Env AUTH_SUBJECT.
   *
   * Defaults to "Your verification code". The wording of the subject and
   * {@link message} is deliberately the conventional phrasing rather than
   * anything branded: iOS, Gmail, Outlook, and Android all detect a one-time
   * code from this shape and offer to autofill it, and a novel phrasing is what
   * breaks that detection.
   */
  subject?: string;
  /**
   * Display name used in the code email copy. Env AUTH_BRAND_NAME.
   *
   * Defaults to the brand context's `name` - the app's own `branding/brand.yaml`
   * when it has one, else the dbx-tools default. Set this only to override the
   * brand for this gate.
   */
  brandName?: string;
  /**
   * Line shown immediately above the code in the email. Env AUTH_MESSAGE.
   *
   * Keep the code on its OWN line directly after this text - that adjacency is
   * what the platform code-detection heuristics key on.
   */
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
  /**
   * Lifetime of the code being sent, in seconds - the RESOLVED
   * {@link AuthGateConfig.codeTtlSeconds}, so the email can state the real
   * expiry ("This code expires in 10 minutes") instead of a vague "shortly"
   * that drifts from the configured TTL.
   */
  codeTtlSeconds: number;
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
  subject: "Your verification code",
  // The repo-wide brand context's display name, NOT a hardcoded product string:
  // this name is what the recipient reads in the code email, so it has to be the
  // same identity the rest of the app presents. A host with its own
  // `branding/brand.yaml` overrides it by passing `brandName` (see
  // {@link startGateApp}, which resolves the on-disk context); the shared default
  // is the fallback when nothing is configured.
  brandName: brand.defaultBrandContext.name,
  message: "Your verification code is:",
  sessionTtlSeconds: 43200,
  codeTtlSeconds: 600,
  maxAttempts: 5,
};

/** Merge {@link AuthGateConfig} over env over defaults into a resolved config. */
export function resolveAuthGateConfig(config: AuthGateConfig): ResolvedAuthGateConfig {
  return {
    // Both sources are unioned rather than one overriding: a deployment-wide
    // EMAIL_AUTH_ALLOW and a per-invocation `--allow` should both grant access.
    allow: [...string.parseList(config.allow), ...string.parseList(process.env.EMAIL_AUTH_ALLOW)],
    subject: env.string(config.subject, "AUTH_SUBJECT") ?? DEFAULTS.subject,
    brandName: env.string(config.brandName, "AUTH_BRAND_NAME") ?? DEFAULTS.brandName,
    message: env.string(config.message, "AUTH_MESSAGE") ?? DEFAULTS.message,
    sessionTtlSeconds: env.positiveInt(
      config.sessionTtlSeconds,
      "AUTH_SESSION_TTL",
      DEFAULTS.sessionTtlSeconds,
    ),
    codeTtlSeconds: env.positiveInt(
      config.codeTtlSeconds,
      "AUTH_CODE_TTL",
      DEFAULTS.codeTtlSeconds,
    ),
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
          codeTtlSeconds: this.resolved.codeTtlSeconds,
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
