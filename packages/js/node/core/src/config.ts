/**
 * Layered configuration lookup: environment, `.env`, bundle, and `app.yaml`.
 *
 * Every package resolves settings the same way: take the caller's value, else
 * an environment variable, else a default. Local development adds two fallback
 * locations: `.env` files, one App's `resources.apps.<app>.config.env` in
 * `databricks.yml`, and literal env values in `app.yaml` / `app.yml`.
 *
 * {@link values} is LAZY (an `object.Sequence`), so `databricks bundle validate`
 * is only spawned when the environment and `.env` both missed; app YAML is only
 * read after the bundle source also missed.
 *
 * Inside a deployed Databricks App all three file sources are skipped by default
 * ({@link isDatabricksAppEnv}): the platform has already turned them into real
 * environment variables, there is no bundle to validate, and the `databricks`
 * CLI is not on the image. Boolean environment overrides can force either file
 * source on or off when a tool needs different behavior.
 *
 * Only the single bundle app's `config.env` and literal app YAML `env[].value`
 * entries are consulted. Root bundle `variables` are not: they are authoring
 * inputs for the bundle itself (interpolated into targets, resources, and paths),
 * so treating one as a process setting resolves names the deployed app never sees.
 *
 * Node-only (`child_process`, `fs`, `process`).
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { json, log, object, string as sharedString } from "@dbx-tools/shared-core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { cachedRecord, statSync } from "./file.ts";
import { resolveWorkingDirectory, root as resolveProjectRoot } from "./project.ts";

const logger = log.logger("config");
const configFileCache = new Map<string, string | undefined>();

type ConfigKey = string | readonly string[];

export type ConfigMapValue = string | readonly string[] | null | undefined;
export type ConfigData = Readonly<Record<string, ConfigMapValue>>;

/** Where a value may come from, consulted in the order given. */
export type ConfigSource = "config" | "env" | "dotenv" | "bundle" | "app";

export interface ConfigOptions {
  /**
   * Outermost namespaces tried before each key. Defaults to `DBX_TOOLS`.
   */
  scope?: string | readonly string[];
  /** Capability namespaces inserted after the scope and before each key. */
  prefix?: string | readonly string[];
  /** Constant config maps read by the `config` source. */
  data?: ConfigData | readonly ConfigData[];
  /** Parsed bundle data used instead of loading `databricks.yml`. */
  bundleData?: ConfigFile | Record<string, unknown>;
  /** Parsed app YAML data used instead of loading `app.yaml`. */
  appData?: ConfigFile | Record<string, unknown>;
  /** Sources in precedence order. Default: `config`, `env`, `dotenv`, `bundle`, `app`. */
  sources?: ConfigSource | readonly ConfigSource[];
  /** Directory to resolve `.env` and the bundle from. Default: `process.cwd()`. */
  cwd?: string;
}

/** One resolved value, tagged with the key and source it came from. */
interface ConfigValue {
  key: string;
  source: ConfigSource;
  value: string;
}

/** A config file found on disk, with its parsed contents. */
export interface ConfigFile {
  path: string;
  data: Record<string, unknown>;
}

const DEFAULT_SCOPE = "DBX_TOOLS";
const DEFAULT_SOURCES: readonly ConfigSource[] = ["config", "env", "dotenv", "bundle", "app"];
const BUNDLE_FILE_NAMES = ["databricks.yml", "databricks.yaml"] as const;
const APP_FILE_NAMES = ["app.yaml", "app.yml"] as const;
const DOTENV_FILE_NAME = ".env";
const NODE_ENV_ALTERNATIVES = {
  production: ["prod"],
  development: ["dev"],
} as const satisfies Record<string, readonly string[]>;

/** Highest valid TCP port number. */
export const MAX_TCP_PORT = 65_535;

/** Boolean environment override for {@link isDatabricksAppEnv}. */
const DATABRICKS_APP_ENV_KEY = "DBX_TOOLS_DATABRICKS_APP_ENV";

/** Boolean environment override for project `.env` reads. */
const CONFIG_DOTENV_KEY = "DBX_TOOLS_CONFIG_DOTENV";

/** Boolean environment override for Databricks bundle reads. */
const CONFIG_BUNDLE_KEY = "DBX_TOOLS_CONFIG_BUNDLE";

/** Boolean environment override for Databricks App YAML reads. */
const CONFIG_APP_KEY = "DBX_TOOLS_CONFIG_APP";

/** Exact process-environment lookup for callers that do not read local config files. */
export const ENV_ONLY = { scope: [] as const, sources: "env" as const };

export const valueSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value: string) => !/\$\{[^}]+\}/.test(value), {
    message: "Interpolated values are not allowed",
  });

const portValueSchema = z.preprocess(
  (input) => object.toNumber(input),
  z.number().int().min(1).max(MAX_TCP_PORT),
);

const positiveNumberValue = z.preprocess((input) => object.toNumber(input), z.number().positive());
const positiveIntValue = positiveNumberValue.transform(Math.floor);

const workspaceHostSchema = valueSchema.refine(
  (host) => {
    try {
      return ["http:", "https:"].includes(new URL(host).protocol);
    } catch {
      return false;
    }
  },
  { message: "Must be an HTTP(S) URL" },
);

const databricksAppEnvSchema = z.object({
  DATABRICKS_APP_NAME: valueSchema,
  DATABRICKS_HOST: workspaceHostSchema,
  DATABRICKS_APP_PORT: portValueSchema,
});

/** A named bundle or App resource; concrete resource fields pass through. */
export const bundleResourceSchema = z.object({ name: valueSchema.optional() }).passthrough();

export const bundleEnvEntrySchema = z.object({
  name: valueSchema.optional(),
  value: z.string().optional(),
  value_from: valueSchema.optional(),
});

export const bundleAppSchema = z.object({
  name: valueSchema.optional(),
  config: z.object({ env: z.array(bundleEnvEntrySchema).optional() }).optional(),
  resources: z.array(bundleResourceSchema).optional(),
});

export const appEnvEntrySchema = z.object({
  name: valueSchema,
  value: z.string().optional(),
  valueFrom: valueSchema.optional(),
});

export const appSchema = z.object({
  env: z.array(appEnvEntrySchema).optional(),
  resources: z.array(bundleResourceSchema).optional(),
});

const bundleConfigSchema = z.object({
  resources: z.object({ apps: z.record(z.string(), bundleAppSchema).optional() }).optional(),
});

/** Flatten the single bundle App's `config.env`, resolving resource references. */
export function flattenBundleEnv(data: unknown): Record<string, string> {
  const parsed = bundleConfigSchema.safeParse(data);
  if (!parsed.success) return {};
  const apps = Object.values(parsed.data.resources?.apps ?? {});
  if (apps.length !== 1) return {};
  const app = apps[0];
  const resources = new Map(
    (app?.resources ?? [])
      .filter((resource) => resource.name)
      .map((resource) => [resource.name!, resource] as const),
  );
  const result: Record<string, string> = {};
  for (const entry of app?.config?.env ?? []) {
    if (!entry.name) continue;
    const literal = valueSchema.safeParse(entry.value);
    if (literal.success) {
      result[entry.name] = literal.data;
      continue;
    }
    const referenced = entry.value_from
      ? resourceValue(resources.get(entry.value_from))
      : undefined;
    if (referenced) result[entry.name] = referenced;
  }
  return result;
}

/** Flatten `app.yaml` env entries, resolving `valueFrom` resource references. */
export function flattenAppEnv(data: unknown): Record<string, string> {
  const parsed = appSchema.safeParse(data);
  if (!parsed.success) return {};
  const resources = new Map(
    (parsed.data.resources ?? [])
      .filter((resource) => resource.name)
      .map((resource) => [resource.name!, resource] as const),
  );
  const result: Record<string, string> = {};
  for (const entry of parsed.data.env ?? []) {
    const literal = valueSchema.safeParse(entry.value);
    if (literal.success) {
      result[entry.name] = literal.data;
      continue;
    }
    const referenced = entry.valueFrom ? resourceValue(resources.get(entry.valueFrom)) : undefined;
    if (referenced) result[entry.name] = referenced;
  }
  return result;
}

function resourceValue(resource: unknown): string | undefined {
  for (const path of [
    ["sql_warehouse", "id"],
    ["genie_space", "space_id"],
    ["postgres", "endpoint"],
    ["postgres", "database"],
    ["postgres", "branch"],
  ] as const) {
    let value = resource;
    for (const part of path) value = object.isRecord(value) ? value[part] : undefined;
    const parsed = valueSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** Walk a dot-separated path through parsed bundle data. */
export function getBundlePath(data: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return undefined;
  let current: unknown = data;
  for (let index = 0; index < parts.length; index++) {
    if (!object.isRecord(current)) return undefined;
    const next = current[parts[index]!];
    if (index === parts.length - 1) {
      const direct = valueSchema.safeParse(next);
      if (direct.success) return direct.data;
      if (object.isRecord(next)) {
        const nested = valueSchema.safeParse(next.value);
        return nested.success ? nested.data : undefined;
      }
      return undefined;
    }
    current = next;
  }
  return undefined;
}

/**
 * Detect a Databricks App runtime from its required name, host, and port.
 *
 * `DBX_TOOLS_DATABRICKS_APP_ENV` takes precedence when it contains a recognized
 * boolean value. This lets local tools emulate the deployed runtime (`true`) or
 * lets unusual deployed processes retain local config lookup (`false`). An
 * absent or unrecognized override falls back to structural detection.
 */
export function isDatabricksAppEnv(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const override = object.toBoolean(source[DATABRICKS_APP_ENV_KEY]);
  if (override !== undefined) return override;
  const parsed = databricksAppEnvSchema.safeParse(source);
  return parsed.success;
}

/** Exact, uppercase, and tokenized-uppercase names for a human-friendly key. */
export function environmentKeys(name: string): readonly string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  return object
    .sequence(
      trimmed,
      trimmed.toUpperCase(),
      Array.from(sharedString.tokenize(trimmed)).join("_").toUpperCase(),
    )
    .filter(Boolean)
    .distinct()
    .toArray();
}

/** Candidate names in scope, prefix, and input precedence order. */
function keys(
  input: ConfigKey,
  options: Pick<ConfigOptions, "scope" | "prefix"> = {},
): readonly string[] {
  const scopes = object
    .sequence(options.scope ?? DEFAULT_SCOPE)
    .map(sharedString.trimToEmpty)
    .filter(Boolean)
    .distinct()
    .toArray();
  const prefixes =
    options.prefix === undefined
      ? []
      : object
          .sequence(options.prefix)
          .map(sharedString.trimToEmpty)
          .filter(Boolean)
          .distinct()
          .toArray();
  return object
    .sequence(input)
    .map(sharedString.trimToEmpty)
    .filter(Boolean)
    .distinct()
    .flatMap((key) => {
      const prefixed = prefixes.length > 0 ? prefixes.map((prefix) => `${prefix}_${key}`) : [key];
      return [
        ...scopes.flatMap((scope) => prefixed.map((name) => `${scope}_${name}`)),
        ...prefixed,
        key,
      ];
    })
    .distinct()
    .toArray();
}

/**
 * Every value that resolves for `input`, in source-then-key precedence order,
 * as a LAZY sequence: nothing past the first consumed element is read, so
 * `values(key).at(0)` never spawns the Databricks CLI when the environment
 * already answered.
 *
 */
function values(input: ConfigKey, options: ConfigOptions = {}): object.Sequence<ConfigValue> {
  const candidates = keys(input, options);
  const sources = configSources(options);
  return object.sequence({
    *[Symbol.iterator](): Generator<ConfigValue> {
      for (const source of sources) {
        for (const map of read(source, options)) {
          for (const key of candidates) {
            const value = configMapValue(map[key]);
            if (value !== null) yield { key, source, value };
          }
        }
      }
    },
  });
}

function configSources(options: ConfigOptions): readonly ConfigSource[] {
  const sources: ConfigSource[] = [
    ...object.sequence<ConfigSource>(options.sources ?? DEFAULT_SOURCES).distinct(),
  ];
  if (options.data !== undefined && options.sources !== undefined && !sources.includes("config")) {
    sources.push("config");
  }
  return sources;
}

function configMapValue(value: ConfigMapValue | unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = sharedString.trimToNull(entry);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  return sharedString.trimToNull(value);
}

/**
 * The first value that resolves for `input`, or `undefined`.
 *
 * @example
 * const domain = config.text(["TUNNEL_PUBLIC_DOMAIN", "PUBLIC_DOMAIN"]);
 */
export function text(input: ConfigKey, options: ConfigOptions = {}): string | undefined {
  return values(input, options).at(0)?.value;
}

/** Resolve a human-friendly name through {@link environmentKeys} and {@link text}. */
export function resolveValue(name: string, options: ConfigOptions = {}): string | undefined {
  return text(environmentKeys(name), options);
}

/**
 * The PRIMARY (fully-scoped) name for `input` - what to print in a log line or an
 * error, so the message names the variable a reader should set. Do not index
 * `keys(...)[0]` for this if `input` may be a bare string.
 *
 * @example
 * logger.warn(`${config.name(JWT_SECRET_ENV)} is not set`);
 */
export function name(
  input: ConfigKey,
  options: Pick<ConfigOptions, "scope" | "prefix"> = {},
): string {
  return keys(input, options)[0] ?? "";
}

/**
 * Safe `.env.<name>` suffixes for a Node environment, exact spelling first.
 * Known long and short names are interchangeable; unknown names pass through.
 */
function nodeEnvNames(nodeEnv: unknown): string[] {
  const name = sharedString.trimToNull(nodeEnv)?.toLowerCase();
  if (!name || !/^[a-z0-9_-]+$/.test(name)) return [];
  for (const [canonical, alternatives] of Object.entries(NODE_ENV_ALTERNATIVES)) {
    const names: readonly string[] = alternatives;
    if (name === canonical || names.includes(name)) {
      return [...object.sequence(name, canonical, alternatives).distinct()];
    }
  }
  return [name];
}

/**
 * Resolve a string: `configured` when non-empty, else {@link text}, else `undefined`.
 *
 * The coercion rules are deliberately loose (`on` / `yes` / `1` are all
 * `true`) because values may come from a file a human typed.
 *
 * @example
 * config.string(options.host, "SMTP_HOST");
 */
export function string(
  configured: unknown,
  input: ConfigKey,
  options?: ConfigOptions,
): string | undefined {
  return sharedString.trimToNull(configured) ?? text(input, options);
}

/**
 * Resolve a boolean through `object.toBoolean`. `undefined` when neither source
 * is interpretable, so the caller picks a default with `??`.
 */
export function boolean(
  configured: unknown,
  input: ConfigKey,
  options?: ConfigOptions,
): boolean | undefined {
  return object.toBoolean(configured) ?? object.toBoolean(text(input, options));
}

/**
 * Resolve a positive number that may be fractional (a score threshold, a ratio).
 * Use {@link positiveInt} for a count, port, or timeout.
 */
export function positiveNumber(
  configured: unknown,
  input: ConfigKey,
  fallback: number,
  options?: ConfigOptions,
): number {
  const fromConfig = positiveNumberValue.safeParse(configured);
  if (fromConfig.success) return fromConfig.data;
  const fromSources = positiveNumberValue.safeParse(text(input, options));
  return fromSources.success ? fromSources.data : fallback;
}

/**
 * Resolve a positive integer (a port, a timeout, a page size), floored. A
 * non-numeric or non-positive value is treated as ABSENT rather than fatal -
 * these are ceilings where a sane default beats a boot failure.
 */
export function positiveInt(
  configured: unknown,
  input: ConfigKey,
  fallback: number,
  options?: ConfigOptions,
): number {
  const fromConfig = positiveIntValue.safeParse(configured);
  if (fromConfig.success) return fromConfig.data;
  const fromSources = positiveIntValue.safeParse(text(input, options));
  return fromSources.success ? fromSources.data : Math.floor(fallback);
}

/**
 * Resolve a TCP port between 1 and {@link MAX_TCP_PORT}. Invalid configured or
 * sourced values fall back to the caller's default, which may be a sentinel
 * such as `0` when the caller uses one.
 */
export function port(
  configured: unknown,
  input: ConfigKey,
  fallback: number,
  options?: ConfigOptions,
): number {
  const fromConfig = portValueSchema.safeParse(configured);
  if (fromConfig.success) return fromConfig.data;
  const fromSources = portValueSchema.safeParse(text(input, options));
  return fromSources.success ? fromSources.data : fallback;
}

/**
 * Resolve a list through `string.parseList`, so an array from typed config and a
 * `"a, b c"` string normalize identically. `[]` when neither source has entries.
 */
export function list(
  configured: string | readonly string[] | undefined | null,
  input: ConfigKey,
  transform?: (entry: string) => string,
  options?: ConfigOptions,
): string[] {
  const fromConfig = sharedString.parseList(configured, transform);
  return fromConfig.length > 0
    ? fromConfig
    : sharedString.parseList(text(input, options), transform);
}

/**
 * The Databricks bundle output for `cwd` - `databricks bundle validate --output
 * json` run from the directory holding `databricks.yml`, with the config file's
 * path. A non-zero validation may still return partial JSON with usable App
 * config. `undefined` when bundle reads are disabled, the process is production
 * or a deployed App without an explicit override, there is no bundle, or the
 * CLI produces no JSON.
 *
 * Parsed validation output is cached by bundle path and Databricks profile.
 *
 */
export function bundleFile(cwd?: string | null): ConfigFile | undefined {
  const override = object.toBoolean(process.env[CONFIG_BUNDLE_KEY]);
  if (override === false) return undefined;
  if (
    override === undefined &&
    (process.env.NODE_ENV?.trim().toLowerCase() === "production" || isDatabricksAppEnv())
  ) {
    return undefined;
  }
  const resolved = resolveWorkingDirectory(cwd);
  return loadBundleFile(resolved, sharedString.trimToNull(process.env.DATABRICKS_CONFIG_PROFILE));
}

/** The parsed `app.yaml` / `app.yml` for `cwd`, when local App config reads are enabled. */
export function appFile(cwd?: string | null): ConfigFile | undefined {
  const enabled = object.toBoolean(process.env[CONFIG_APP_KEY]) ?? !isDatabricksAppEnv();
  if (!enabled) return undefined;
  return loadAppFile(resolveWorkingDirectory(cwd));
}

/** The single bundle App's resolved environment, when available. */
function bundleEnvironment(options: ConfigOptions): Record<string, string> | undefined {
  const data = sourceData(options.bundleData) ?? bundleFile(options.cwd)?.data;
  return data ? flattenBundleEnv(data) : undefined;
}

function appEnvironment(options: ConfigOptions): Record<string, string> | undefined {
  const data = sourceData(options.appData) ?? appFile(options.cwd)?.data;
  return data ? flattenAppEnv(data) : undefined;
}

function sourceData(
  source: ConfigFile | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!source) return undefined;
  if ("path" in source && typeof source.path === "string" && object.isRecord(source.data)) {
    return source.data;
  }
  return source as Record<string, unknown>;
}

/** Parsed `.env` for `cwd`, or `{}`; parsed file data is cached by path. */
function dotenv(cwd?: string | null): Record<string, string | undefined> {
  const enabled = object.toBoolean(process.env[CONFIG_DOTENV_KEY]) ?? !isDatabricksAppEnv();
  if (!enabled) return {};
  const resolved = resolveWorkingDirectory(cwd);
  return loadDotenv(resolved, nodeEnvNames(process.env.NODE_ENV));
}

/** Maps for one source in precedence order. */
function read(
  source: ConfigSource,
  options: ConfigOptions,
): object.Sequence<Readonly<Record<string, unknown>>> {
  return object.sequence({
    *[Symbol.iterator](): Generator<Readonly<Record<string, unknown>>> {
      switch (source) {
        case "config": {
          const data = options.data;
          if (Array.isArray(data)) {
            yield* data;
          } else if (data !== undefined) {
            yield data as ConfigData;
          }
          break;
        }
        case "env":
          yield process.env;
          break;
        case "dotenv":
          yield dotenv(options.cwd);
          break;
        case "bundle": {
          const environment = bundleEnvironment(options);
          if (environment) yield environment;
          break;
        }
        case "app": {
          const environment = appEnvironment(options);
          if (environment) yield environment;
          break;
        }
        default:
          throw new TypeError(`Unknown config source: ${source}`);
      }
    },
  });
}

/**
 * Locate `names` from `cwd` outward. `cwd` itself is checked before the
 * discovered project roots so a package-local file wins over the workspace's.
 */
function findConfigFile(cwd: string, names: readonly string[]): string | undefined {
  const start = resolve(cwd);
  const key = JSON.stringify([start, ...names]);
  if (configFileCache.has(key)) return configFileCache.get(key);
  const root = resolveProjectRoot(start);
  const pathFromRoot = root ? relative(root, start) : undefined;
  const boundary =
    root &&
    pathFromRoot !== undefined &&
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`)
      ? root
      : undefined;
  for (let dir = start; ; dir = dirname(dir)) {
    for (const name of names) {
      const path = resolve(dir, name);
      if (statSync(path)?.isFile()) {
        configFileCache.set(key, path);
        return path;
      }
    }
    if (boundary === undefined || dir === boundary) break;
  }
  configFileCache.set(key, undefined);
  return undefined;
}

function loadDotenv(
  cwd: string,
  environments: readonly string[],
): Record<string, string | undefined> {
  const names = [...environments.map((name) => `${DOTENV_FILE_NAME}.${name}`), DOTENV_FILE_NAME];
  const path = findConfigFile(cwd, names);
  if (!path) return {};
  return (
    cachedRecord(JSON.stringify(["dotenv", path]), () => {
      try {
        return parseEnv(readFileSync(path, "utf8"));
      } catch {
        logger.warn("failed to read dotenv file", { path });
        return {};
      }
    }) ?? {}
  );
}

function loadBundleFile(cwd: string, profile: string | null): ConfigFile | undefined {
  const path = findConfigFile(cwd, BUNDLE_FILE_NAMES);
  if (!path) return undefined;
  const data = cachedRecord(JSON.stringify(["bundle", path, profile]), () => {
    const args = [
      "bundle",
      "validate",
      "--output",
      "json",
      ...(profile === null ? [] : ["--profile", profile]),
    ];
    const result = spawnSync("databricks", args, {
      cwd: resolve(path, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = sharedString.trimToNull(result.stdout);
    const error = sharedString.trimToNull(result.stderr);
    if (output === null) {
      logger.debug("bundle validate produced no JSON", { path, status: result.status, error });
      return undefined;
    }
    const parsed = json.parseRecord(output);
    if (!parsed) {
      logger.warn("failed to parse bundle validate output", { path, status: result.status });
      return undefined;
    }
    if (result.status !== 0) {
      logger.debug("using partial bundle output", { path, status: result.status, error });
    }
    return parsed;
  });
  return data === undefined ? undefined : { path, data };
}

function loadAppFile(cwd: string): ConfigFile | undefined {
  const path = findConfigFile(cwd, APP_FILE_NAMES);
  if (!path) return undefined;
  const data = cachedRecord(JSON.stringify(["app", path]), () => {
    try {
      const parsed = parseYaml(readFileSync(path, "utf8"));
      return object.isRecord(parsed) ? parsed : undefined;
    } catch {
      logger.warn("failed to parse app yaml", { path });
      return undefined;
    }
  });
  return data === undefined ? undefined : { path, data };
}
