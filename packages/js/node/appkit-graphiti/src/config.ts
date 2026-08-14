/**
 * AppKit Graphiti sidecar ports and Python command.
 *
 * @module
 */
import { ConfigurationError, type BasePluginConfig } from "@databricks/appkit";
import { config as coreConfig, project as coreProject } from "@dbx-tools/core";
import type { JSONSchema7 } from "json-schema";

export interface GraphitiPluginConfig extends BasePluginConfig {
  graphitiPort?: number;
  litellmPort?: number;
  proxyPort?: number;
  python?: string;
  journalNamespace?: string;
}

export interface ResolvedGraphitiPluginConfig extends GraphitiPluginConfig {
  graphitiPort: number;
  litellmPort: number;
  proxyPort: number;
  python: string;
  journalNamespace: string;
}

export const GRAPHITI_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    graphitiPort: { type: "integer", minimum: 1, maximum: 65535 },
    litellmPort: { type: "integer", minimum: 1, maximum: 65535 },
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
  const graphitiPort = coreConfig.port(
    config.graphitiPort,
    "GRAPHITI_PORT",
    0,
    coreConfig.ENV_ONLY,
  );
  const litellmPort = coreConfig.port(config.litellmPort, "LITELLM_PORT", 0, coreConfig.ENV_ONLY);
  const proxyPort = coreConfig.port(config.proxyPort, "PROXY_PORT", 0, coreConfig.ENV_ONLY);
  const configuredPorts = [graphitiPort, litellmPort, proxyPort].filter(Boolean);
  if (new Set(configuredPorts).size !== configuredPorts.length) {
    throw new ConfigurationError("Graphiti sidecar ports must be distinct");
  }
  const python =
    config.python ?? coreConfig.text("PYTHON", coreConfig.ENV_ONLY)?.trim() ?? "python3";
  const journalNamespace =
    config.journalNamespace ??
    coreConfig.text("JOURNAL_NAMESPACE", coreConfig.ENV_ONLY)?.trim() ??
    process.env.DATABRICKS_APP_NAME?.trim() ??
    coreProject.name() ??
    "default";
  return {
    graphitiPort,
    litellmPort,
    proxyPort,
    python,
    journalNamespace,
  };
}
