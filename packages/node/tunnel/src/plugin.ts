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
import { brand, env, log, object, string } from "@dbx-tools/shared-core";
import type { AuthStatus } from "@dbx-tools/shared-email";
import { looksLikeEmail, matchesAllowlist } from "./allowlist.ts";
import {
  ALLOW_ENV,
  BRAND_NAME_ENV,
  CODE_TTL_ENV,
  FORWARD_HEADERS_ENV,
  INSECURE_ENV,
  MESSAGE_ENV,
  PUBLIC_DOMAIN_ENV,
  SESSION_TTL_ENV,
  SUBJECT_ENV,
} from "./env.ts";
import { mountGate } from "./gate.ts";
import { CodeStore, signSession, verifySession } from "./otp.ts";
import { RateLimiter } from "./rate-limit.ts";
import { ensureEmailAvailable, sendCode as defaultSendCode } from "./send-code.ts";
import { KEY_TTL_SECONDS, resolveSessionCutoff, signingKey } from "./signing-key.ts";

const logger = log.logger("tunnel:auth");

/** Options for the {@link authGate} plugin (all resolvable from env - see below). */
export interface AuthGateConfig extends BasePluginConfig {
  /** Allow-list patterns (domain / glob / `/regex/`). Empty = allow nobody. Env TUNNEL_AUTH_ALLOW. */
  allow?: string | string[];
  /**
   * Subject line for the code email. Env TUNNEL_AUTH_SUBJECT.
   *
   * Defaults to "Your verification code". The wording of the subject and
   * {@link message} is deliberately the conventional phrasing rather than
   * anything branded: iOS, Gmail, Outlook, and Android all detect a one-time
   * code from this shape and offer to autofill it, and a novel phrasing is what
   * breaks that detection.
   *
   * This is the subject TEMPLATE, not the literal line sent: the code is spliced
   * into it (`"123456 is your verification code"`) because a push notification
   * shows only the subject and preheader, and that notification is what mobile
   * autofill reads. See `codeEmailSubject` in `./app.ts`.
   */
  subject?: string;
  /**
   * Display name used in the code email copy. Env TUNNEL_AUTH_BRAND_NAME.
   *
   * Defaults to the brand context's `name` - the app's own `branding/brand.yaml`
   * when it has one, else the dbx-tools default. Set this only to override the
   * brand for this gate.
   */
  brandName?: string;
  /**
   * Line shown immediately above the code in the email. Env TUNNEL_AUTH_MESSAGE.
   *
   * Keep the code on its OWN line directly after this text - that adjacency is
   * what the platform code-detection heuristics key on.
   */
  message?: string;
  /**
   * Session lifetime (seconds). Env TUNNEL_AUTH_SESSION_TTL. Default 2592000 (30d).
   *
   * Matched to the cache-backed signing key's own 30-day TTL (see
   * `./signing-key.ts`): the cookie and the key that validates it should expire
   * together, or one silently outlives the other.
   */
  sessionTtlSeconds?: number;
  /** One-time-code lifetime (seconds). Env TUNNEL_AUTH_CODE_TTL. Default 600 (10m). */
  codeTtlSeconds?: number;
  /** Max verify attempts per issued code. Default 5. */
  maxAttempts?: number;
  /**
   * Force-clear cutoff: every session issued BEFORE it stops verifying, so moving
   * it forward signs everyone out. Env TUNNEL_AUTH_SESSION_CUTOFF.
   *
   * Anything `object.toDate` accepts: a `Date`, `2026-08-02`, an ISO instant,
   * epoch seconds/millis, or a relative duration (`-30d`, `7 days ago`). Unset
   * means no cutoff.
   */
  sessionCutoff?: string | number | Date;
  /**
   * Deliver a code to an address. Defaults to sending through the host app's
   * shared `@dbx-tools/email` transport (see `./send-code`); override to wire a
   * different delivery path.
   */
  sendCode?: (email: string, code: string, opts: SendCodeOptions) => Promise<void>;
  /**
   * The public `<subdomain>.<server>` that identifies portr traffic by its `Host`
   * header. Only requests whose `Host` matches this are gated; everything else
   * (the platform front door, other local callers) passes through. Env
   * `TUNNEL_PUBLIC_DOMAIN`. When absent, the gate is inert (nothing is tunnel
   * traffic).
   */
  publicDomain?: string;
  /**
   * Extra `x-` request headers tunnel traffic may forward (literal / glob /
   * `/regex/`), unioned with the built-in allow-list. Env `TUNNEL_FORWARD_HEADERS`.
   */
  forwardHeaders?: string | string[];
  /**
   * Run OPEN with no gate (env `TUNNEL_INSECURE=true`). The login routes and gate
   * middleware are not mounted, and the SMTP fail-fast is skipped. Use only when
   * the tunnel is deliberately public.
   */
  insecure?: boolean;
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
  /** Force-clear cutoff in epoch ms; `0` when unset. */
  sessionCutoffMs: number;
  /** Public domain that identifies portr traffic by `Host`; `undefined` = inert. */
  publicDomain?: string;
  /** Extra `x-` headers tunnel traffic may forward (unioned with the defaults). */
  forwardHeaders: string[];
  /** Run OPEN with no gate. */
  insecure: boolean;
}

const DEFAULTS = {
  subject: "Your verification code",
  // The repo-wide brand context's display name, NOT a hardcoded product string:
  // this name is what the recipient reads in the code email, so it has to be the
  // same identity the rest of the app presents. A host with its own
  // `branding/brand.yaml` overrides it by passing `brandName`; the shared default
  // is the fallback when nothing is configured.
  brandName: brand.defaultBrandContext.name,
  message: "Your verification code is:",
  // 30 days, the same window the cache-backed signing key is stored for.
  sessionTtlSeconds: KEY_TTL_SECONDS,
  codeTtlSeconds: 600,
  maxAttempts: 5,
};

/** Merge {@link AuthGateConfig} over env over defaults into a resolved config. */
export function resolveAuthGateConfig(config: AuthGateConfig): ResolvedAuthGateConfig {
  return {
    // Both sources are unioned rather than one overriding: a deployment-wide
    // TUNNEL_AUTH_ALLOW and a per-invocation `--allow` should both grant access.
    // Hence `parseList` on each rather than `env.list`, which stops at the first
    // source that yields anything.
    allow: [...string.parseList(config.allow), ...string.parseList(env.text(ALLOW_ENV))],
    subject: env.string(config.subject, SUBJECT_ENV) ?? DEFAULTS.subject,
    brandName: env.string(config.brandName, BRAND_NAME_ENV) ?? DEFAULTS.brandName,
    message: env.string(config.message, MESSAGE_ENV) ?? DEFAULTS.message,
    sessionTtlSeconds: env.positiveInt(
      config.sessionTtlSeconds,
      SESSION_TTL_ENV,
      DEFAULTS.sessionTtlSeconds,
    ),
    codeTtlSeconds: env.positiveInt(config.codeTtlSeconds, CODE_TTL_ENV, DEFAULTS.codeTtlSeconds),
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    sessionCutoffMs: resolveSessionCutoff(config.sessionCutoff),
    publicDomain: env.string(config.publicDomain, PUBLIC_DOMAIN_ENV) ?? undefined,
    forwardHeaders: [
      ...string.parseList(config.forwardHeaders),
      ...string.parseList(env.text(FORWARD_HEADERS_ENV)),
    ],
    insecure: env.boolean(config.insecure, INSECURE_ENV) ?? false,
  };
}

/** The handlers the gate middleware calls in-process (returned by {@link AuthGatePlugin.exports}). */
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

/**
 * AppKit plugin owning the email-OTP gate. On `setup()` it registers the login
 * routes (`/api/email/auth/*`) and a gating middleware on the app's OWN Express
 * server via `this.context`, so a public portr caller must prove an email before
 * reaching the app's `/api/*` - see `./gate`. Front-door (platform) traffic and
 * other local callers pass through untouched (the gate keys on the `Host` header).
 */
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
    // Resolve the signing key HERE rather than lazily on the first sign-in, so a
    // cache that cannot hold it (and the resulting "sessions won't survive a
    // restart" warning) shows up in the startup log, not hours later.
    const { cutoffMs } = await signingKey(this.resolved.sessionCutoffMs);

    if (this.resolved.insecure) {
      logger.warn("insecure mode - the tunnel runs OPEN with no email-OTP gate");
    } else {
      this.mountGateRoutes();
      // Fail fast (post-boot, once the email plugin has primed its transport):
      // a gate that cannot email a code lets nobody in. `setup:complete` is when
      // every plugin's `setup()` - including `email()`'s - has resolved.
      this.context?.onLifecycle("setup:complete", () => ensureEmailAvailable());
    }

    logger.info("ready", {
      patterns: this.resolved.allow.length,
      sessionTtlSeconds: this.resolved.sessionTtlSeconds,
      publicDomain: this.resolved.publicDomain ?? null,
      insecure: this.resolved.insecure,
      ...object.optional("sessionCutoff", cutoffMs > 0 ? new Date(cutoffMs).toISOString() : null),
    });
  }

  /**
   * Register the login routes (`/api/email/auth/*`) and the gating middleware on
   * the app's OWN Express server, via `this.context`. Uses `addRoute`/`addMiddleware`
   * (absolute paths) rather than `injectRoutes` because the login routes live at
   * the client's fixed `/api/email/auth/*` contract, not under this plugin's
   * `/api/authGate` base. Both buffer until the server plugin registers as the
   * route target and flush middleware-before-routes, so the gate runs before the
   * static handler and the app's own `/api/*` routes.
   */
  private mountGateRoutes(): void {
    const context = this.context;
    if (!context) {
      logger.warn("no plugin context - the OTP gate cannot mount its routes");
      return;
    }
    mountGate(
      {
        gate: this.exports(),
        publicDomain: this.resolved.publicDomain,
        forwardHeaders: this.resolved.forwardHeaders,
      },
      (method, path, handler) => context.addRoute(method, path, handler),
      (path, handler) => context.addMiddleware(path, handler),
    );
  }

  /** The code sender: the configured `sendCode`, else the shared-transport default. */
  private get sendCode(): NonNullable<AuthGateConfig["sendCode"]> {
    return this.config.sendCode ?? defaultSendCode;
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
        await this.sendCode(address, code, {
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
