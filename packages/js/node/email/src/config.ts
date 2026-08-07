/**
 * SMTP configuration for the email plugin: the typed
 * {@link EmailPluginConfig} (the plugin's slice of AppKit config), the
 * JSON Schema the manifest publishes for it, and {@link resolveEmailConfig}
 * which layers that config over environment defaults into the concrete
 * {@link ResolvedEmailConfig} the runtime needs.
 *
 * Two modes fall out of the resolution. When SMTP credentials (host +
 * user + password) are all present it resolves to `mode: "smtp"` and
 * mail is sent for real. When they are absent and `EMAIL_OUTBOX_MODE`
 * is explicitly enabled it resolves to `mode: "file"` (an "outbox")
 * and each message is written to disk as HTML instead of sent. Any
 * partial SMTP configuration or a send attempt with no credentials and
 * no outbox opt-in throws.
 *
 * Precedence per field: explicit plugin config wins, then the matching
 * environment variable. Env names are unprefixed because the app talks
 * to a single SMTP server (e.g. SMTP2GO): `SMTP_HOST`, `SMTP_PORT`,
 * `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, plus `EMAIL_DOMAIN` for
 * the derived sender's domain, `EMAIL_FROM` for an explicit override,
 * `EMAIL_SYSTEM_FROM` for the do-not-reply address system mail sends from,
 * `EMAIL_SENDER_POLICY` for the sender restriction mode, and
 * `EMAIL_OUTBOX_DIR` for the outbox directory.
 *
 * @module
 */
import { resolve } from "node:path";
import { ConfigurationError, ValidationError, type BasePluginConfig } from "@databricks/appkit";
import { config as coreConfig } from "@dbx-tools/core";
import { object } from "@dbx-tools/shared-core";
import type { JSONSchema7 } from "json-schema";
import { defaultEmailBrand, type EmailBrand } from "./brand.ts";
import { isSenderAllowed, parseAllowedSenders, systemSenderAddress } from "./sender.ts";

/** SMTP submission port used when none is configured. */
export const DEFAULT_SMTP_PORT = 587;

/** SMTP port that implies a TLS-on-connect socket rather than STARTTLS. */
export const IMPLICIT_TLS_SMTP_PORT = 465;

/**
 * How the sender (`From`) address is restricted.
 *
 * `"allowlist"` is the default and the deny-by-default posture: a send is
 * permitted only from an address the configuration names, either through
 * {@link EmailPluginConfig.allowedSenders} or, when that is empty, through
 * the configured sender source ({@link EmailPluginConfig.from} as an exact
 * address, {@link EmailPluginConfig.domain} as a `*@domain` wildcard).
 *
 * `"unrestricted"` is the explicit opt-out: any `From` a caller supplies is
 * accepted. Only reach for it when an upstream system already vets the
 * sender.
 */
export type SenderPolicy = "allowlist" | "unrestricted";

/** SMTP connection + credentials. All fields fall back to env when unset. */
export interface SmtpConfig {
  /** SMTP server hostname (`SMTP_HOST`). */
  host?: string;
  /** SMTP server port (`SMTP_PORT`). Defaults to {@link DEFAULT_SMTP_PORT}. */
  port?: number;
  /**
   * Use a TLS-on-connect socket (`SMTP_SECURE`). Defaults to
   * `port === ` {@link IMPLICIT_TLS_SMTP_PORT}.
   */
  secure?: boolean;
  /** SMTP auth username (`SMTP_USER`). */
  user?: string;
  /** SMTP auth password / API key (`SMTP_PASSWORD`). */
  password?: string;
}

/** AppKit config accepted by the email plugin. */
export interface EmailPluginConfig extends BasePluginConfig {
  /** SMTP connection + credentials. Omit to run in file/outbox mode. */
  smtp?: SmtpConfig;
  /**
   * Domain used to build the sender address from the on-behalf-of user
   * (`<local-part>@<domain>`). Falls back to `EMAIL_DOMAIN`. Required in
   * SMTP mode unless {@link from} is set; optional in file mode (the
   * outbox falls back to the user's own email address).
   */
  domain?: string;
  /**
   * Explicit `From` address, OPTIONAL. When set, the sender is used verbatim
   * and the per-user derivation is skipped. Falls back to `EMAIL_FROM`.
   *
   * Leave it unset in most deployments: {@link domain} alone is enough, and
   * mail then comes from the address of the person who caused it, which is what
   * a recipient expects to be able to reply to.
   */
  from?: string;
  /**
   * `From` for SYSTEM mail - a send with no on-behalf-of user, such as a
   * sign-in code or a password reset. Falls back to `EMAIL_SYSTEM_FROM`, then
   * to `no-reply@<domain>`, then to {@link from}.
   *
   * Machine mail gets a do-not-reply address by default because a reply to it
   * reaches nobody. Set this to route those replies somewhere real (a monitored
   * `support@`) or to spell the local part differently (`donotreply@`).
   */
  systemFrom?: string;
  /**
   * Directory for the file/outbox fallback. Falls back to
   * `EMAIL_OUTBOX_DIR`, then `<cwd>/tmp`. Only used when SMTP
   * credentials are absent.
   */
  outDir?: string;
  /**
   * Allow-list restricting the sender (`From`) address. Each entry is an
   * exact address (`user@domain.com`), a domain wildcard (`*@domain.com`
   * or the bare `domain.com`, matching any local part on that domain), or
   * `*` (any). A resolved / chosen sender that matches no entry is
   * rejected at send time. Accepts a `string[]` or a single comma- /
   * whitespace-separated string; falls back to `EMAIL_ALLOWED_SENDERS`.
   * When empty, the {@link senderPolicy} decides what is permitted.
   */
  allowedSenders?: string | string[];
  /**
   * How the sender address is restricted when {@link allowedSenders} is
   * empty (`EMAIL_SENDER_POLICY`). Defaults to `"allowlist"`, which
   * narrows sends to the configured sender source. See
   * {@link SenderPolicy}.
   */
  senderPolicy?: SenderPolicy;
  /**
   * Optional brand styling applied to every rendered message. Omit to use the
   * repository's dbx-tools brand. Pass {@link emailBrandFromContext} to derive
   * a custom value from a shared `BrandContext`.
   */
  brand?: EmailBrand;
}

/** Config shared by both resolved modes. */
export interface ResolvedSender {
  /** Sender domain; present whenever {@link from} is absent. */
  domain?: string;
  /** Explicit sender override; present skips per-user derivation. */
  from?: string;
  /**
   * Explicit do-not-reply sender for system mail. Absent means it is derived -
   * see {@link systemSenderAddress}.
   */
  systemFrom?: string;
  /**
   * Effective sender allow-list: the configured patterns when any were
   * given, else the patterns implied by the sender source under an
   * `"allowlist"` policy. Empty means unenforceable (an `"unrestricted"`
   * policy, or an outbox with no sender source to narrow to).
   */
  allowedSenders: string[];
  /** The restriction mode the allow-list was resolved under. */
  senderPolicy: SenderPolicy;
  /** Brand styling applied to rendered HTML. */
  brand: EmailBrand;
}

/** Resolved config for real SMTP delivery. */
export interface ResolvedSmtpConfig extends ResolvedSender {
  mode: "smtp";
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

/** Resolved config for the file/outbox fallback (no SMTP credentials). */
export interface ResolvedFileConfig extends ResolvedSender {
  mode: "file";
  /** Absolute directory messages are written under. */
  outDir: string;
}

/** Concrete, validated config the runtime dispatches through. */
export type ResolvedEmailConfig = ResolvedSmtpConfig | ResolvedFileConfig;

/** JSON Schema published on the manifest's `config.schema`. */
export const EMAIL_CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    smtp: {
      type: "object",
      description: "SMTP connection and credentials (env fallbacks: SMTP_*).",
      properties: {
        host: { type: "string", description: "SMTP server hostname (SMTP_HOST)." },
        port: {
          type: "number",
          description: `SMTP server port (SMTP_PORT). Defaults to ${DEFAULT_SMTP_PORT}.`,
        },
        secure: {
          type: "boolean",
          description: `TLS-on-connect socket (SMTP_SECURE). Defaults to port === ${IMPLICIT_TLS_SMTP_PORT}.`,
        },
        user: { type: "string", description: "SMTP auth username (SMTP_USER)." },
        password: {
          type: "string",
          description: "SMTP auth password / API key (SMTP_PASSWORD).",
        },
      },
    },
    domain: {
      type: "string",
      description:
        "Domain for the derived sender address (<user-local-part>@<domain>). Falls back to EMAIL_DOMAIN.",
    },
    from: {
      type: "string",
      description:
        "Optional explicit From address; skips per-user derivation. Falls back to EMAIL_FROM.",
    },
    systemFrom: {
      type: "string",
      description:
        "From for system mail (no on-behalf-of user, e.g. a sign-in code). Falls back to EMAIL_SYSTEM_FROM, then no-reply@<domain>, then from.",
    },
    outDir: {
      type: "string",
      description:
        "Directory for the file/outbox fallback when SMTP is unconfigured. Falls back to EMAIL_OUTBOX_DIR, then <cwd>/tmp.",
    },
    allowedSenders: {
      type: "array",
      items: { type: "string" },
      description:
        'Allow-list of permitted sender (From) patterns: exact addresses ("user@domain.com"), domain wildcards ("*@domain.com"), or "*". Also accepts a comma/space-separated string. Falls back to EMAIL_ALLOWED_SENDERS. When empty, senderPolicy decides.',
    },
    senderPolicy: {
      type: "string",
      enum: ["allowlist", "unrestricted"],
      description:
        'How the sender is restricted when allowedSenders is empty (EMAIL_SENDER_POLICY). "allowlist" (default) narrows sends to the configured sender source; "unrestricted" accepts any From.',
    },
    brand: {
      type: "object",
      description:
        "Brand styling applied to every React Email message. Omit to use the dbx-tools brand.",
      properties: {
        accent: {
          type: "string",
          description: 'Header-band background and body link color (e.g. "#FF3621").',
        },
        onAccent: {
          type: "string",
          description: "Text and logo color rendered on the accent band. Defaults to white.",
        },
        fontFamily: {
          type: "string",
          description: 'Body font stack (e.g. "Inter, ui-sans-serif, system-ui, sans-serif").',
        },
        name: {
          type: "string",
          description: "Product / display name used as the header text and the logo alt text.",
        },
        logoUrl: {
          type: "string",
          description:
            "Logo image for the header band. Only an http(s): or data: URL renders; other values are dropped because a mail client cannot load them.",
        },
        background: { type: "string", description: "Inbox canvas color." },
        surface: { type: "string", description: "Message-card color." },
        foreground: { type: "string", description: "Primary text color." },
        muted: { type: "string", description: "Secondary text color." },
        border: { type: "string", description: "Border and divider color." },
        tagline: { type: "string", description: "Footer product line." },
        website: { type: "string", description: "Optional footer website URL." },
      },
      required: ["accent", "fontFamily"],
    },
  },
};

/** Parse the `SMTP_SECURE` env / config flag, defaulting by port. */
function resolveSecure(flag: boolean | undefined, port: number): boolean {
  return (
    coreConfig.boolean(flag, "SMTP_SECURE", coreConfig.ENV_ONLY) ?? port === IMPLICIT_TLS_SMTP_PORT
  );
}

/** Parse the `EMAIL_SENDER_POLICY` env / config value, defaulting to deny-by-default. */
function resolveSenderPolicy(policy: SenderPolicy | undefined): SenderPolicy {
  const raw = policy ?? coreConfig.text("EMAIL_SENDER_POLICY", coreConfig.ENV_ONLY)?.toLowerCase();
  if (raw === "unrestricted") return "unrestricted";
  if (raw === undefined || raw === "" || raw === "allowlist") return "allowlist";
  throw ValidationError.invalidValue("senderPolicy", raw, '"allowlist" or "unrestricted"');
}

/**
 * Effective allow-list for an `"allowlist"` policy with no explicit patterns:
 * the sender source itself, so a configured domain or fixed address is the
 * boundary rather than "anything goes". Yields nothing when neither is set,
 * which only happens in outbox mode (where the sender falls back to the
 * on-behalf-of user's own address and cannot be enumerated up front).
 */
function impliedSenderPatterns(sender: {
  domain?: string;
  from?: string;
  systemFrom?: string;
}): string[] {
  const patterns: string[] = [];
  if (sender.from) patterns.push(sender.from.trim().toLowerCase());
  if (sender.domain) patterns.push(`*@${sender.domain.trim().toLowerCase()}`);
  // The system sender too, when the patterns above do not already cover it: it
  // is an address this app SENDS from, so a list derived from the sender source
  // has to permit it, or the very policy meant to describe the app's own senders
  // denies its sign-in mail. Usually redundant (`*@domain` already matches
  // `no-reply@domain`) - it matters for a `systemFrom` on another domain.
  const system = systemSenderAddress(sender)?.toLowerCase();
  if (system && !isSenderAllowed(system, patterns)) patterns.push(system);
  return patterns;
}

/** Whether `EMAIL_OUTBOX_MODE` explicitly opts into the file/outbox fallback. */
function isOutboxModeEnabled(): boolean {
  return coreConfig.boolean(undefined, "EMAIL_OUTBOX_MODE", coreConfig.ENV_ONLY) ?? false;
}

const SMTP_REQUIRED_FIELDS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"] as const;

/** List env keys for SMTP fields that are unset in the resolved credential set. */
function missingSmtpFields(
  host: string | undefined,
  user: string | undefined,
  pass: string | undefined,
): string[] {
  const values = [host, user, pass] as const;
  return SMTP_REQUIRED_FIELDS.filter((_, index) => !values[index]);
}

/**
 * Resolve plugin config over environment defaults.
 *
 * When SMTP host + user + password are all present, returns `mode:
 * "smtp"` for real delivery (and throws if no sender source - domain,
 * from, or systemFrom - is configured, since SMTP can't derive one from
 * nothing; `domain` alone is the intended minimum).
 * When all three are absent and `EMAIL_OUTBOX_MODE` is enabled, returns
 * `mode: "file"` so the runtime writes messages to the outbox directory
 * for local testing; in that mode a sender source is optional (the
 * outbox falls back to the OBO user's own address). Partial SMTP
 * configuration or a send with no credentials and no outbox opt-in
 * throws.
 *
 * The sender allow-list is resolved here too: under the default
 * `"allowlist"` policy an empty list is filled in from the sender source,
 * so a deployment that only sets `EMAIL_DOMAIN` still rejects a `From` on
 * any other domain. See {@link SenderPolicy}.
 */
export function resolveEmailConfig(config: EmailPluginConfig = {}): ResolvedEmailConfig {
  const smtp = config.smtp ?? {};
  const host = coreConfig.string(smtp.host, "SMTP_HOST", coreConfig.ENV_ONLY);
  const user = coreConfig.string(smtp.user, "SMTP_USER", coreConfig.ENV_ONLY);
  const pass = coreConfig.string(smtp.password, "SMTP_PASSWORD", coreConfig.ENV_ONLY);
  const domain = coreConfig.string(config.domain, "EMAIL_DOMAIN", coreConfig.ENV_ONLY);
  const from = coreConfig.string(config.from, "EMAIL_FROM", coreConfig.ENV_ONLY);
  const systemFrom = coreConfig.string(config.systemFrom, "EMAIL_SYSTEM_FROM", coreConfig.ENV_ONLY);
  const senderPolicy = resolveSenderPolicy(config.senderPolicy);
  const configuredSenders = parseAllowedSenders(
    config.allowedSenders ?? coreConfig.text("EMAIL_ALLOWED_SENDERS", coreConfig.ENV_ONLY),
  );
  const allowedSenders =
    configuredSenders.length > 0 || senderPolicy === "unrestricted"
      ? configuredSenders
      : impliedSenderPatterns({ domain, from, systemFrom });
  const sender: ResolvedSender = {
    ...object.optional("domain", domain),
    ...object.optional("from", from),
    ...object.optional("systemFrom", systemFrom),
    allowedSenders,
    senderPolicy,
    brand: config.brand ?? defaultEmailBrand,
  };

  const hasAllSmtp = Boolean(host && user && pass);
  const hasAnySmtp = Boolean(host || user || pass);

  if (hasAnySmtp && !hasAllSmtp) {
    throw ValidationError.missingEnvVars(missingSmtpFields(host, user, pass));
  }

  if (hasAllSmtp) {
    if (!domain && !from && !systemFrom) {
      throw ConfigurationError.resourceNotFound(
        "Email sender source",
        "Set EMAIL_DOMAIN to derive <user-local-part>@<domain> (and no-reply@<domain> for system mail), or EMAIL_FROM for a fixed address.",
      );
    }
    const port = coreConfig.port(smtp.port, "SMTP_PORT", DEFAULT_SMTP_PORT, coreConfig.ENV_ONLY);
    return {
      mode: "smtp",
      host: host!,
      port,
      secure: resolveSecure(smtp.secure, port),
      auth: { user: user!, pass: pass! },
      ...sender,
    };
  }

  if (!isOutboxModeEnabled()) {
    throw ConfigurationError.invalidConnection(
      "SMTP",
      `Set ${SMTP_REQUIRED_FIELDS.join(", ")}, or EMAIL_OUTBOX_MODE=1 to write messages to a local outbox instead.`,
    );
  }

  const outDir = resolve(
    coreConfig.string(config.outDir, "EMAIL_OUTBOX_DIR", coreConfig.ENV_ONLY) ??
      resolve(process.cwd(), "tmp"),
  );
  return { mode: "file", outDir, ...sender };
}
