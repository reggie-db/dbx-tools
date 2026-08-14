/**
 * AppKit Graphiti sidecar ports, route prefix, and Python command.
 *
 * @module
 */
import { ConfigurationError, type BasePluginConfig } from "@databricks/appkit";
import { config as coreConfig } from "@dbx-tools/core";
import type { JSONSchema7 } from "json-schema";

export interface GraphitiPluginConfig extends BasePluginConfig {
  publicPort?: number;
  appPort?: number;
  graphitiPort?: number;
  routePrefix?: string;
  python?: string;
  journalNamespace?: string;
}

export interface ResolvedGraphitiPluginConfig extends GraphitiPluginConfig {
  publicPort: number;
  appPort: number;
  graphitiPort: number;
  routePrefix: string;
  python: string;
  journalNamespace: string;
}

export const GRAPHITI_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    publicPort: { type: "integer", minimum: 1, maximum: 65535 },
    appPort: { type: "integer", minimum: 1, maximum: 65535 },
    graphitiPort: { type: "integer", minimum: 1, maximum: 65535 },
    routePrefix: { type: "string" },
    python: { type: "string" },
    journalNamespace: { type: "string" },
  },
  additionalProperties: false,
} satisfies JSONSchema7;

/** Resolve plugin config over exact environment values and stable defaults. */
export function resolveGraphitiConfig(
  config: GraphitiPluginConfig = {},
): ResolvedGraphitiPluginConfig {
  const publicPort = coreConfig.port(
    config.publicPort,
    "DATABRICKS_APP_PORT",
    8000,
    coreConfig.ENV_ONLY,
  );
  const appPort = coreConfig.port(
    config.appPort,
    "GRAPHITI_APP_PORT",
    publicPort + 1,
    coreConfig.ENV_ONLY,
  );
  const graphitiPort = coreConfig.port(
    config.graphitiPort,
    "GRAPHITI_PORT",
    0,
    coreConfig.ENV_ONLY,
  );
  if (new Set([publicPort, appPort, graphitiPort]).size !== 3) {
    throw new ConfigurationError("Graphiti public, AppKit, and sidecar ports must be distinct");
  }
  const routePrefix = normalizeRoutePrefix(
    config.routePrefix ??
      coreConfig.text("GRAPHITI_ROUTE_PREFIX", coreConfig.ENV_ONLY) ??
      "/graphiti",
  );
  const python =
    config.python ?? coreConfig.text("PYTHON", coreConfig.ENV_ONLY)?.trim() ?? "python3";
  const journalNamespace =
    config.journalNamespace ??
    coreConfig.text("JOURNAL_NAMESPACE", coreConfig.ENV_ONLY)?.trim() ??
    process.env.DATABRICKS_APP_NAME?.trim() ??
    "default";
  return {
    publicPort,
    appPort,
    graphitiPort,
    routePrefix,
    python,
    journalNamespace,
  };
}

/** Return the internal port an AppKit `server()` plugin should bind. */
export function appPort(config: GraphitiPluginConfig = {}): number {
  return resolveGraphitiConfig(config).appPort;
}

function normalizeRoutePrefix(value: string): string {
  const normalized = `/${value.trim().replace(/^\/+|\/+$/g, "")}`;
  if (normalized === "/") {
    throw new ConfigurationError("Graphiti routePrefix must contain a path segment");
  }
  return normalized;
}
