/**
 * AppKit plugin (registered name: `teams`) that owns the Teams Adaptive Card
 * runtime - the resolved card version and the optional incoming-webhook URL the
 * {@link teamsCardTool} and the AppKit `teams.createCard` tool read. Registering
 * it resolves and logs the effective config (which card version is in force,
 * whether a webhook is wired up) so a misconfiguration is visible in the boot
 * logs rather than on the first card, and installs the plugin's `execute()` as
 * the runtime's executor so every build / post picks up AppKit's cache / retry /
 * timeout / telemetry chain.
 *
 * The plugin is also a `ToolProvider`, so an AppKit agent can reach a
 * `teams.createCard` tool directly; the {@link teamsCardTool} export is the same
 * capability for a Mastra agent. Both share the runtime primed here.
 *
 * The plugin mounts four routes under its base path (`/api/teams`):
 *
 *   - `POST /messages` is the REAL Microsoft Teams messaging endpoint - the URL
 *     an Azure Bot registration points at. It validates the Bot Service JWT,
 *     acknowledges immediately, and delivers the agent's card back over the
 *     Connector API. This is the route that makes a Teams channel able to chat
 *     with the app's agents, the same way the Mastra plugin exposes MCP at a
 *     path.
 *   - `POST /activity` runs the same turn SYNCHRONOUSLY, answering with the
 *     reply activities in the response body. It needs no bot registration, so
 *     it is what a local client (the in-repo preview chat), a test, or any
 *     non-Teams caller uses.
 *   - `POST /card` compiles a {@link card.CardSpec} into an Adaptive Card
 *     document (the preview page posts here).
 *   - `POST /post` pushes a compiled card to the configured Teams incoming
 *     webhook when one is set.
 *
 * Mirrors the node-email add-on's shape.
 *
 * @module
 */

import {
  Plugin,
  toPlugin,
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
import { error, log, object, string } from "@dbx-tools/shared-core";
import { activity as activityContract, card } from "@dbx-tools/shared-teams";
import { verifyBotToken } from "./auth";
import { TEAMS_CONFIG_SCHEMA, type TeamsPluginConfig } from "./config";
import { promptOf, resolveCardAgent, resolveCardContextFactory, runCardTurn } from "./conversation";
import { TEAMS_BUILD_SETTINGS, TEAMS_POST_SETTINGS, TEAMS_TURN_SETTINGS } from "./defaults";
import { deliverTurn, resolveServiceUrl } from "./messaging";
import {
  buildCard,
  getTeamsRuntime,
  postCard,
  resetTeamsRuntime,
  setTeamsExecutor,
} from "./runtime";
import { CREATE_CARD_DESCRIPTION } from "./tool";

/** Mount-relative route (under `/api/teams`) for compiling a card. */
const CARD_ROUTE = "/card";

/** Mount-relative route (under `/api/teams`) for posting a card to a webhook. */
const POST_ROUTE = "/post";

/**
 * Mount-relative route (under `/api/teams`) for one conversation turn: a Bot
 * Framework activity in, activities carrying Adaptive Cards back.
 */
const ACTIVITY_ROUTE = "/activity";

/**
 * Mount-relative route (under `/api/teams`) for the Teams messaging endpoint.
 * This is the path a bot registration's messaging endpoint points at, i.e.
 * `https://<host>/api/teams/messages`.
 */
const MESSAGES_ROUTE = "/messages";

/** Registry key of the agent tool, which agents address as `teams.createCard`. */
const CREATE_TOOL = "createCard";

const logger = log.logger("teams");

/**
 * AppKit plugin that configures the Adaptive Card builder used by the
 * `create_teams_card` tool, and exposes card building as an AppKit agent tool.
 *
 * @example
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 * import { plugin as teamsPlugin } from "@dbx-tools/teams";
 *
 * await createApp({
 *   plugins: [
 *     server(),
 *     teamsPlugin.teams({ webhookUrl: process.env.TEAMS_WEBHOOK_URL }),
 *   ],
 * });
 * ```
 */
export class TeamsPlugin extends Plugin<TeamsPluginConfig> implements ToolProvider {
  static manifest = {
    name: "teams",
    displayName: "Teams",
    description:
      "Answers chat turns as Microsoft Teams Adaptive Cards over a Bot " +
      "Framework activity endpoint, builds cards from a small structured card " +
      "description, and optionally posts them to a Teams incoming webhook.",
    stability: "beta",
    resources: {
      required: [],
      optional: [],
    },
    config: { schema: TEAMS_CONFIG_SCHEMA },
  } satisfies PluginManifest<"teams">;

  /**
   * The tool this plugin offers to an AppKit agent.
   *
   * Marked `autoInheritable`: building a card is a pure, side-effect-free
   * transform (nothing leaves the building), so it is safe to hand to any
   * agent by default - unlike a send.
   *
   * `execute` re-parses its arguments with the local schema: AppKit validates
   * against the same schema first, but re-parsing is what gives the body typed
   * arguments instead of `unknown`.
   */
  private readonly tools: ToolRegistry = {
    [CREATE_TOOL]: defineTool({
      description: CREATE_CARD_DESCRIPTION,
      schema: card.cardSpecSchema,
      annotations: { effect: "read" },
      autoInheritable: true,
      execute: async (args, signal) => buildCard(card.cardSpecSchema.parse(args), signal),
    }),
  };

  /**
   * Prime the shared runtime from this plugin's config (over env), route the
   * tool's builds through this plugin's interceptor chain, and log the
   * effective config so the resolved card version and whether a webhook is
   * wired up are obvious at boot.
   */
  override async setup(): Promise<void> {
    const { config } = getTeamsRuntime(this.config);
    setTeamsExecutor((fn, settings) => this.execute(fn, settings));
    logger.info("ready", {
      cardVersion: config.cardVersion,
      webhook: config.webhookUrl ? "configured" : "disabled",
      messaging: config.allowUnauthenticated
        ? "UNAUTHENTICATED (development)"
        : config.appId && config.appPassword
          ? "bot registration configured"
          : "disabled (no appId/appPassword)",
    });
    // An endpoint serving agent turns with no auth is worth a warning on every
    // boot, not a line buried in an info payload.
    if (config.allowUnauthenticated) {
      logger.warn(
        "POST /messages is serving UNAUTHENTICATED turns - any caller that can " +
          "reach this route can drive the agent. Development only; never expose this.",
      );
    }
  }

  /** Drop the shared runtime. Idempotent. */
  async shutdown(): Promise<void> {
    resetTeamsRuntime();
  }

  /**
   * Mount the card-building and card-posting routes under the plugin base
   * path (`/api/teams`). `POST /card` is what the dev display page calls to
   * preview a card live; `POST /post` pushes a compiled card to the configured
   * Teams incoming webhook.
   *
   * Neither route is wrapped in `asUser(req)`: compiling a card is a pure
   * transform of the request body and posting goes to a preconfigured webhook,
   * so neither reads workspace data on the caller's behalf and neither needs an
   * OBO token. Wrapping them would make the routes throw
   * `AuthenticationError` whenever the user-token header is absent (a local
   * `curl`, a health probe), which - since AppKit does not catch a rejection
   * raised inside the handler - takes the process down rather than answering
   * 401.
   */
  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "buildCard",
      method: "post",
      path: CARD_ROUTE,
      handler: async (req, res) => {
        const result = await this.executeBuild(req.body);
        if (!result.ok) {
          res.status(result.status).json({ error: result.message });
          return;
        }
        res.json(result.data);
      },
    });
    this.route(router, {
      name: "activity",
      method: "post",
      path: ACTIVITY_ROUTE,
      handler: async (req, res) => {
        const result = await this.executeTurn(req.body);
        if (!result.ok) {
          res.status(result.status).json({ error: result.message });
          return;
        }
        res.json(result.data);
      },
    });
    this.route(router, {
      name: "postCard",
      method: "post",
      path: POST_ROUTE,
      handler: async (req, res) => {
        const result = await this.executePost(req.body);
        if (!result.ok) {
          res.status(result.status).json({ error: result.message });
          return;
        }
        res.json({ ok: true });
      },
    });
    // The real Teams messaging endpoint. Unlike every other route here it is
    // called by Azure Bot Service over the public internet, so it authenticates
    // itself from the inbound JWT and answers `200` before the agent has run.
    this.route(router, {
      name: "messages",
      method: "post",
      path: MESSAGES_ROUTE,
      handler: async (req, res) => {
        await this.handleMessage(req, res);
      },
    });
  }

  override exports() {
    return {
      /**
       * Compile a card spec into an Adaptive Card document. For agent-driven
       * builds use {@link teamsCardTool} instead.
       */
      buildCard: (spec: card.CardSpec, signal?: AbortSignal): Promise<card.CardResult> =>
        buildCard(spec, signal),
      /**
       * Post a compiled card to the configured Teams incoming webhook. Throws
       * when no webhook is configured.
       */
      postCard: (cardDocument: card.AdaptiveCard, signal?: AbortSignal): Promise<void> =>
        postCard(cardDocument, signal),
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
   * Handle one inbound request from Azure Bot Service on `POST /messages`.
   *
   * The order of operations is dictated by how Bot Service behaves, not by
   * convenience:
   *
   *   1. **Refuse when unconfigured.** With no `appId` there is no audience to
   *      validate a token against, so the endpoint cannot be operated safely;
   *      it answers 503 rather than processing an unauthenticated activity.
   *   2. **Validate the JWT before parsing the body.** The token is the only
   *      trust boundary this endpoint has.
   *   3. **Pin the reply destination to the token.** `serviceUrl` arrives in the
   *      body, and replies carry the bot's credentials, so it is only honored
   *      when it matches the verified token.
   *   4. **Answer 200 immediately, then run the agent.** Bot Service times out
   *      an unacknowledged activity in seconds and RETRIES it; a card takes far
   *      longer than that, and a retry would post a duplicate card.
   *
   * Activities that carry no prompt (`typing`, `conversationUpdate`, an
   * attachment-only message) are acknowledged and dropped - exactly what a bot
   * does with them.
   */
  private async handleMessage(
    req: { headers: Record<string, unknown>; body: unknown },
    res: {
      status(code: number): { json(body: unknown): void };
      json(body: unknown): void;
      headersSent?: boolean;
    },
  ): Promise<void> {
    const { config } = getTeamsRuntime(this.config);

    // Local development mode: no bot registration, no token, and the reply comes
    // back in the HTTP response rather than through the Connector API (there is
    // no `serviceUrl` to call back to). This is what lets the in-repo preview
    // chat and the Bot Framework Emulator drive the same route Teams uses.
    if (config.allowUnauthenticated) {
      // Accept both envelopes: a bare activity (what Bot Service and the
      // emulator POST) and the `{ activity, agentId }` request shape the
      // `/activity` route takes, so a local client can still choose an agent.
      const body =
        object.isRecord(req.body) && object.isRecord(req.body.activity)
          ? req.body
          : { activity: req.body };
      const result = await this.executeTurn(body);
      if (!result.ok) {
        res.status(result.status).json({ error: result.message });
        return;
      }
      res.json(result.data);
      return;
    }

    if (!config.appId || !config.appPassword) {
      res.status(503).json({
        error:
          "teams: messaging endpoint is not configured - set appId/appPassword " +
          "(TEAMS_APP_ID / TEAMS_APP_PASSWORD) from the Azure Bot registration",
      });
      return;
    }

    const authorization = readHeader(req.headers, "authorization");
    let verified;
    try {
      verified = await verifyBotToken(authorization, {
        appId: config.appId,
        ...(config.appTenantId ? { appTenantId: config.appTenantId } : {}),
      });
    } catch (err) {
      // Deliberately terse: a caller failing authentication learns only that it
      // failed, while the reason goes to the logs.
      logger.warn("rejected an unauthenticated request", { error: error.errorMessage(err) });
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const parsed = activityContract.activitySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const inbound = parsed.data;

    const serviceUrl = resolveServiceUrl(inbound, verified.serviceUrl);
    if (!serviceUrl) {
      logger.warn("rejected an activity with no usable serviceUrl", {
        type: inbound.type,
      });
      res.status(400).json({ error: "activity carried no acceptable serviceUrl" });
      return;
    }

    const agent = resolveCardAgent(this.context?.getPlugins(), config.agentPlugin);
    if (!agent) {
      logger.error("no agent available to answer a Teams turn", {
        agentPlugin: config.agentPlugin,
      });
      res.status(503).json({ error: "no agent available" });
      return;
    }

    // Acknowledge FIRST. Everything after this point is out-of-band work whose
    // result reaches the user through the Connector API, not this response.
    res.status(200).json({});

    if (!promptOf(inbound)) return;

    const createRequestContext = resolveCardContextFactory(
      this.context?.getPlugins(),
      config.agentPlugin,
    );

    void deliverTurn({
      agent,
      activity: inbound,
      serviceUrl,
      ...(createRequestContext ? { createRequestContext } : {}),
      credentials: {
        appId: config.appId,
        appPassword: config.appPassword,
        ...(config.appTenantId ? { appTenantId: config.appTenantId } : {}),
      },
    });
  }

  /** Compile a card, validating the request body against the spec schema. */
  private async executeBuild(body: unknown): Promise<ExecutionResult<card.CardResult>> {
    const parsed = card.cardSpecSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, status: 400, message: parsed.error.message };
    }
    return this.execute(async (signal) => buildCard(parsed.data, signal), TEAMS_BUILD_SETTINGS);
  }

  /**
   * Run one conversation turn: validate the inbound activity, resolve the agent
   * from the sibling agent plugin, and answer with card-carrying activities.
   *
   * Resolution failures are reported distinctly because they have different
   * fixes: 503 when no agent plugin is mounted at all (a wiring problem), 404
   * when the caller named an `agentId` that is not registered (a request
   * problem).
   */
  private async executeTurn(
    body: unknown,
  ): Promise<ExecutionResult<activityContract.ActivityResponse>> {
    const parsed = activityContract.activityRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, status: 400, message: parsed.error.message };
    }
    const { activity, agentId } = parsed.data;
    const { config } = getTeamsRuntime(this.config);
    const agent = resolveCardAgent(this.context?.getPlugins(), config.agentPlugin, agentId);
    if (!agent) {
      return agentId
        ? { ok: false, status: 404, message: `teams: unknown agent '${agentId}'` }
        : {
            ok: false,
            status: 503,
            message: `teams: no agent available - is the '${config.agentPlugin}' plugin registered?`,
          };
    }
    const createRequestContext = resolveCardContextFactory(
      this.context?.getPlugins(),
      config.agentPlugin,
    );
    return this.execute(async (signal) => {
      const activities = await runCardTurn(agent, activity, {
        ...(createRequestContext ? { createRequestContext } : {}),
        ...(signal ? { signal } : {}),
      });
      return { activities };
    }, TEAMS_TURN_SETTINGS);
  }

  /**
   * Compile then post a card, validating the request body against the spec
   * schema. The compile is folded INTO the executed callback so a throw from
   * either half (a build failure, or `postCard` refusing because no webhook is
   * configured) comes back as a failed {@link ExecutionResult} the route can
   * answer with, rather than escaping the handler as an unhandled rejection.
   */
  private async executePost(body: unknown): Promise<ExecutionResult<void>> {
    const parsed = card.cardSpecSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, status: 400, message: parsed.error.message };
    }
    return this.execute(async (signal) => {
      const built = await buildCard(parsed.data, signal);
      await postCard(built.card, signal);
    }, TEAMS_POST_SETTINGS);
  }
}

/**
 * Register the Teams plugin.
 *
 * @example
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 * import { plugin as teamsPlugin } from "@dbx-tools/teams";
 *
 * await createApp({
 *   plugins: [server(), teamsPlugin.teams()],
 * });
 * ```
 */
export const teams = toPlugin(TeamsPlugin);

/**
 * Read one header value, normalizing Node's `string | string[]` shape.
 *
 * Express lower-cases incoming header names, but this is written against a
 * structural `headers` record (so the handler stays testable without an Express
 * request), hence the explicit case-insensitive lookup.
 */
function readHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" ? (string.trimToNull(value) ?? undefined) : undefined;
}
