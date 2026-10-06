/**
 * Browser-safe option primitives shared across dbx-tools packages.
 *
 * @module
 */

import { z } from "zod";
import { isLoopbackHost, urlBuilder } from "./net.ts";
import { isRecord, toBoolean } from "./object.ts";
import { parseList, toIdentifierWithOptions, toSlug } from "./string-utils.ts";

const environmentName = <T extends string>(name: T, description: string) =>
  z.literal(name).default(name).describe(description);

export const DatabricksEnvironmentNamesSchema = z
  .object({
    profile: environmentName("DATABRICKS_CONFIG_PROFILE", "Databricks CLI profile environment."),
    host: environmentName("DATABRICKS_HOST", "Databricks host environment."),
    accountId: environmentName("DATABRICKS_ACCOUNT_ID", "Databricks account ID environment."),
    workspaceId: environmentName("DATABRICKS_WORKSPACE_ID", "Databricks workspace ID environment."),
    configFile: environmentName(
      "DATABRICKS_CONFIG_FILE",
      "Databricks CLI config file environment.",
    ),
    clientId: environmentName("DATABRICKS_CLIENT_ID", "Databricks OAuth client ID environment."),
    clientSecret: environmentName(
      "DATABRICKS_CLIENT_SECRET",
      "Databricks OAuth client secret environment.",
    ),
    accessToken: environmentName("DATABRICKS_TOKEN", "Databricks access token environment."),
    groupId: environmentName("DATABRICKS_GROUP_ID", "Databricks group ID environment."),
    authType: environmentName("DATABRICKS_AUTH_TYPE", "Databricks auth type environment."),
    appName: environmentName("DATABRICKS_APP_NAME", "Databricks App name environment."),
    appPort: environmentName("DATABRICKS_APP_PORT", "Databricks App port environment."),
    lakebaseEndpoint: environmentName("LAKEBASE_ENDPOINT", "Lakebase endpoint environment."),
  })
  .strict()
  .describe("Canonical Databricks CLI, SDK, Apps, and Lakebase environment names.");

export type DatabricksEnvironmentNames = z.output<typeof DatabricksEnvironmentNamesSchema>;

/** Canonical Databricks environment names derived from the owning schema. */
export const databricksEnvironmentNames = Object.freeze(DatabricksEnvironmentNamesSchema.parse({}));

/** Highest valid TCP port number. */
export const MAX_TCP_PORT = 65_535;

export const tcpPortSchema = z.coerce
  .number<number>()
  .int()
  .min(1)
  .max(MAX_TCP_PORT)
  .describe("TCP port from 1 through 65535.");

export const tcpPortOrZeroSchema = z.coerce
  .number<number>()
  .int()
  .min(0)
  .max(MAX_TCP_PORT)
  .describe("TCP port from 0 through 65535, where zero requests automatic allocation.");

export const normalizedUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => urlBuilder(value) !== undefined, {
    message: "Expected a valid URL or host.",
  })
  .overwrite(normalizeUrl)
  .describe("URL normalized through the shared URL builder.");

const databricksText = (description: string) =>
  z.string().trim().min(1).optional().describe(description);

export const DatabricksOptionsSchema = z
  .object({
    profile: databricksText("Databricks CLI profile.").meta({
      env: databricksEnvironmentNames.profile,
    }),
    host: normalizedUrlSchema
      .optional()
      .describe("Databricks host.")
      .meta({ env: databricksEnvironmentNames.host, flag: false }),
    accountId: databricksText("Databricks account ID.").meta({
      env: databricksEnvironmentNames.accountId,
      flag: false,
    }),
    workspaceId: databricksText("Databricks workspace ID.").meta({
      env: databricksEnvironmentNames.workspaceId,
      flag: false,
    }),
    configFile: databricksText("Databricks CLI config file.").meta({
      env: databricksEnvironmentNames.configFile,
      flag: false,
    }),
    clientId: databricksText("Databricks OAuth client ID.").meta({
      env: databricksEnvironmentNames.clientId,
      flag: false,
    }),
    clientSecret: databricksText("Databricks OAuth client secret.").meta({
      env: databricksEnvironmentNames.clientSecret,
      flag: false,
    }),
    accessToken: databricksText("Databricks access token.").meta({
      env: databricksEnvironmentNames.accessToken,
      flag: false,
    }),
    groupId: databricksText("Databricks group ID.").meta({
      env: databricksEnvironmentNames.groupId,
      flag: false,
    }),
    authType: databricksText("Databricks authentication type.").meta({
      env: databricksEnvironmentNames.authType,
      flag: false,
    }),
    appName: databricksText("Databricks App name.").meta({
      env: databricksEnvironmentNames.appName,
      flag: false,
    }),
    appPort: tcpPortSchema.optional().describe("Databricks App port.").meta({
      env: databricksEnvironmentNames.appPort,
      flag: false,
    }),
    lakebaseEndpoint: databricksText("Lakebase endpoint.").meta({
      env: databricksEnvironmentNames.lakebaseEndpoint,
      flag: false,
    }),
  })
  .strict()
  .describe("Common Databricks CLI, SDK, Apps, and Lakebase options.");

export type DatabricksOptions = z.input<typeof DatabricksOptionsSchema>;

/** Key format emitted by {@link serializeOpts}. */
export type OptionSerializationFormat = "flag" | "env";

interface OptionProperty {
  readonly key: string;
  readonly type?: string;
  readonly env?: string | readonly string[];
  readonly flag?: boolean;
}

/** Serialize complete parsed options as JSON keyed by flags or environment names. */
export function serializeOpts<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  values: z.input<z.ZodObject<T>>,
  format: OptionSerializationFormat,
): string {
  const parsed = schema.parse(values) as Readonly<Record<string, unknown>>;
  const entries = optionProperties(schema).flatMap((property) => {
    if (format === "flag" && property.flag === false) return [];
    const key =
      format === "flag"
        ? `--${toSlug(property.key)}`
        : (optionEnvironmentNames(property.key, property.env)[0] ?? "");
    if (!key) return [];
    const value = parsed[property.key];
    return value === undefined ? [] : [[key, serializedOptionValue(value)] as const];
  });
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

const optionalText = (description: string, env: string) =>
  z.string().trim().min(1).optional().describe(description).meta({ env, flag: false });

export const LakebaseOptionsSchema = z
  .object({
    lakebaseEndpoint: optionalText(
      "Lakebase project, resource path, host, or URL.",
      databricksEnvironmentNames.lakebaseEndpoint,
    ),
  })
  .strict()
  .describe("Common Lakebase options.");

export type LakebaseOptions = z.input<typeof LakebaseOptionsSchema>;

/** Explicit option values or environment entries consumed by option parsing helpers. */
export type OptionValueMap = Readonly<Record<string, unknown>> | null;

/** Parse only supplied flag and environment values through an owning Zod object schema. */
export function parseOpts<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  flags: OptionValueMap = null,
  environment: OptionValueMap = null,
): Partial<z.output<z.ZodObject<T>>> {
  const configured = optionValues(schema, flags, environment);
  const parsed = schema.parse(configured);
  return Object.fromEntries(
    Object.keys(configured).map((key) => [key, parsed[key as keyof typeof parsed]]),
  ) as Partial<z.output<z.ZodObject<T>>>;
}

/** Host and TCP port returned by {@link listenAddressSchema}. */
export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/** Defaults and validation policy for {@link listenAddressSchema}. */
export interface ListenAddressOptions {
  readonly port: number;
  readonly host?: string;
  readonly loopback?: boolean;
}

/** Build a listener address schema accepting a port, `:port`, `host:port`, or object. */
export function listenAddressSchema(options: ListenAddressOptions) {
  const defaults: ListenAddress = {
    host: options.host ?? "localhost",
    port: options.port,
  };
  return z
    .preprocess(
      (value) => parseListenAddress(value, defaults),
      z
        .object({
          host: z.string().trim().toLowerCase().min(1).default(defaults.host),
          port: tcpPortOrZeroSchema.default(defaults.port),
        })
        .strict()
        .refine(
          (address) => !options.loopback || isLoopbackHost(address.host),
          "Listener host must be loopback.",
        ),
    )
    .default(defaults)
    .describe("Listener host and port.");
}

/** Render a listener address as `host:port`, with IPv6 hosts bracketed. */
export function formatListenAddress(address: ListenAddress): string {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `${host}:${address.port}`;
}

function parseListenAddress(value: unknown, defaults: ListenAddress): unknown {
  if (typeof value === "number") return { host: defaults.host, port: value };
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (/^\d+$/.test(text)) return { host: defaults.host, port: text };
  if (/^:\d+$/.test(text)) return { host: defaults.host, port: text.slice(1) };
  const bracketed = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { host: bracketed[1], port: bracketed[2] ?? defaults.port };
  }
  const separator = text.lastIndexOf(":");
  if (separator > 0 && !text.slice(0, separator).includes(":")) {
    return {
      host: text.slice(0, separator),
      port: text.slice(separator + 1),
    };
  }
  return { host: text || defaults.host, port: defaults.port };
}

function optionProperties(schema: z.ZodObject<z.ZodRawShape>): OptionProperty[] {
  const document = z.toJSONSchema(schema);
  if (!isRecord(document.properties)) return [];
  return Object.entries(document.properties).flatMap(([key, value]) => {
    if (!isRecord(value)) return [];
    return [
      {
        key,
        type: typeof value.type === "string" ? value.type : undefined,
        env:
          typeof value.env === "string" || Array.isArray(value.env)
            ? (value.env as string | readonly string[])
            : undefined,
        flag: typeof value.flag === "boolean" ? value.flag : undefined,
      },
    ];
  });
}

function serializedOptionValue(value: unknown): unknown {
  if (isRecord(value) && typeof value.host === "string" && typeof value.port === "number") {
    return formatListenAddress({ host: value.host, port: value.port });
  }
  return value;
}

function optionValues<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  values: OptionValueMap,
  environment: OptionValueMap,
): Record<string, unknown> {
  const document = z.toJSONSchema(schema);
  const properties = isRecord(document.properties) ? document.properties : {};
  const configured: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) continue;
    const explicit = firstOptionValue(values, [key, `--${toSlug(key)}`]);
    if (explicit !== undefined) {
      configured[key] = optionEnvironmentValue(property.type, explicit);
      continue;
    }
    const names = optionEnvironmentNames(key, property.env);
    const sourced = firstOptionValue(environment, names);
    if (sourced === undefined) continue;
    configured[key] = optionEnvironmentValue(property.type, sourced);
  }
  return configured;
}

function optionEnvironmentNames(key: string, configured: unknown): string[] {
  if (typeof configured === "string") return [configured];
  if (Array.isArray(configured)) {
    return configured.filter((value): value is string => typeof value === "string");
  }
  return [toIdentifierWithOptions({ delimiter: "_" }, key).toUpperCase()];
}

function optionEnvironmentValue(type: unknown, value: unknown): unknown {
  if (type === "boolean") return toBoolean(value) ?? value;
  if (type === "array" && typeof value === "string") return parseList(value);
  return value;
}

function firstOptionValue(source: OptionValueMap, keys: readonly string[]): unknown | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizeUrl(value: string): string {
  const url = urlBuilder(value);
  if (!url) return value;
  const normalized = url.toString();
  return url.pathname === "/" && !url.search && !url.hash ? normalized.slice(0, -1) : normalized;
}
