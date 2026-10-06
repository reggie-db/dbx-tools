/**
 * AppKit Graphiti sidecar ports and Python command.
 *
 * @module
 */
import { ConfigurationError, type BasePluginConfig } from "@databricks/appkit";
import { configUtils, projectUtils } from "@dbx-tools/core";
import type { JSONSchema7 } from "json-schema";

/** Optional sidecar ports, Python command, and journal namespace for the Graphiti plugin. */
export interface GraphitiPluginConfig extends BasePluginConfig {
  graphitiPort?: number;
  modelGatewayPort?: number;
  proxyPort?: number;
  python?: string;
  journalNamespace?: string;
}

/** Graphiti plugin configuration after environment values and defaults are applied. */
export interface ResolvedGraphitiPluginConfig extends GraphitiPluginConfig {
  graphitiPort: number;
  modelGatewayPort: number;
  proxyPort: number;
  python: string;
  journalNamespace: string;
}

/** AppKit manifest schema for caller-provided Graphiti plugin configuration. */
export const GRAPHITI_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    graphitiPort: { type: "integer", minimum: 1, maximum: 65535 },
    modelGatewayPort: { type: "integer", minimum: 1, maximum: 65535 },
    proxyPort: { type: "integer", minimum: 1, maximum: 65535 },
    python: { type: "string" },
    journalNamespace: { type: "string" },
  },
  additionalProperties: false,
} satisfies JSONSchema7;

/** Resolve plugin config over exact environment values and stable defaults. */
export function resolveGraphitiConfig(
  config: GraphitiPluginConfig = {},
): ResolvedGraphitiPluginConfig {
  const graphitiPort = configUtils.port(
    config.graphitiPort,
    "GRAPHITI_PORT",
    0,
    configUtils.ENV_ONLY,
  );
  const modelGatewayPort = configUtils.port(
    config.modelGatewayPort,
    "MODEL_GATEWAY_PORT",
    0,
    configUtils.ENV_ONLY,
  );
  const proxyPort = configUtils.port(config.proxyPort, "PROXY_PORT", 0, configUtils.ENV_ONLY);
  const configuredPorts = [graphitiPort, modelGatewayPort, proxyPort].filter(Boolean);
  if (new Set(configuredPorts).size !== configuredPorts.length) {
    throw new ConfigurationError("Graphiti sidecar ports must be distinct");
  }
  const python =
    config.python ?? configUtils.text("PYTHON", configUtils.ENV_ONLY)?.trim() ?? "python3";
  const journalNamespace =
    config.journalNamespace ??
    configUtils.text("JOURNAL_NAMESPACE", configUtils.ENV_ONLY)?.trim() ??
    process.env.DATABRICKS_APP_NAME?.trim() ??
    projectUtils.name() ??
    "default";
  return {
    graphitiPort,
    modelGatewayPort,
    proxyPort,
    python,
    journalNamespace,
  };
}
