/**
 * CLI-over-environment configuration for the token broker.
 *
 * `TOKEN_CONFIG` composes the repository's default `DBX_TOOLS` scope with the
 * capability prefix, so every setting accepts `DBX_TOOLS_TOKEN_BROKER_*`,
 * `TOKEN_BROKER_*`, and a bare compatibility name through one resolver.
 *
 * @module
 */

import { resolve } from "node:path";
import { config } from "@dbx-tools/core";
import { object, string } from "@dbx-tools/shared-core";
import envPaths from "env-paths";

import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_AUTH_MODE,
  DEFAULT_BIND,
  DEFAULT_BIND_DOCKER,
  DEFAULT_CLIENT_TOKEN_TTL_SECONDS,
  DEFAULT_GOOGLE_SCOPES,
  DEFAULT_PORT,
  DEFAULT_REFRESH_SKEW_SECONDS,
  DEFAULT_SERVICE_NAME,
} from "./defaults.ts";

/** Shared config namespace for all broker CLI and environment settings. */
export const TOKEN_CONFIG = { prefix: "TOKEN_BROKER" } as const;

/** Provider identifiers accepted on the wire and CLI. */
export const TOKEN_PROVIDERS = ["google"] as const;
export type TokenProviderName = (typeof TOKEN_PROVIDERS)[number];
/** Mutually exclusive client authentication modes. */
export type BrokerAuthMode = "password" | "jwt";
/** Container network engine selection for gateway discovery. */
export type ContainerEngine = "auto" | "docker" | "podman";

/** Fields shared by unresolved CLI input and fully resolved configuration. */
interface TokenConfigFields<Text, NumberValue, List, ProviderList = List, Auth = Text> {
  /** Explicit listener addresses. */
  bind: List;
  /** Listener and client default port. */
  port: NumberValue;
  /** Enabled providers in request-default order. */
  providers: ProviderList;
  /** Provider scopes used when a request omits scopes. */
  scopes: List;
  /** Maximum scope set clients may request. */
  allowedScopes: List;
  /** Remaining token lifetime that triggers refresh. */
  refreshSkewSeconds: NumberValue;
  /** Conservative lifetime assigned to gcloud access tokens. */
  accessTokenTtlSeconds: NumberValue;
  /** Client authorization mode. */
  auth: Auth;
  /** Lifetime of broker-issued client JWTs. */
  clientTokenTtlSeconds: NumberValue;
  /** Persistent public material, service definitions, and secret fallback root. */
  stateDir: Text;
  /** Additional accepted HTTP Host header values. */
  allowedHosts: List;
  /** Native OS service identifier. */
  serviceName: Text;
  /** Client identity used by access-token requests. */
  client: Text;
}

/** Optional fields shared by input and resolved configuration. */
interface OptionalTokenConfigFields<Text> {
  /** Full broker URL for client commands. */
  serverUrl?: Text;
  /** Shared password or JWT HMAC signing secret. */
  secret?: Text;
}

/** User-supplied token settings before shared config and defaults are applied. */
export type TokenConfigInput = Partial<
  TokenConfigFields<string, string | number, string | string[]> & OptionalTokenConfigFields<string>
> & {
  /** Discover local Docker and/or Podman gateway interfaces. */
  bindDocker?: ContainerEngine | boolean;
};

/** Fully resolved broker and client configuration with no implicit coercions left. */
export interface ResolvedTokenConfig
  extends
    TokenConfigFields<string, number, string[], TokenProviderName[], BrokerAuthMode>,
    OptionalTokenConfigFields<string> {
  /** Container gateway discovery mode when enabled. */
  bindDocker?: ContainerEngine;
}

/**
 * Resolve one config object through CLI values, scoped environment values, and
 * stable defaults.
 */
export function resolveTokenConfig(input: TokenConfigInput = {}): ResolvedTokenConfig {
  const paths = envPaths("dbx-tools", { suffix: "" });
  const configuredProviders = config.list(input.providers, "PROVIDER", undefined, TOKEN_CONFIG);
  const providers = distinct(
    (configuredProviders.length > 0 ? configuredProviders : TOKEN_PROVIDERS).map((provider) =>
      oneOf(provider, TOKEN_PROVIDERS, "token provider"),
    ),
  );
  const auth = oneOf(
    config.string(input.auth, "AUTH", TOKEN_CONFIG) ?? DEFAULT_AUTH_MODE,
    ["password", "jwt"] as const,
    "broker auth",
  );
  const scopes = canonicalScopes(config.list(input.scopes, "SCOPES", undefined, TOKEN_CONFIG));
  const allowedScopes = canonicalScopes(
    config.list(input.allowedScopes, "ALLOWED_SCOPES", undefined, TOKEN_CONFIG),
  );
  const clientJwtTtlSeconds = config.string(undefined, "CLIENT_JWT_TTL_SECONDS", TOKEN_CONFIG);
  const binds = string.parseList(input.bind);
  const configuredBinds = config.list(undefined, "BIND", undefined, TOKEN_CONFIG);
  const bindDockerConfigured =
    input.bindDocker === false
      ? false
      : typeof input.bindDocker === "string"
        ? input.bindDocker
        : input.bindDocker
          ? "auto"
          : (config.string(undefined, "BIND_DOCKER", TOKEN_CONFIG) ?? DEFAULT_BIND_DOCKER);
  const bindDockerBoolean = object.toBoolean(bindDockerConfigured);
  const bindDockerValue =
    bindDockerBoolean === true
      ? "auto"
      : bindDockerBoolean === false
        ? undefined
        : bindDockerConfigured;
  return {
    bind: distinct(
      binds.length > 0 ? binds : configuredBinds.length > 0 ? configuredBinds : DEFAULT_BIND,
    ),
    ...(bindDockerValue
      ? {
          bindDocker: oneOf(
            bindDockerValue,
            ["auto", "docker", "podman"] as const,
            "container engine",
          ),
        }
      : {}),
    port: config.port(input.port, "PORT", DEFAULT_PORT, TOKEN_CONFIG),
    ...object.optional("serverUrl", config.string(input.serverUrl, "SERVER_URL", TOKEN_CONFIG)),
    providers,
    scopes: scopes.length > 0 ? scopes : [...DEFAULT_GOOGLE_SCOPES],
    allowedScopes:
      allowedScopes.length > 0
        ? allowedScopes
        : scopes.length > 0
          ? scopes
          : [...DEFAULT_GOOGLE_SCOPES],
    refreshSkewSeconds: config.positiveInt(
      input.refreshSkewSeconds,
      "REFRESH_SKEW_SECONDS",
      DEFAULT_REFRESH_SKEW_SECONDS,
      TOKEN_CONFIG,
    ),
    accessTokenTtlSeconds: config.positiveInt(
      input.accessTokenTtlSeconds,
      "ACCESS_TOKEN_TTL_SECONDS",
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      TOKEN_CONFIG,
    ),
    auth,
    ...object.optional(
      "secret",
      config.string(input.secret, "SECRET", TOKEN_CONFIG) ??
        config.string(undefined, auth === "password" ? "PASSWORD" : "SIGNING_SECRET", TOKEN_CONFIG),
    ),
    clientTokenTtlSeconds: config.positiveInt(
      input.clientTokenTtlSeconds ?? clientJwtTtlSeconds,
      "CLIENT_TOKEN_TTL_SECONDS",
      DEFAULT_CLIENT_TOKEN_TTL_SECONDS,
      TOKEN_CONFIG,
    ),
    stateDir: resolve(
      config.string(input.stateDir, "STATE_DIR", TOKEN_CONFIG) ??
        resolve(paths.data, "token-broker"),
    ),
    allowedHosts: distinct([
      ...DEFAULT_ALLOWED_HOSTS,
      ...config.list(input.allowedHosts, "ALLOWED_HOSTS", undefined, TOKEN_CONFIG),
    ]),
    serviceName:
      config.string(input.serviceName, "SERVICE_NAME", TOKEN_CONFIG) ?? DEFAULT_SERVICE_NAME,
    client: config.string(input.client, "CLIENT", TOKEN_CONFIG) ?? "local-cli",
  };
}

/** Trim, deduplicate, and sort scopes so equivalent requests share one cache key. */
export function canonicalScopes(scopes: readonly string[]): string[] {
  return distinct(scopes.map((scope) => scope.trim()).filter(Boolean)).sort();
}

function oneOf<const T extends readonly string[]>(
  value: string,
  values: T,
  label: string,
): T[number] {
  const normalized = value.trim().toLowerCase();
  if ((values as readonly string[]).includes(normalized)) return normalized as T[number];
  throw new TypeError(`${label} must be one of: ${values.join(", ")}`);
}

function distinct<T>(values: readonly T[]): T[] {
  return [...object.distinct(values)];
}
