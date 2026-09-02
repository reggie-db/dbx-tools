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
  DEFAULT_CLIENT_TOKEN_TTL_SECONDS,
  DEFAULT_GOOGLE_SCOPES,
  DEFAULT_PORT,
  DEFAULT_PROVIDER,
  DEFAULT_REFRESH_SKEW_SECONDS,
  DEFAULT_SERVICE_NAME,
  DEFAULT_TLS_MODE,
} from "./defaults.ts";

/** Shared config namespace for all broker CLI and environment settings. */
export const TOKEN_CONFIG = { prefix: "TOKEN_BROKER" } as const;

/** Provider identifiers accepted on the wire and CLI. */
export type TokenProviderName = "google";
/** Application authorization layered over the transport. */
export type BrokerAuthMode = "none" | "password" | "jwt";
/** `none` is plain HTTP; `mtls` requires trusted client certificates. */
export type BrokerTlsMode = "none" | "mtls";
/** Container network engine selection for gateway discovery. */
export type ContainerEngine = "auto" | "docker" | "podman";

/** Fields shared by unresolved CLI input and fully resolved configuration. */
interface TokenConfigFields<Text, NumberValue, List, Provider = Text, Auth = Text, Tls = Text> {
  /** Explicit listener addresses. */
  bind: List;
  /** Listener and client default port. */
  port: NumberValue;
  /** Provider selected when a request omits one. */
  provider: Provider;
  /** Provider scopes used when a request omits scopes. */
  scopes: List;
  /** Maximum scope set clients may request. */
  allowedScopes: List;
  /** Remaining token lifetime that triggers refresh. */
  refreshSkewSeconds: NumberValue;
  /** Conservative lifetime assigned to gcloud access tokens. */
  accessTokenTtlSeconds: NumberValue;
  /** Application authorization mode layered over transport security. */
  auth: Auth;
  /** Lifetime of broker-issued client JWTs. */
  clientTokenTtlSeconds: NumberValue;
  /** `mtls` or `none`; no-auth always resolves to `none`. */
  tls: Tls;
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
  /** Password-mode shared secret. */
  password?: Text;
  /** JWT-mode HMAC secret override. */
  signingSecret?: Text;
  /** Existing signed client JWT. */
  clientToken?: Text;
  /** Client-side CA certificate override. */
  caPath?: Text;
  /** Client-side mTLS certificate override. */
  certPath?: Text;
  /** Client-side mTLS private-key override. */
  keyPath?: Text;
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
    TokenConfigFields<string, number, string[], TokenProviderName, BrokerAuthMode, BrokerTlsMode>,
    OptionalTokenConfigFields<string> {
  /** Container gateway discovery mode when enabled. */
  bindDocker?: ContainerEngine;
}

/**
 * Resolve one config object through CLI values, scoped environment values, and
 * stable defaults. No-auth is an explicit plaintext-loopback mode and therefore
 * suppresses all TLS and application-secret settings.
 */
export function resolveTokenConfig(input: TokenConfigInput = {}): ResolvedTokenConfig {
  const paths = envPaths("dbx-tools", { suffix: "" });
  const provider = oneOf(
    config.string(input.provider, "PROVIDER", TOKEN_CONFIG) ?? DEFAULT_PROVIDER,
    ["google"] as const,
    "token provider",
  );
  const auth = oneOf(
    config.string(input.auth, "AUTH", TOKEN_CONFIG) ?? DEFAULT_AUTH_MODE,
    ["none", "password", "jwt"] as const,
    "broker auth",
  );
  const configuredTls = oneOf(
    config.string(input.tls, "TLS", TOKEN_CONFIG) ?? DEFAULT_TLS_MODE,
    ["none", "mtls"] as const,
    "broker TLS",
  );
  const tls = auth === "none" ? "none" : configuredTls;
  const scopes = canonicalScopes(config.list(input.scopes, "SCOPES", undefined, TOKEN_CONFIG));
  const allowedScopes = canonicalScopes(
    config.list(input.allowedScopes, "ALLOWED_SCOPES", undefined, TOKEN_CONFIG),
  );
  const binds = string.parseList(input.bind);
  const configuredBinds = config.list(undefined, "BIND", undefined, TOKEN_CONFIG);
  const bindDockerConfigured =
    typeof input.bindDocker === "string"
      ? input.bindDocker
      : input.bindDocker
        ? "auto"
        : config.string(undefined, "BIND_DOCKER", TOKEN_CONFIG);
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
    provider,
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
    ...(auth === "password"
      ? object.optional("password", config.string(input.password, "PASSWORD", TOKEN_CONFIG))
      : {}),
    ...(auth === "jwt"
      ? object.optional(
          "signingSecret",
          config.string(input.signingSecret, "SIGNING_SECRET", TOKEN_CONFIG),
        )
      : {}),
    clientTokenTtlSeconds: config.positiveInt(
      input.clientTokenTtlSeconds,
      "CLIENT_TOKEN_TTL_SECONDS",
      DEFAULT_CLIENT_TOKEN_TTL_SECONDS,
      TOKEN_CONFIG,
    ),
    tls,
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
    ...object.optional(
      "clientToken",
      config.string(input.clientToken, "CLIENT_TOKEN", TOKEN_CONFIG),
    ),
    ...object.optional("caPath", config.string(input.caPath, "CA", TOKEN_CONFIG)),
    ...object.optional("certPath", config.string(input.certPath, "CERT", TOKEN_CONFIG)),
    ...object.optional("keyPath", config.string(input.keyPath, "KEY", TOKEN_CONFIG)),
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

function distinct(values: readonly string[]): string[] {
  return [...object.distinct(values)];
}
