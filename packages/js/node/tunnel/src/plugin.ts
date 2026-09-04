/**
 * `authGate()` - the AppKit adapter around `@dbx-tools/auth-gate`.
 *
 * It has NO routes of its own: the tunnel PROXY (not an HTTP server) calls the
 * handlers this plugin exposes via {@link AuthGatePlugin.exports}. The plugin
 * owns tunnel authorization, AppKit Lakebase discovery, email delivery, and
 * transport mounting. Better Auth owns users, OTPs, sessions, rate limits, and
 * passkeys. `createApp` can run this plugin with or without `server()`.
 *
 * Options come from CLI flags OR env, with sensible defaults - see
 * {@link resolveAuthGateConfig}. The one runtime dependency the plugin can't
 * resolve itself is HOW to email the code, so it takes a `sendCode` callback the
 * app wires to the email plugin.
 *
 * @module
 */

import {
  lakebase,
  Plugin,
  toPlugin,
  type BasePluginConfig,
  type PluginManifest,
  type ResourceRequirement,
  ResourceType,
} from "@databricks/appkit";
import { plugin as appkitPlugin, brand as appkitBrand } from "@dbx-tools/appkit";
import {
  auth as passwordlessAuth,
  storage as authStorage,
  type AuthorizeIdentity,
  type AuthStorageConfig,
  type AuthStorageMode,
  type PasswordlessAuthRuntime,
} from "@dbx-tools/auth-gate";
import { config as coreConfig } from "@dbx-tools/core";
import type { AuthStatus } from "@dbx-tools/shared-auth";
import { brand, log, string } from "@dbx-tools/shared-core";
import type { RequestHandler } from "express";
import { TUNNEL_CONFIG } from "./_config.ts";
import { looksLikeEmail, matchesAllowlist } from "./allowlist.ts";
import { mountGate, type GateOptions } from "./gate.ts";
import { ensureEmailAvailable, sendCode as defaultSendCode } from "./send-code.ts";
import { KEY_TTL_SECONDS, resolveSessionCutoff, signingKey } from "./signing-key.ts";

const logger = log.logger("tunnel:auth");

interface GateServerApplication {
  get(path: string, handler: RequestHandler): unknown;
  post(path: string, handler: RequestHandler): unknown;
  use(path: string, handler: RequestHandler): unknown;
}

interface GateMountContext {
  addRoute(method: string, path: string, handler: RequestHandler): void;
  addMiddleware(path: string, handler: RequestHandler): void;
  getPlugins(): ReadonlyMap<string, unknown>;
}

function serverApplication(context: GateMountContext): GateServerApplication | undefined {
  const server = context.getPlugins().get("server") as
    { serverApplication?: Partial<GateServerApplication> } | undefined;
  const application = server?.serverApplication;
  return application &&
    typeof application.get === "function" &&
    typeof application.post === "function" &&
    typeof application.use === "function"
    ? (application as GateServerApplication)
    : undefined;
}

export function mountGateOnContext(context: GateMountContext, options: GateOptions): void {
  const application = serverApplication(context);
  if (application) {
    mountGate(
      options,
      (method, path, handler) => application[method](path, handler),
      (path, handler) => application.use(path, handler),
    );
    return;
  }
  mountGate(
    options,
    (method, path, handler) => context.addRoute(method, path, handler),
    (path, handler) => context.addMiddleware(path, handler),
  );
}

/** Options for the {@link authGate} plugin (all resolvable from env - see below). */
export interface AuthGateConfig extends BasePluginConfig, AuthStorageConfig {
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
   * autofill reads. See `codeEmailSubject` in `./code-email.ts`.
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
   * Same-origin path returned after a successful logout. Env
   * `TUNNEL_AUTH_LOGOUT_REDIRECT`. Defaults to `/`, where the AuthGate presents
   * login again.
   */
  logoutRedirectPath?: string;
  /**
   * Deliver a code to an address. Defaults to sending through the host app's
   * shared `@dbx-tools/email` transport (see `./send-code`); override to wire a
   * different delivery path.
   */
  sendCode?: (email: string, code: string, opts: SendCodeOptions) => Promise<void>;
  /**
   * Identity authorization independent of authentication. Defaults to the
   * configured allow-list and is re-evaluated for every accepted session.
   */
  authorizeIdentity?: AuthorizeIdentity;
  /**
   * The public `<subdomain>.<server>` that identifies portr traffic by its `Host`
   * header. Only requests whose `Host` matches this are gated; everything else
   * (the platform front door, other local callers) passes through. Env
   * `TUNNEL_PUBLIC_DOMAIN`. When absent, the gate is inert (nothing is tunnel
   * traffic).
   */
  publicDomain?: string;
  /** Additional public tunnel domains accepted by the gate. */
  publicDomains?: string | string[];
  /**
   * Extra `x-` request headers tunnel traffic may forward (literal / glob /
   * `/regex/`), unioned with the built-in allow-list. Env `TUNNEL_FORWARD_HEADERS`.
   */
  forwardHeaders?: string | string[];
  /**
   * Path prefixes to gate beyond the built-in `/api/` (literal prefixes, comma-
   * or space-separated as a string). For an app whose privileged surface is not
   * under `/api/` — e.g. a WebSocket at `/ws` — list those prefixes so they
   * require a session too. Env `TUNNEL_GATE_PATHS`.
   */
  gatePaths?: string | string[];
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
  /** Same-origin path returned after logout. */
  logoutRedirectPath: string;
  /** Primary public domain; `undefined` when Portr is not configured. */
  publicDomain?: string;
  /** All public tunnel domains accepted by the gate. */
  publicDomains: string[];
  /** Extra `x-` headers tunnel traffic may forward (unioned with the defaults). */
  forwardHeaders: string[];
  /** Path prefixes to gate beyond `/api/` (e.g. `/ws`). */
  gatePaths: string[];
  /** Run OPEN with no gate. */
  insecure: boolean;
  storage: AuthStorageMode;
  sqlitePath?: string;
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
  logoutRedirectPath: "/",
};

/** Merge {@link AuthGateConfig} over env over defaults into a resolved config. */
export function resolveAuthGateConfig(config: AuthGateConfig): ResolvedAuthGateConfig {
  const storage = authStorage.resolveAuthStorageConfig({
    storage:
      config.storage ??
      (coreConfig.text("AUTH_STORAGE", TUNNEL_CONFIG) as AuthStorageMode | undefined),
    sqlitePath: config.sqlitePath ?? coreConfig.text("AUTH_SQLITE_PATH", TUNNEL_CONFIG),
  });
  const publicDomain = coreConfig.string(config.publicDomain, "PUBLIC_DOMAIN", TUNNEL_CONFIG);
  const frpPublicDomain = coreConfig.text("FRP_PUBLIC_DOMAIN", TUNNEL_CONFIG);
  return {
    // Both sources are unioned rather than one overriding: a deployment-wide
    // TUNNEL_AUTH_ALLOW and a per-invocation `--allow` should both grant access.
    // Hence `parseList` on each rather than `config.list`, which stops at the
    // first source that yields anything.
    allow: [
      ...string.parseList(config.allow),
      ...string.parseList(coreConfig.text(["AUTH_ALLOW", "EMAIL_AUTH_ALLOW"], TUNNEL_CONFIG)),
    ],
    subject: coreConfig.string(config.subject, "AUTH_SUBJECT", TUNNEL_CONFIG) ?? DEFAULTS.subject,
    brandName:
      coreConfig.string(config.brandName, "AUTH_BRAND_NAME", TUNNEL_CONFIG) ?? DEFAULTS.brandName,
    message: coreConfig.string(config.message, "AUTH_MESSAGE", TUNNEL_CONFIG) ?? DEFAULTS.message,
    sessionTtlSeconds: coreConfig.positiveInt(
      config.sessionTtlSeconds,
      "AUTH_SESSION_TTL",
      DEFAULTS.sessionTtlSeconds,
      TUNNEL_CONFIG,
    ),
    codeTtlSeconds: coreConfig.positiveInt(
      config.codeTtlSeconds,
      "AUTH_CODE_TTL",
      DEFAULTS.codeTtlSeconds,
      TUNNEL_CONFIG,
    ),
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    sessionCutoffMs: resolveSessionCutoff(config.sessionCutoff),
    logoutRedirectPath: passwordlessAuth.normalizeLogoutRedirectPath(
      coreConfig.string(config.logoutRedirectPath, "AUTH_LOGOUT_REDIRECT", TUNNEL_CONFIG) ??
        DEFAULTS.logoutRedirectPath,
    ),
    publicDomain,
    publicDomains: [
      ...new Set(
        [publicDomain, frpPublicDomain, ...string.parseList(config.publicDomains)].filter(
          (value): value is string => !!value,
        ),
      ),
    ],
    forwardHeaders: [
      ...string.parseList(config.forwardHeaders),
      ...string.parseList(coreConfig.text("FORWARD_HEADERS", TUNNEL_CONFIG)),
    ],
    gatePaths: [
      ...string.parseList(config.gatePaths),
      ...string.parseList(coreConfig.text("GATE_PATHS", TUNNEL_CONFIG)),
    ],
    insecure: coreConfig.boolean(config.insecure, "INSECURE", TUNNEL_CONFIG) ?? false,
    storage: storage.mode,
    sqlitePath: storage.sqlitePath,
  };
}

/** The handlers the gate middleware calls in-process (returned by {@link AuthGatePlugin.exports}). */
export interface AuthGateApi {
  /** Better Auth and compatibility routes under `/api/email/auth/*`. */
  handler(request: Request): Promise<Response>;
  /** Resolve the authorized email for request headers, or undefined. */
  session(headers: Headers): Promise<string | undefined>;
  /** The gate status payload. */
  status(headers: Headers): Promise<AuthStatus>;
  /** Whether the runtime exposes passkey enrollment and authentication. */
  readonly passkeysEnabled: boolean;
  /** Close auth storage owned by this runtime. */
  close(): Promise<void>;
}

/**
 * AppKit plugin adapting `@dbx-tools/auth-gate` to tunnel traffic. On `setup()` it registers the login
 * routes (`/api/email/auth/*`) and a gating middleware on the app's OWN Express
 * server via `this.context`, so a public portr caller must prove an email before
 * reaching the app's `/api/*` - see `./gate`. Front-door (platform) traffic and
 * other local callers pass through untouched (the gate keys on the `Host` header).
 */
export class AuthGatePlugin extends Plugin<AuthGateConfig> {
  static manifest = {
    name: "authGate",
    displayName: "Auth Gate",
    description: "Better Auth email OTP and passkey access gate for a public tunnel.",
    stability: "beta",
    resources: {
      required: [],
      optional: [
        {
          type: ResourceType.POSTGRES,
          alias: "auth",
          resourceKey: "auth-database",
          description: "Durable users, sessions, OTP records, and passkeys.",
          permission: "CAN_CONNECT_AND_CREATE",
          fields: {
            instance_name: { env: "LAKEBASE_INSTANCE_NAME" },
            database_name: { env: "PGDATABASE" },
          },
        },
      ],
    },
  } satisfies PluginManifest<"authGate">;

  private resolved!: ResolvedAuthGateConfig;
  private readonly runtimes = new Map<string, PasswordlessAuthRuntime>();

  static getResourceRequirements(config: AuthGateConfig): ResourceRequirement[] {
    if (authStorage.resolveAuthStorageConfig(config).mode !== "lakebase") return [];
    return [
      {
        type: ResourceType.POSTGRES,
        alias: "auth",
        resourceKey: "auth-database",
        description: "Durable users, sessions, OTP records, and passkeys.",
        permission: "CAN_CONNECT_AND_CREATE",
        fields: {
          instance_name: { env: "LAKEBASE_INSTANCE_NAME" },
          database_name: { env: "PGDATABASE" },
        },
        required: true,
      },
    ];
  }

  override async setup(): Promise<void> {
    this.resolved = resolveAuthGateConfig(this.config);
    if (!this.config.brandName && !coreConfig.text("AUTH_BRAND_NAME", TUNNEL_CONFIG)) {
      this.resolved.brandName = appkitBrand.getBrandContext().name;
    }

    if (this.resolved.insecure) {
      logger.warn("insecure mode - the tunnel runs OPEN with no auth gate");
    } else {
      const lakebasePlugin = appkitPlugin.instance(this.context, lakebase);
      const { key } = await signingKey(this.resolved.sessionCutoffMs);
      const origins = this.resolved.publicDomains.length
        ? this.resolved.publicDomains.map(authOrigin)
        : [authOrigin(this.resolved.publicDomain)];
      for (const origin of new Set(origins)) {
        const storage = await authStorage.createAuthStorage(
          this.resolved,
          lakebasePlugin?.exports().pool,
        );
        this.runtimes.set(
          new URL(origin).host.toLowerCase(),
          await passwordlessAuth.createPasswordlessAuth({
            storage,
            baseURL: origin,
            basePath: "/api/email/auth",
            appName: this.resolved.brandName,
            secret: Buffer.from(key).toString("base64url"),
            sessionTtlSeconds: this.resolved.sessionTtlSeconds,
            sessionCutoffMs: this.resolved.sessionCutoffMs,
            logoutRedirectPath: this.resolved.logoutRedirectPath,
            codeTtlSeconds: this.resolved.codeTtlSeconds,
            maxAttempts: this.resolved.maxAttempts,
            authorizeIdentity: (email) => this.authorizeIdentity(email),
            sendCode: (email, code, options) => this.sendCode(email, code, options),
            subject: this.resolved.subject,
            message: this.resolved.message,
          }),
        );
      }
      // `server()` is deferred, so it does not exist during this plugin's setup.
      // At `setup:complete` the Express app exists but has not injected plugin
      // routes or static handling yet, which is the one point the gate can mount
      // ahead of every protected route.
      this.context?.onLifecycle("setup:complete", async () => {
        this.mountGateRoutes();
        // Fail fast once the sibling email plugin has primed its transport: a
        // gate that cannot email a code lets nobody in.
        if (!this.config.sendCode) await ensureEmailAvailable();
      });
    }

    logger.info("ready", {
      patterns: this.resolved.allow.length,
      sessionTtlSeconds: this.resolved.sessionTtlSeconds,
      publicDomains: this.resolved.publicDomains,
      insecure: this.resolved.insecure,
      storage: this.resolved.storage,
      logoutRedirectPath: this.resolved.logoutRedirectPath,
      sessionCutoff:
        this.resolved.sessionCutoffMs > 0
          ? new Date(this.resolved.sessionCutoffMs).toISOString()
          : null,
    });
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.close()));
    this.runtimes.clear();
  }

  /**
   * Register the login routes (`/api/email/auth/*`) and the gating middleware on
   * the app's OWN Express server. At `setup:complete`, the deferred server plugin
   * has constructed its Express app but has not injected plugin routes or static
   * handling, so direct registration puts the gate first. The context's buffered
   * route API remains a fallback for compatible non-standard server plugins.
   */
  private mountGateRoutes(): void {
    const context = this.context;
    if (!context) {
      logger.warn("no plugin context - the auth gate cannot mount its routes");
      return;
    }
    mountGateOnContext(context, {
      gate: this.exports(),
      publicDomain: this.resolved.publicDomains,
      forwardHeaders: this.resolved.forwardHeaders,
      gatePaths: this.resolved.gatePaths,
      brandName: this.resolved.brandName,
    });
  }

  /** The code sender: the configured `sendCode`, else the shared-transport default. */
  private get sendCode(): NonNullable<AuthGateConfig["sendCode"]> {
    return this.config.sendCode ?? defaultSendCode;
  }

  private authorizeIdentity(email: string): boolean | Promise<boolean> {
    if (this.config.authorizeIdentity) return this.config.authorizeIdentity(email);
    return looksLikeEmail(email) && matchesAllowlist(email, this.resolved.allow);
  }

  override exports(): AuthGateApi {
    const runtime = (headers?: Headers, request?: Request) => {
      const host = (
        headers?.get("host") ?? (request ? new URL(request.url).host : "")
      ).toLowerCase();
      return this.runtimes.get(host) ?? this.runtimes.values().next().value;
    };
    return {
      passkeysEnabled: [...this.runtimes.values()].some((entry) => entry.passkeysEnabled),
      handler: (request) =>
        runtime(request.headers, request)?.handler(request) ??
        Promise.resolve(new Response("Not Found", { status: 404 })),
      session: (headers) => runtime(headers)?.session(headers) ?? Promise.resolve(undefined),
      status: (headers) =>
        runtime(headers)?.status(headers) ??
        Promise.resolve({ authenticated: false, enabled: false, passkeysEnabled: false }),
      close: () => this.shutdown(),
    };
  }
}

function authOrigin(publicDomain?: string): string {
  const value = string.trimToNull(publicDomain);
  if (!value) return "http://localhost";
  if (/^https?:\/\//i.test(value)) return new URL(value).origin;
  const host = value.split("/")[0]!;
  const local = host === "localhost" || host.startsWith("localhost:");
  return `${local ? "http" : "https"}://${host}`;
}

/** Factory: `authGate({ allow, subject, ... })` for an AppKit `plugins` array. */
export const authGate = toPlugin(AuthGatePlugin);
