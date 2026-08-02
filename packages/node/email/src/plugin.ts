/**
 * AppKit plugin (registered name: `email`) that owns the SMTP runtime
 * for outbound mail. Registering it validates the SMTP configuration
 * and verifies connectivity at startup, so a bad host / credential
 * surfaces in the boot logs instead of on the first approved send, and
 * installs this plugin's `execute()` as the runtime's executor so every
 * send picks up AppKit's retry / timeout / telemetry chain.
 *
 * The plugin is also a `ToolProvider`, so an AppKit agent can reach an
 * `email.send` tool directly; the {@link emailTool} export is the same
 * capability for a Mastra agent. Both share the transport primed here,
 * and {@link sendEmail} is available to non-agent callers.
 *
 * Configuration is the manifest-published {@link EmailPluginConfig}
 * (SMTP host/port/credentials, sender domain or explicit `from`, the
 * sender policy, and an optional `allowedSenders` restriction), with
 * unprefixed `SMTP_*` / `EMAIL_*` environment fallbacks.
 *
 * The plugin mounts one route under its base path (`/api/email`):
 * `GET /senders` returns the permitted `From` options for the calling
 * user, so a compose UI can offer them in a dropdown.
 *
 * @module
 */

import {
  AuthenticationError,
  ConfigurationError,
  ConnectionError,
  ExecutionError,
  getExecutionContext,
  Plugin,
  toPlugin,
  ValidationError,
  type AppKitError,
  type ExecutionResult,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import {
  defineTool,
  executeFromRegistry,
  toolsFromRegistry,
  type AgentToolDefinition,
  type ToolProvider,
  type ToolRegistry,
} from "@databricks/appkit/beta";
import { log, string, token } from "@dbx-tools/shared-core";
import {
  email as emailWire,
  type EmailMessage,
  type EmailResult,
  type EmailSenders,
} from "@dbx-tools/shared-email";
import { EMAIL_CONFIG_SCHEMA, type EmailPluginConfig } from "./config.ts";
import { EMAIL_SENDERS_SETTINGS, EMAIL_VERIFY_SETTINGS } from "./defaults.ts";
import { isSenderAllowed, listSenderOptions, resolveSenderAddress } from "./sender.ts";
import { SEND_EMAIL_DESCRIPTION } from "./tool.ts";
import {
  getEmailRuntime,
  resetEmailRuntime,
  sendEmail,
  type SendEmailOptions,
  setEmailExecutor,
  verifyEmailTransport,
} from "./transport.ts";

/** Mount-relative route (under `/api/email`) for the sender-options lookup. */
const SENDERS_ROUTE = "/senders";

/** Registry key of the agent tool, which agents address as `email.send`. */
const SEND_TOOL = "send";

const logger = log.logger("email");

/**
 * AppKit plugin that configures and verifies the SMTP transport used by
 * the `send_email` tool, and exposes sending as an AppKit agent tool.
 *
 * @example
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 * import { plugin as emailPlugin } from "@dbx-tools/email";
 *
 * await createApp({
 *   plugins: [
 *     server(),
 *     emailPlugin.email({
 *       smtp: { host: "smtp.example.com", user: "apikey", password: process.env.SMTP_KEY },
 *       domain: "mail.example.com",
 *     }),
 *   ],
 * });
 * ```
 */
export class EmailPlugin extends Plugin<EmailPluginConfig> implements ToolProvider {
  static manifest = {
    name: "email",
    displayName: "Email",
    description:
      "Sends approval-gated email over SMTP, with the sender derived from " +
      "the on-behalf-of user's address on a configured domain.",
    stability: "beta",
    resources: {
      required: [],
      optional: [],
    },
    config: { schema: EMAIL_CONFIG_SCHEMA },
  } satisfies PluginManifest<"email">;

  /**
   * The tool this plugin offers to an AppKit agent.
   *
   * Not `autoInheritable`: a send is irreversible and leaves the workspace,
   * so it must only appear in an agent that asked for it and accepted the
   * sender policy that comes with it.
   *
   * `execute` re-parses its arguments with the local schema: AppKit validates
   * against the same schema first, but re-parsing is what gives the body typed
   * arguments instead of `unknown`.
   */
  private readonly tools: ToolRegistry = {
    [SEND_TOOL]: defineTool({
      description: SEND_EMAIL_DESCRIPTION,
      schema: emailWire.emailMessageSchema,
      annotations: { effect: "write", requiresUserContext: true },
      autoInheritable: false,
      execute: async (args, signal) =>
        this.send(emailWire.emailMessageSchema.parse(args), undefined, signal),
    }),
  };

  /**
   * Prime the shared runtime from this plugin's config (over env), route the
   * tools' sends through this plugin's interceptor chain, and log the
   * effective sender policy so an active restriction is obvious at boot. In
   * SMTP mode, fail setup when the transport cannot be verified: a bad host
   * or credential is a deploy-time mistake and should stop the app rather
   * than wait for a user to approve a send that cannot work. With no SMTP
   * credentials the runtime is in file/outbox mode (only when
   * `EMAIL_OUTBOX_MODE` is set), logged loudly here so it is obvious mail
   * is being written to disk rather than sent.
   */
  override async setup(): Promise<void> {
    const { transporter, config } = getEmailRuntime(this.config);
    setEmailExecutor((fn, settings) => this.execute(fn, settings));
    const policy = {
      mode: config.mode,
      senderPolicy: config.senderPolicy,
      restricted: config.allowedSenders.length > 0,
      ...(config.allowedSenders.length > 0 ? { allowedSenders: config.allowedSenders } : {}),
    };
    if (config.mode === "file") {
      logger.warn("outbox:enabled", {
        dir: config.outDir,
        reason: "no SMTP credentials configured; emails are written to disk instead of sent",
      });
      logger.info("ready", policy);
      return;
    }
    const verified = await this.execute(
      async (signal) => verifyEmailTransport(transporter, signal),
      EMAIL_VERIFY_SETTINGS,
    );
    if (!verified.ok) {
      logger.error("smtp:unverified", {
        host: config.host,
        port: config.port,
        status: verified.status,
        error: verified.message,
      });
      throw ConfigurationError.invalidConnection(
        "SMTP",
        `Could not verify ${config.host}:${config.port}. Check SMTP_HOST, SMTP_PORT, SMTP_SECURE, and the credentials, or set EMAIL_OUTBOX_MODE=1 for local outbox testing.`,
      );
    }
    logger.info("ready", {
      ...policy,
      host: config.host,
      port: config.port,
      secure: config.secure,
    });
  }

  /** Close the SMTP connection pool. Idempotent. */
  async shutdown(): Promise<void> {
    resetEmailRuntime();
  }

  /**
   * Abort in-flight work. AppKit's graceful shutdown only invokes this hook -
   * it never calls {@link shutdown} - so the SMTP pool is closed from here or
   * it leaks at SIGTERM. The teardown is synchronous and idempotent, so the
   * un-awaited call costs nothing.
   */
  override abortActiveOperations(): void {
    super.abortActiveOperations();
    void this.shutdown();
  }

  /**
   * Expose the sender-options lookup so UI compose views can populate a
   * `From` dropdown from the configured allow-list. Mounted under the
   * plugin base path, i.e. `GET /api/email/senders`. Runs in the OBO
   * user scope so domain wildcards resolve against the caller's own
   * local part.
   *
   * OBO is used only WHEN the request can support it. `asUser(req)` throws
   * `AuthenticationError` outside `NODE_ENV=development` if the request carries
   * no forwarded OBO token, and AppKit does not catch a rejection raised inside
   * a handler - so unconditionally wrapping this route takes the process down
   * for a caller that authenticated some other way (a `@dbx-tools/cli-tunnel`
   * OTP session, a health probe, a local `curl`). The user context is only ever
   * an ENRICHMENT here: without it, wildcard senders simply expand against no
   * local part. Degrading to the service context therefore answers correctly
   * instead of failing, and a front-door request is unchanged.
   *
   * This is the same rule `@dbx-tools/appkit`'s `identity` module applies in
   * `"auto"` mode; the header check is inlined rather than taking a dependency
   * on that package for one predicate.
   */
  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "listSenders",
      method: "get",
      path: SENDERS_ROUTE,
      handler: async (req, res) => {
        const oboToken = string.trimToNull(req.header(token.ACCESS_TOKEN_HEADER));
        const scoped = oboToken === null ? this : this.asUser(req);
        const result = await scoped.executeListSenders();
        if (!result.ok) {
          res.status(result.status).json({ error: result.message });
          return;
        }
        res.json(result.data);
      },
    });
  }

  override exports() {
    return {
      /**
       * Send a message immediately from `from` through the shared
       * transport, bypassing the approval flow. For agent-driven sends
       * use {@link emailTool} instead.
       */
      sendEmail: (
        message: EmailMessage,
        from: string,
        signal?: AbortSignal,
        options?: SendEmailOptions,
      ): Promise<EmailResult> => this.send(message, from, signal, options),
      /**
       * Sender options for the current user (the `GET /senders` payload).
       * AppKit wraps this with `asUser(req)` for OBO scoping.
       */
      listSenders: async (): Promise<EmailSenders> => unwrap(await this.executeListSenders()),
    };
  }

  /** AppKit `ToolProvider`: the tool definitions offered to an agent. */
  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  /**
   * AppKit `ToolProvider`: run one tool call. Arguments are validated against
   * the tool's schema first, and a validation failure comes back as an
   * LLM-friendly string so the model can correct itself on the next turn.
   */
  async executeAgentTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  /**
   * Send one message, resolving the sender for the caller in scope when
   * `from` is not pinned. The interceptor chain is applied inside
   * {@link sendEmail} through the executor installed at setup, so this must
   * not wrap it again.
   */
  private async send(
    message: EmailMessage,
    from: string | undefined,
    signal?: AbortSignal,
    options?: SendEmailOptions,
  ): Promise<EmailResult> {
    return sendEmail(message, from ?? this.resolveSender(), signal, options);
  }

  /** Run the sender-options lookup through the plugin's interceptor chain. */
  private async executeListSenders(): Promise<ExecutionResult<EmailSenders>> {
    return this.execute(async () => this.listSenders(), EMAIL_SENDERS_SETTINGS);
  }

  /**
   * Compute the `From` options offered to the current user: the concrete
   * addresses the effective allow-list permits (domain wildcards expanded
   * against the OBO user's local part), the default among them, and
   * whether the list is an enforced restriction. See
   * {@link listSenderOptions}.
   */
  private async listSenders(): Promise<EmailSenders> {
    const { config } = getEmailRuntime();
    const senders = listSenderOptions(config, currentUserEmail());
    // Prefer the address a send would actually default to; fall back to
    // the first offered option when that can't be resolved / permitted.
    let defaultSender = senders[0];
    try {
      const resolved = this.resolveSender().toLowerCase();
      if (isSenderAllowed(resolved, config.allowedSenders)) defaultSender = resolved;
    } catch {
      // Keep the first offered option (or none) as the default.
    }
    return {
      senders,
      ...(defaultSender ? { defaultSender } : {}),
      restricted: config.allowedSenders.length > 0,
    };
  }

  /** The `From` a send defaults to for the caller in scope. */
  private resolveSender(): string {
    return resolveSenderAddress(getEmailRuntime().config, currentUserEmail());
  }
}

/** The OBO user's address, or undefined outside a user context. */
function currentUserEmail(): string | undefined {
  const ctx = getExecutionContext();
  return "isUserContext" in ctx ? ctx.userEmail : undefined;
}

/**
 * Re-raise a failed execution as the AppKit error class that already carries
 * the status AppKit resolved, so a programmatic caller sees the same 400 /
 * 401 / 503 an HTTP caller would.
 */
function toAppKitError(status: number, message: string): AppKitError {
  if (status === 400) return new ValidationError(message);
  if (status === 401) return new AuthenticationError(message);
  if (status === 503) return new ConnectionError(message);
  return new ExecutionError(message);
}

/**
 * Surface a failed {@link ExecutionResult} to a programmatic caller as a
 * throw. HTTP handlers map `status` onto the response instead.
 */
function unwrap<T>(result: ExecutionResult<T>): T {
  if (result.ok) return result.data;
  throw toAppKitError(result.status, result.message);
}

/**
 * Register the email plugin.
 *
 * @example
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 * import { brand, plugin as emailPlugin } from "@dbx-tools/email";
 *
 * await createApp({
 *   plugins: [
 *     server(),
 *     emailPlugin.email({
 *       domain: "mail.example.com",
 *       allowedSenders: ["*@mail.example.com"],
 *       brand: brand.defaultEmailBrand,
 *     }),
 *   ],
 * });
 * ```
 */
export const email = toPlugin(EmailPlugin);
