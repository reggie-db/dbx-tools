/**
 * Configuration for the Teams plugin: the typed {@link TeamsPluginConfig}
 * (the plugin's slice of AppKit config), the JSON Schema the manifest
 * publishes for it, and {@link resolveTeamsConfig} which layers that config
 * over environment defaults into the concrete {@link ResolvedTeamsConfig} the
 * runtime + tools read.
 *
 * Building a card is a pure transform, so the config is deliberately small:
 * the Adaptive Card version the builder targets, an optional Teams
 * incoming-webhook URL a deployment can wire up to actually POST cards to a
 * channel, and which sibling plugin owns the agents the conversation endpoint
 * answers with.
 *
 * The remaining fields are the Azure Bot registration a real Teams channel
 * needs: `appId` / `appPassword` (the bot's Entra application credentials, used
 * both to validate the inbound JWT audience and to fetch the outbound Connector
 * token) and `appTenantId` (set only for a single-tenant bot). When no `appId`
 * is configured the `/messages` endpoint stays MOUNTED but refuses every
 * request, so an unconfigured deployment cannot accidentally expose an
 * unauthenticated bot endpoint.
 *
 * Env fallbacks: `TEAMS_CARD_VERSION`, `TEAMS_WEBHOOK_URL`,
 * `TEAMS_AGENT_PLUGIN`, `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`,
 * `TEAMS_APP_TENANT_ID`. The `MICROSOFT_APP_*` spellings the Bot Framework SDK
 * uses are accepted as aliases so an existing bot's environment drops in
 * unchanged.
 *
 * @module
 */

import { ValidationError, type BasePluginConfig } from "@databricks/appkit";
import { config as coreConfig } from "@dbx-tools/core";
import { object } from "@dbx-tools/shared-core";
import { card } from "@dbx-tools/shared-teams";
import type { JSONSchema7 } from "json-schema";

/** Dedicated override for the Adaptive Card schema version the builder targets. */
export const CARD_VERSION_ENV = "TEAMS_CARD_VERSION";

/** Environment name for an optional Teams incoming-webhook URL. */
export const WEBHOOK_URL_ENV = "TEAMS_WEBHOOK_URL";

/** Environment name overriding which sibling plugin provides the agents. */
export const AGENT_PLUGIN_ENV = "TEAMS_AGENT_PLUGIN";

/**
 * Environment names for the bot's Entra app id, in precedence order. The
 * `MICROSOFT_APP_ID` alias is what the Bot Framework SDK and the Azure portal's
 * generated settings use, so an existing bot deployment needs no new variable.
 */
export const APP_ID_ENVS = ["TEAMS_APP_ID", "MICROSOFT_APP_ID"] as const;

/** Environment names for the bot's client secret, in precedence order. */
export const APP_PASSWORD_ENVS = ["TEAMS_APP_PASSWORD", "MICROSOFT_APP_PASSWORD"] as const;

/**
 * Environment names for the bot's tenant, in precedence order. Set only for a
 * single-tenant bot; a multi-tenant bot leaves it unset.
 */
export const APP_TENANT_ENVS = ["TEAMS_APP_TENANT_ID", "MICROSOFT_APP_TENANT_ID"] as const;

/**
 * Environment name for the unauthenticated-messaging escape hatch. Named
 * `TEAMS_ALLOW_UNAUTHENTICATED` (rather than something softer like `TEAMS_DEV`)
 * so what it disables is unmistakable in a shell history or deploy manifest.
 */
export const ALLOW_UNAUTHENTICATED_ENV = "TEAMS_ALLOW_UNAUTHENTICATED";

/**
 * Default registered name of the plugin the conversation endpoint asks for an
 * agent. `mastra` is the name `@dbx-tools/appkit-mastra` registers under.
 */
export const DEFAULT_AGENT_PLUGIN = "mastra";

/** AppKit config accepted by the Teams plugin. */
export interface TeamsPluginConfig extends BasePluginConfig {
  /**
   * Adaptive Card schema version the builder targets. Defaults to
   * {@link card.ADAPTIVE_CARD_VERSION} (`"1.5"`, what Teams supports). Falls
   * back to `TEAMS_CARD_VERSION`.
   */
  cardVersion?: string;
  /**
   * Optional Teams incoming-webhook URL. When set, the plugin's `postCard`
   * export / route posts the compiled card to this channel; when unset,
   * posting is disabled and the plugin only builds cards for the UI to render.
   * Falls back to `TEAMS_WEBHOOK_URL`.
   */
  webhookUrl?: string;
  /**
   * Registered name of the sibling plugin whose agents answer a conversation
   * turn. Defaults to {@link DEFAULT_AGENT_PLUGIN} (`"mastra"`); set it when the
   * Mastra plugin is mounted under a `config.name` override. Falls back to
   * `TEAMS_AGENT_PLUGIN`.
   */
  agentPlugin?: string;
  /**
   * The bot's Entra application (client) id from its Azure Bot registration.
   * Required before `POST /api/teams/messages` will accept a request: it is the
   * audience an inbound Bot Framework token must carry, and the client id used
   * to fetch an outbound Connector token. Falls back to `TEAMS_APP_ID` /
   * `MICROSOFT_APP_ID`.
   */
  appId?: string;
  /**
   * Client secret for {@link appId}. Needed to send replies through the
   * Connector API; without it inbound activities still validate but the bot
   * cannot answer. Falls back to `TEAMS_APP_PASSWORD` /
   * `MICROSOFT_APP_PASSWORD`.
   */
  appPassword?: string;
  /**
   * Tenant id for a SINGLE-tenant bot registration. Leave unset for a
   * multi-tenant bot. Falls back to `TEAMS_APP_TENANT_ID` /
   * `MICROSOFT_APP_TENANT_ID`.
   */
  appTenantId?: string;
  /**
   * Serve `POST /messages` with NO inbound token validation, and reply in the
   * HTTP response instead of through the Connector API.
   *
   * This exists so the messaging endpoint can be exercised locally - by the
   * in-repo preview chat, a `curl`, or the Bot Framework Emulator - without an
   * Azure Bot registration. It removes the endpoint's ONLY trust boundary: any
   * caller that can reach the route can drive the agent and read its answers.
   *
   * Never enable it on a deployment reachable from the internet. It is ignored
   * unless `NODE_ENV` is `development` (see {@link resolveTeamsConfig}), so a
   * production build cannot be talked into it by an environment variable alone.
   * Falls back to `TEAMS_ALLOW_UNAUTHENTICATED`.
   */
  allowUnauthenticated?: boolean;
}

/** The concrete config the runtime reads, after config + env resolution. */
export interface ResolvedTeamsConfig {
  /** Adaptive Card schema version the builder stamps onto every document. */
  cardVersion: string;
  /** Teams incoming-webhook URL, or `undefined` when posting is disabled. */
  webhookUrl?: string;
  /** Registered name of the plugin the conversation endpoint resolves agents from. */
  agentPlugin: string;
  /** Bot app (client) id, or `undefined` when no bot registration is configured. */
  appId?: string;
  /** Bot client secret, or `undefined` when replies cannot be sent. */
  appPassword?: string;
  /** Tenant id for a single-tenant bot, or `undefined` for a multi-tenant one. */
  appTenantId?: string;
  /**
   * Whether `POST /messages` serves turns with NO token validation. See
   * {@link TeamsPluginConfig.allowUnauthenticated}.
   */
  allowUnauthenticated: boolean;
}

/** JSON Schema published in the plugin manifest for {@link TeamsPluginConfig}. */
export const TEAMS_CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    cardVersion: {
      type: "string",
      description: `Adaptive Card schema version the builder targets. ${CARD_VERSION_ENV} overrides it.`,
    },
    webhookUrl: {
      type: "string",
      description: `Optional Teams incoming-webhook URL used to post cards. ${WEBHOOK_URL_ENV} overrides it.`,
    },
    agentPlugin: {
      type: "string",
      description: `Registered name of the sibling plugin whose agents answer a conversation turn. ${AGENT_PLUGIN_ENV} overrides it.`,
    },
    appId: {
      type: "string",
      description: `Entra app (client) id of the Azure Bot registration. Required for the Teams messaging endpoint. ${APP_ID_ENVS[0]} overrides it.`,
    },
    appPassword: {
      type: "string",
      description: `Client secret for the bot app id, used to fetch an outbound Connector token. ${APP_PASSWORD_ENVS[0]} overrides it.`,
    },
    appTenantId: {
      type: "string",
      description: `Tenant id for a single-tenant bot registration; unset for multi-tenant. ${APP_TENANT_ENVS[0]} overrides it.`,
    },
    allowUnauthenticated: {
      type: "boolean",
      description:
        "Serve the Teams messaging endpoint with NO token validation, replying in " +
        "the HTTP response. Local development only; ignored unless NODE_ENV is " +
        `development. ${ALLOW_UNAUTHENTICATED_ENV} overrides it.`,
    },
  },
};

/**
 * Layer the plugin config over environment defaults into the concrete config
 * the runtime uses. Fails loudly on a webhook URL that is present but not a
 * valid absolute URL, since that is a deploy-time mistake.
 */
export function resolveTeamsConfig(overrides?: TeamsPluginConfig): ResolvedTeamsConfig {
  const cardVersion =
    coreConfig.string(overrides?.cardVersion, CARD_VERSION_ENV, coreConfig.ENV_ONLY) ??
    card.ADAPTIVE_CARD_VERSION;
  const webhookUrl = coreConfig.string(overrides?.webhookUrl, WEBHOOK_URL_ENV, coreConfig.ENV_ONLY);
  if (webhookUrl !== undefined && !isHttpsUrl(webhookUrl)) {
    throw ValidationError.invalidValue(
      WEBHOOK_URL_ENV,
      webhookUrl,
      "an absolute https URL for the Teams webhook",
    );
  }
  const agentPlugin =
    coreConfig.string(overrides?.agentPlugin, AGENT_PLUGIN_ENV, coreConfig.ENV_ONLY) ??
    DEFAULT_AGENT_PLUGIN;
  // Two independent conditions must BOTH hold: the operator asked for it, and
  // this is a development build. Gating on `NODE_ENV` as well means a stray
  // variable in a production environment cannot silently expose the endpoint.
  const requested = coreConfig.boolean(
    overrides?.allowUnauthenticated,
    ALLOW_UNAUTHENTICATED_ENV,
    coreConfig.ENV_ONLY,
  );
  const allowUnauthenticated = requested === true && process.env.NODE_ENV === "development";
  return {
    cardVersion,
    agentPlugin,
    allowUnauthenticated,
    ...object.optional("webhookUrl", webhookUrl),
    ...object.optional(
      "appId",
      coreConfig.string(overrides?.appId, APP_ID_ENVS, coreConfig.ENV_ONLY),
    ),
    ...object.optional(
      "appPassword",
      coreConfig.string(overrides?.appPassword, APP_PASSWORD_ENVS, coreConfig.ENV_ONLY),
    ),
    ...object.optional(
      "appTenantId",
      coreConfig.string(overrides?.appTenantId, APP_TENANT_ENVS, coreConfig.ENV_ONLY),
    ),
  };
}

/** Whether `value` parses as an absolute HTTPS URL. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
