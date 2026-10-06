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
const databricksOptionMeta = (env: string, flag = true) => ({
  env,
  flag,
  helpDefault: false,
});

export const DatabricksOptionsSchema = z
  .object({
    profile: databricksText("Databricks CLI profile.").meta(
      databricksOptionMeta(databricksEnvironmentNames.profile),
    ),
    host: normalizedUrlSchema
      .optional()
      .describe("Databricks host.")
      .meta(databricksOptionMeta(databricksEnvironmentNames.host, false)),
    accountId: databricksText("Databricks account ID.").meta(
      databricksOptionMeta(databricksEnvironmentNames.accountId, false),
    ),
    workspaceId: databricksText("Databricks workspace ID.").meta(
      databricksOptionMeta(databricksEnvironmentNames.workspaceId, false),
    ),
    configFile: databricksText("Databricks CLI config file.").meta(
      databricksOptionMeta(databricksEnvironmentNames.configFile, false),
    ),
    clientId: databricksText("Databricks OAuth client ID.").meta(
      databricksOptionMeta(databricksEnvironmentNames.clientId, false),
    ),
    clientSecret: databricksText("Databricks OAuth client secret.").meta(
      databricksOptionMeta(databricksEnvironmentNames.clientSecret, false),
    ),
    accessToken: databricksText("Databricks access token.").meta(
      databricksOptionMeta(databricksEnvironmentNames.accessToken, false),
    ),
    groupId: databricksText("Databricks group ID.").meta(
      databricksOptionMeta(databricksEnvironmentNames.groupId, false),
    ),
    authType: databricksText("Databricks authentication type.").meta(
      databricksOptionMeta(databricksEnvironmentNames.authType, false),
    ),
    appName: databricksText("Databricks App name.").meta(
      databricksOptionMeta(databricksEnvironmentNames.appName, false),
    ),
    appPort: tcpPortSchema
      .optional()
      .describe("Databricks App port.")
      .meta(databricksOptionMeta(databricksEnvironmentNames.appPort, false)),
    lakebaseEndpoint: databricksText("Lakebase endpoint.").meta(
      databricksOptionMeta(databricksEnvironmentNames.lakebaseEndpoint, false),
    ),
  })
  .strict()
  .describe("Common Databricks CLI, SDK, Apps, and Lakebase options.");

export type DatabricksOptions = z.input<typeof DatabricksOptionsSchema>;

/** Key format emitted by {@link serializeOpts}. */
export type OptionSerializationFormat = "flag" | "env";

/** Prefix every option field while retaining its owning Zod field schemas. */
export type SubnamedOptionShape<T extends z.ZodRawShape, Prefix extends string> = {
  [Key in keyof T as Key extends string ? `${Prefix}${Capitalize<Key>}` : never]: T[Key];
};

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
  return JSON.stringify(serializedOpts(schema, values, format), null, 2);
}

/** Serialize complete parsed options as a process environment map. */
export function serializeOptsEnvironment<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  values: z.input<z.ZodObject<T>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(serializedOpts(schema, values, "env")).map(([key, value]) => [
      key,
      environmentOptionValue(value),
    ]),
  );
}

/** Prefix a reusable option schema so composed CLI flags render as `--<prefix>-<field>`. */
export function subnameOpts<T extends z.ZodRawShape, Prefix extends string>(
  schema: z.ZodObject<T>,
  prefix: Prefix,
): z.ZodObject<SubnamedOptionShape<T, Prefix>> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      field,
    ]),
  );
  return z.object(shape).strict() as z.ZodObject<SubnamedOptionShape<T, Prefix>>;
}

function serializedOpts<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  values: z.input<z.ZodObject<T>>,
  format: OptionSerializationFormat,
): Readonly<Record<string, unknown>> {
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
  return Object.fromEntries(entries);
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

/** Supported listener transport schemes. */
export type ListenScheme = "tcp" | "unix";

/** TCP listener returned by {@link listenAddressSchema}. */
export interface TcpListenAddress {
  readonly scheme: "tcp";
  readonly host: string;
  readonly port: number;
}

/** Unix-domain listener returned by {@link listenAddressSchema}. */
export interface UnixListenAddress {
  readonly scheme: "unix";
  readonly path: string;
}

/** Transport-aware listener address. */
export type ListenAddress = TcpListenAddress | UnixListenAddress;

/** Defaults and validation policy for {@link listenAddressSchema}. */
export interface ListenAddressOptions {
  readonly port: number;
  readonly host?: string;
  readonly loopback?: boolean;
  readonly scheme?: ListenScheme;
  readonly schemes?: readonly ListenScheme[];
  readonly withDefault?: boolean;
}

/** Raw listener input accepted before transport-aware normalization. */
export type ListenAddressInput = ListenAddress | string | number | undefined;

export function listenAddressSchema(
  options: ListenAddressOptions & {
    readonly schemes: readonly ["tcp", "unix"];
    readonly withDefault: false;
  },
): z.ZodType<ListenAddress, unknown>;

export function listenAddressSchema(
  options: ListenAddressOptions & { readonly schemes: readonly ["tcp", "unix"] },
): z.ZodDefault<z.ZodType<ListenAddress, unknown>>;

export function listenAddressSchema(
  options: ListenAddressOptions & { readonly withDefault: false },
): z.ZodType<TcpListenAddress, unknown>;

export function listenAddressSchema(
  options: ListenAddressOptions,
): z.ZodDefault<z.ZodType<TcpListenAddress, unknown>>;

/** Build a transport-aware listener schema. Bare addresses use the configured default scheme. */
export function listenAddressSchema(
  options: ListenAddressOptions,
): z.ZodType<ListenAddress, unknown> | z.ZodDefault<z.ZodType<ListenAddress, unknown>> {
  const defaults: TcpListenAddress = {
    scheme: "tcp",
    host: options.host ?? "localhost",
    port: options.port,
  };
  const allowed = new Set<ListenScheme>(options.schemes ?? ["tcp"]);
  const schema = z
    .preprocess(
      (value) => parseListenAddress(value, defaults, options.scheme ?? "tcp"),
      z.discriminatedUnion("scheme", [
        z
          .object({
            scheme: z.literal("tcp"),
            host: z.string().trim().toLowerCase().min(1).default(defaults.host),
            port: tcpPortOrZeroSchema.default(defaults.port),
          })
          .strict(),
        z
          .object({
            scheme: z.literal("unix"),
            path: z.string().trim().min(1),
          })
          .strict(),
      ]),
    )
    .refine((address) => allowed.has(address.scheme), "Listener scheme is not allowed.")
    .refine(
      (address) => address.scheme !== "tcp" || !options.loopback || isLoopbackHost(address.host),
      "Listener host must be loopback.",
    )
    .describe("TCP or Unix-domain listener address.") as z.ZodType<ListenAddress, unknown>;
  return options.withDefault === false ? schema : schema.default(defaults);
}

/** Render a listener address as a `tcp://` or `unix://` URL. */
export function formatListenAddress(address: ListenAddress): string {
  if (address.scheme === "unix") {
    return `unix://${address.path.startsWith("/") ? "" : "/"}${address.path}`;
  }
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `tcp://${host}:${address.port}`;
}

function parseListenAddress(
  value: unknown,
  defaults: TcpListenAddress,
  defaultScheme: ListenScheme,
): unknown {
  if (isRecord(value) && value.scheme === undefined) {
    if (typeof value.host === "string" && value.port !== undefined) {
      return { ...value, scheme: "tcp" };
    }
    if (typeof value.path === "string") {
      return { ...value, scheme: "unix" };
    }
  }
  if (typeof value === "number") {
    return defaultScheme === "tcp"
      ? { scheme: "tcp", host: defaults.host, port: value }
      : { scheme: "unix", path: String(value) };
  }
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.startsWith("unix://")) {
    const path = text.slice("unix://".length);
    return { scheme: "unix", path: path.startsWith("/") ? path : `/${path}` };
  }
  const tcp = text.startsWith("tcp://") ? text.slice("tcp://".length) : text;
  if (defaultScheme === "unix" && !text.startsWith("tcp://")) {
    return { scheme: "unix", path: text };
  }
  if (/^\d+$/.test(tcp)) return { scheme: "tcp", host: defaults.host, port: tcp };
  if (/^:\d+$/.test(tcp)) {
    return { scheme: "tcp", host: defaults.host, port: tcp.slice(1) };
  }
  const bracketed = tcp.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return {
      scheme: "tcp",
      host: bracketed[1],
      port: bracketed[2] ?? defaults.port,
    };
  }
  const separator = tcp.lastIndexOf(":");
  if (separator > 0 && !tcp.slice(0, separator).includes(":")) {
    return {
      scheme: "tcp",
      host: tcp.slice(0, separator),
      port: tcp.slice(separator + 1),
    };
  }
  return { scheme: "tcp", host: tcp || defaults.host, port: defaults.port };
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
  if (isRecord(value) && value.scheme === "tcp") {
    if (typeof value.host === "string" && typeof value.port === "number") {
      return formatListenAddress({ scheme: "tcp", host: value.host, port: value.port });
    }
  }
  if (isRecord(value) && value.scheme === "unix" && typeof value.path === "string") {
    return formatListenAddress({ scheme: "unix", path: value.path });
  }
  return value;
}

function environmentOptionValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
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
