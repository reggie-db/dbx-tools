/**
 * Layered configuration lookup: environment, `.env`, Databricks bundle.
 *
 * Every package resolves settings the same way: take the caller's value, else
 * an environment variable, else a default. Local development adds two fallback
 * locations: `.env` files and `resources.apps.<app>.config.env` or root
 * `variables` in `databricks.yml`.
 *
 * Two things make it cheap to call from a hot path:
 *
 *   - {@link values} is LAZY (an `object.Sequence`), so `databricks bundle
 *     validate` is only spawned when the environment and `.env` both missed.
 *   - the parsed `.env` and bundle are cached through {@link context.cached}, so
 *     the spawn happens once per working directory and a `cwd` change misses
 *     rather than returning another project's config.
 *
 * Inside a deployed Databricks App both file sources are skipped by default
 * ({@link isDatabricksAppEnv}): the platform has already turned them into real
 * environment variables, there is no bundle to validate, and the `databricks`
 * CLI is not on the image. Boolean environment overrides can force either file
 * source on or off when a tool needs different behavior.
 *
 * Node-only (`child_process`, `fs`, `process`).
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { context, json, log, object, string as stringModule } from "@dbx-tools/shared-core";
import { z } from "zod";
import { statSync } from "./file.ts";
import { root as resolveProjectRoot } from "./project.ts";

const logger = log.logger("config");

export type ConfigKey = string | readonly string[];

/** Where a value may come from, consulted in the order given. */
export type ConfigSource = "env" | "dotenv" | "bundle";

export interface ConfigOptions {
  /**
   * Outermost namespaces tried before each key. Defaults to `DBX_TOOLS`.
   */
  scope?: string | readonly string[];
  /** Capability namespaces inserted after the scope and before each key. */
  prefix?: string | readonly string[];
  /** Directory to resolve `.env` and the bundle from. Default: `process.cwd()`. */
  cwd?: string;
  /** Sources in precedence order. Default: `env`, `dotenv`, `bundle`. */
  sources?: ConfigSource | readonly ConfigSource[];
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
const DEFAULT_SOURCES: readonly ConfigSource[] = ["env", "dotenv", "bundle"];
const BUNDLE_FILE_NAMES = ["databricks.yml", "databricks.yaml"] as const;
const DOTENV_FILE_NAME = ".env";
const NODE_ENV_ALTERNATIVES = {
  production: ["prod"],
  development: ["dev"],
} as const satisfies Record<string, readonly string[]>;

/** Highest valid TCP port number. */
export const MAX_TCP_PORT = 65_535;

/** Boolean environment override for {@link isDatabricksAppEnv}. */
export const DATABRICKS_APP_ENV_KEY = "DBX_TOOLS_DATABRICKS_APP_ENV";

/** Boolean environment override for project `.env` reads. */
export const CONFIG_DOTENV_KEY = "DBX_TOOLS_CONFIG_DOTENV";

/** Boolean environment override for Databricks bundle reads. */
export const CONFIG_BUNDLE_KEY = "DBX_TOOLS_CONFIG_BUNDLE";

/** Exact process-environment lookup for callers that do not read local config files. */
export const ENV_ONLY = { scope: [] as const, sources: "env" as const };

export const bundleValue = z
  .string()
  .transform((value: string) => value.trim())
  .refine((value: string) => value.length > 0)
  .refine((value: string) => !/\$\{[^}]+\}/.test(value), {
    message: "Interpolated values are not allowed",
  });

/**
 * The GENERIC shape of a bundle resource: a name, and whatever else the resource
 * type carries. Deliberately unopinionated and `passthrough()` - the concrete
 * resource kinds (`sql_warehouse`, `genie_space`, `postgres`, ...) are
 * Databricks-App concepts that belong to the package that resolves them, so
 * node-appkit `.extend()`s this rather than this module knowing about them.
 */
export const bundleResourceSchema = z.object({ name: bundleValue.optional() }).passthrough();

export const bundleEnvEntrySchema = z.object({
  name: bundleValue.optional(),
  value: z.string().optional(),
  value_from: bundleValue.optional(),
});

const bundleVariableSchema = z.object({
  default: z.string().optional(),
  value: z.string().optional(),
});

export const bundleAppSchema = z.object({
  name: bundleValue.optional(),
  source_code_path: z.string().optional(),
  config: z.object({ env: z.array(bundleEnvEntrySchema).optional() }).optional(),
  resources: z.array(bundleResourceSchema).optional(),
});

const bundleAppsSchema = z.object({
  resources: z.object({ apps: z.record(z.string(), bundleAppSchema).optional() }).optional(),
});

const bundleVariablesSchema = z.object({
  variables: z.record(z.string(), bundleVariableSchema).optional(),
});

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
  const appName = source.DATABRICKS_APP_NAME?.trim();
  const host = source.DATABRICKS_HOST?.trim();
  const port = source.DATABRICKS_APP_PORT?.trim();
  if (!appName || !host || !port) return false;
  try {
    if (!["http:", "https:"].includes(new URL(host).protocol)) return false;
  } catch {
    return false;
  }
  const portNumber = object.toNumber(port);
  return (
    portNumber !== undefined &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= MAX_TCP_PORT
  );
}

/** Candidate names in scope, prefix, and input precedence order. */
function keys(input: ConfigKey, options: Pick<ConfigOptions, "scope" | "prefix"> = {}): string[] {
  const scopes = object.sequence(options.scope ?? DEFAULT_SCOPE).toArray();
  const prefixes = options.prefix === undefined ? [] : object.sequence(options.prefix).toArray();
  return [
    ...object
      .sequence(input)
      .flatMap((key) => {
        const prefixed = prefixes.length > 0 ? prefixes.map((prefix) => join(prefix, key)) : [key];
        return [
          ...scopes.flatMap((scope) => prefixed.map((key) => join(scope, key))),
          ...prefixed,
          key,
        ];
      })
      .filter((key) => key.length > 0)
      .distinct(),
  ];
}

/**
 * Every value that resolves for `input`, in source-then-key precedence order,
 * as a LAZY sequence: nothing past the first consumed element is read, so
 * `values(key).first()` never spawns the Databricks CLI when the environment
 * already answered.
 *
 */
function values(input: ConfigKey, options: ConfigOptions = {}): object.Sequence<ConfigValue> {
  const candidates = keys(input, options);
  const sources = object.sequence<ConfigSource>(options.sources ?? DEFAULT_SOURCES);
  return object.sequence({
    *[Symbol.iterator](): Generator<ConfigValue> {
      for (const source of sources) {
        for (const map of read(source, options.cwd)) {
          for (const key of candidates) {
            const value = stringModule.trimToNull(map[key]);
            if (value !== null) yield { key, source, value };
          }
        }
      }
    },
  });
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
  const name = stringModule.trimToNull(nodeEnv)?.toLowerCase();
  if (!name || !/^[a-z0-9_-]+$/.test(name)) return [];
  for (const [canonical, alternatives] of Object.entries(NODE_ENV_ALTERNATIVES)) {
    const names: readonly string[] = alternatives;
    if (name === canonical || names.includes(name)) {
      return [...object.sequence(name, canonical, alternatives).distinct()];
    }
  }
  return [name];
}

function join(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("_");
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
  return stringModule.trimToNull(configured) ?? text(input, options);
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
  return toPositiveNumber(configured) ?? toPositiveNumber(text(input, options)) ?? fallback;
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
  const resolved = positiveNumber(configured, input, fallback, options);
  return Math.floor(resolved);
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
  const fromConfig = stringModule.parseList(configured, transform);
  return fromConfig.length > 0
    ? fromConfig
    : stringModule.parseList(text(input, options), transform);
}

function toPositiveNumber(value: unknown): number | undefined {
  const parsed = object.toNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

/**
 * The Databricks bundle output for `cwd` - `databricks bundle validate --output
 * json` run from the directory holding `databricks.yml`, with the config file's
 * path. A non-zero validation may still return partial JSON with usable
 * variables. `undefined` when bundle reads are disabled, there is no bundle, or
 * the CLI produces no JSON.
 *
 * Cached once per resolved working-directory context and
 * `DATABRICKS_CONFIG_PROFILE` through {@link context.cached}, so repeated
 * lookups do not rerun validation and changing either cannot return another
 * context's bundle.
 */
export function bundleFile(cwd?: string | null): ConfigFile | undefined {
  const production = process.env.NODE_ENV?.trim().toLowerCase() === "production";
  if (!fileSourceEnabled(CONFIG_BUNDLE_KEY, !production && !isDatabricksAppEnv())) return undefined;
  const profile = stringModule.trimToNull(process.env.DATABRICKS_CONFIG_PROFILE);
  return cachedConfig(["bundle", profile ?? ""], cwd, (resolved) =>
    loadBundleFile(resolved, profile),
  );
}

/**
 * The single App's literal `config.env` entries, flattened to `name -> value`.
 *
 * A `value_from` entry names a bundle resource whose id is known after
 * deployment, and reading it needs the resource vocabulary this module
 * deliberately does not have - node-appkit resolves those against its extended
 * {@link bundleResourceSchema}. An `apps` block with more than one app is
 * ambiguous (nothing here says which app this process is), so it yields nothing
 * rather than a guess.
 */
function bundleApp(input: unknown): Record<string, string> {
  const parsed = bundleAppsSchema.safeParse(input);
  if (!parsed.success) return {};
  const apps = parsed.data.resources?.apps;
  if (!apps) return {};
  const names = Object.keys(apps);
  if (names.length !== 1) return {};
  const entries = apps[names[0]!]?.config?.env ?? [];
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.name) continue;
    const value = resolvedString(entry.value);
    if (value !== null) result[entry.name] = value;
  }
  return result;
}

/**
 * Root bundle variables flattened to environment-style `NAME -> value` entries.
 *
 * `databricks bundle validate` resolves each variable to `value`; `default` is
 * retained as a fallback for parsed bundle data that has not been fully
 * resolved. Names are normalized so a bundle variable such as
 * `tunnel_public_domain` answers a lookup for `TUNNEL_PUBLIC_DOMAIN`.
 */
function bundleVariables(input: unknown): Record<string, string> {
  const parsed = bundleVariablesSchema.safeParse(input);
  if (!parsed.success) return {};
  const result: Record<string, string> = {};
  for (const [name, variable] of Object.entries(parsed.data.variables ?? {})) {
    const key = [...stringModule.tokenize(name)].join("_").toUpperCase();
    const value = resolvedString(variable.value) ?? resolvedString(variable.default);
    if (key && value !== null) result[key] = value;
  }
  return result;
}

/** A non-empty bundle value with every `${...}` interpolation resolved. */
function resolvedString(value: unknown): string | null {
  const parsed = bundleValue.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parsed `.env` for `cwd`, or `{}`. Read once per resolved context. */
function dotenv(cwd?: string | null): Record<string, string | undefined> {
  if (!fileSourceEnabled(CONFIG_DOTENV_KEY)) return {};
  const environments = nodeEnvNames(process.env.NODE_ENV);
  return cachedConfig(["dotenv", ...environments], cwd, (resolved) =>
    loadDotenv(resolved, environments),
  );
}

/** Cache every target directory separately within the active process context. */
function cachedConfig<T>(
  name: readonly string[],
  cwd: string | null | undefined,
  loader: (resolved: string) => T,
): T {
  const active = context.getContext() ?? "";
  const resolved = resolve(cwd ?? ".");
  return context.cached(["config", active, resolved, ...name], () => loader(resolved));
}

/**
 * Maps for one source in precedence order. Bundle App config and root variables
 * stay separate so a first-match lookup does not parse variables after an App
 * value resolves.
 */
function read(
  source: ConfigSource,
  cwd?: string,
): object.Sequence<Record<string, string | undefined>> {
  return object.sequence({
    *[Symbol.iterator](): Generator<Record<string, string | undefined>> {
      switch (source) {
        case "env":
          yield process.env;
          break;
        case "dotenv":
          yield dotenv(cwd);
          break;
        case "bundle": {
          const bundle = bundleFile(cwd);
          if (bundle) {
            yield bundleApp(bundle.data);
            yield bundleVariables(bundle.data);
          }
          break;
        }
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
      if (statSync(path)?.isFile()) return path;
    }
    if (boundary === undefined || dir === boundary) break;
  }
  return undefined;
}

/** A recognized source override, else the caller's automatic default. */
function fileSourceEnabled(key: string, fallback: boolean = !isDatabricksAppEnv()): boolean {
  return object.toBoolean(process.env[key]) ?? fallback;
}

function loadDotenv(
  cwd: string,
  environments: readonly string[],
): Record<string, string | undefined> {
  const names = [...environments.map((name) => `${DOTENV_FILE_NAME}.${name}`), DOTENV_FILE_NAME];
  const path = findConfigFile(cwd, names);
  if (!path) return {};
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    logger.warn("failed to read dotenv file", { path });
    return {};
  }
}

function loadBundleFile(cwd: string, profile: string | null): ConfigFile | undefined {
  const path = findConfigFile(cwd, BUNDLE_FILE_NAMES);
  if (!path) return undefined;
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
  const output = stringModule.trimToNull(result.stdout);
  const error = stringModule.trimToNull(result.stderr);
  if (output === null) {
    logger.debug("bundle validate produced no JSON", { path, status: result.status, error });
    return undefined;
  }
  const data = json.parseRecord(output);
  if (!data) {
    logger.warn("failed to parse bundle validate output", { path, status: result.status });
    return undefined;
  }
  if (result.status !== 0) {
    logger.debug("using partial bundle output", { path, status: result.status, error });
  }
  return { path, data };
}
