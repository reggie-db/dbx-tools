/**
 * DATABRICKS-APP configuration resolution: the bundle and `app.yaml` vocabulary.
 *
 * node-core's `config` module owns the generic lookup - environment, `.env`,
 * `databricks bundle validate` - and knows nothing about what a bundle resource
 * IS. That last part is this module: `sql_warehouse`, `genie_space`, and
 * `postgres` are Databricks-App concepts, and an `app.yaml` / bundle
 * `value_from` entry is a REFERENCE to one of them whose real value is the
 * warehouse id or Genie space id sitting on the named resource. So this module
 * extends node-core's resource schema, adds `app.yaml` (which the bundle CLI
 * never sees), and resolves those references.
 *
 * Default sources: `explicit`, then `env`, then Databricks App `config.env`
 * (from {@link bundle}) and hard-coded `app.yaml` env entries (from
 * {@link appYaml}). Opt in to `cli` when a dev command wants flag overrides.
 *
 * Server-only, and Databricks-app specific, so it lives in node-appkit rather
 * than node-core.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ValidationError } from "@databricks/appkit";
import { config as coreConfig, file, project } from "@dbx-tools/core";
import { context, object, log, string } from "@dbx-tools/shared-core";
import { parse as parseYamlText } from "yaml";
import { z } from "zod";

const logger = log.logger("config");

/** Parsed payload from `databricks bundle validate --output json`. */
export type BundleValidateJson = Record<string, unknown>;

/** A config file discovered on disk with its parsed contents. */
export type ConfigFile = coreConfig.ConfigFile;

/** Supported configuration sources, consulted in array order. */
export type ConfigSource = "explicit" | "cli" | "env" | "bundle";

const defaultConfigSources: ConfigSource[] = ["explicit", "env", "bundle"];

const APP_YAML_NAMES = ["app.yaml", "app.yml"] as const;

export const bundleAppResourceSchema = coreConfig.bundleResourceSchema.extend({
  sql_warehouse: z.object({ id: coreConfig.bundleValue.optional() }).optional(),
  genie_space: z.object({ space_id: coreConfig.bundleValue.optional() }).optional(),
  postgres: z
    .object({
      database: coreConfig.bundleValue.optional(),
      branch: coreConfig.bundleValue.optional(),
      endpoint: coreConfig.bundleValue.optional(),
    })
    .optional(),
});

const bundleAppSchema = coreConfig.bundleAppSchema.extend({
  resources: z.array(bundleAppResourceSchema).optional(),
});

const bundleValidateAppsSchema = z.object({
  resources: z.object({ apps: z.record(z.string(), bundleAppSchema).optional() }).optional(),
});

const appYamlEnvEntrySchema = coreConfig.bundleEnvEntrySchema.omit({ value_from: true }).extend({
  name: coreConfig.bundleValue,
  valueFrom: coreConfig.bundleValue.optional(),
});

const appYamlResourceSchema = coreConfig.bundleResourceSchema
  .extend({
    name: coreConfig.bundleValue,
    sql_warehouse: z.object({ id: coreConfig.bundleValue.optional() }).optional(),
    genie_space: z.object({ space_id: coreConfig.bundleValue.optional() }).optional(),
    postgres: z
      .object({
        database: coreConfig.bundleValue.optional(),
        branch: coreConfig.bundleValue.optional(),
        endpoint: coreConfig.bundleValue.optional(),
      })
      .optional(),
  })
  .passthrough();

const appYamlSchema = z.object({
  env: z.array(appYamlEnvEntrySchema).optional(),
  resources: z.array(appYamlResourceSchema).optional(),
});

type BundleApp = z.infer<typeof bundleAppSchema>;

/** Single config map entry (string or repeated values, like headers). */
export type ConfigMapValue = string | string[] | undefined;

export interface ResolveConfigValueOptions {
  /** Bundle validate JSON. Defaults to {@link bundle} (skipped inside a Databricks App). */
  bundleData?: ConfigFile;
  /** Parsed `app.yaml` contents. Defaults to {@link appYaml} (skipped inside a Databricks App). */
  appData?: ConfigFile;
  /**
   * Sources to consult, first truthy string wins. Defaults to `explicit`, then
   * `env`, then `bundle`.
   */
  sources?: ConfigSource[];
  /** Programmatic overrides. When set, `explicit` is prepended to `sources` unless already listed. */
  explicit?: Record<string, ConfigMapValue>;
  /** CLI flag values (when `cli` is listed in `sources`). */
  cli?: Record<string, ConfigMapValue>;
}

function envKeysForName(name: string): object.Sequence<string> {
  const trimmed = name.trim();
  if (!trimmed) {
    return object.sequence();
  }
  const keys = (function* () {
    const modifiers: (((value: string) => string) | null)[] = [
      null,
      () => trimmed.toUpperCase(),
      () => Array.from(string.tokenize(trimmed)).join("_").toUpperCase(),
    ];
    for (const modifier of modifiers) {
      yield modifier ? modifier(trimmed) : trimmed;
    }
  })();
  return object.sequence(keys).cache().filter(Boolean).distinct();
}

function readEnv(keys: Iterable<string>): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readConfigMapValue(value: ConfigMapValue): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const trimmed = item?.trim();
      if (trimmed) return trimmed;
    }
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readMap(
  keys: Iterable<string>,
  map: Record<string, ConfigMapValue> | undefined,
): string | undefined {
  if (!map) return undefined;
  for (const key of keys) {
    const value = readConfigMapValue(map[key]);
    if (value) return value;
  }
  return undefined;
}

function readAppEnv(keys: Iterable<string>, envMap: Record<string, string>): string | undefined {
  for (const key of keys) {
    const value = envMap[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseYaml(text: string): unknown {
  return parseYamlText(text);
}

function pickAppResourceId(apps: Record<string, BundleApp>): string | undefined {
  const keys = Object.keys(apps);
  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * Resolve the effective value a `value_from`/`valueFrom` entry points at:
 * the first present of the warehouse id, Genie space id, or Postgres
 * endpoint/database/branch on the named resource. Shared by both the
 * `app.yaml` and `bundle validate` flatteners, whose resource shapes match.
 */
function resolveResourceValue(
  resource: z.infer<typeof bundleAppResourceSchema> | undefined,
): string | undefined {
  return (
    resource?.sql_warehouse?.id ??
    resource?.genie_space?.space_id ??
    resource?.postgres?.endpoint ??
    resource?.postgres?.database ??
    resource?.postgres?.branch
  );
}

/**
 * Flatten `env` entries from parsed `app.yaml` content. Literal `value` entries
 * are returned as-is; `valueFrom` entries resolve against the sibling
 * `resources` array when possible.
 */
export function flattenAppYamlEnv(data: unknown): Record<string, string> {
  const parsed = appYamlSchema.safeParse(data);
  if (!parsed.success || !parsed.data.env?.length) {
    return {};
  }

  const resourceByName = new Map(
    (parsed.data.resources ?? []).map((resource) => [resource.name, resource]),
  );

  const out: Record<string, string> = {};
  for (const entry of parsed.data.env) {
    const value = coreConfig.bundleValue.safeParse(entry.value);
    if (value.success) {
      out[entry.name] = value.data;
      continue;
    }
    if (!entry.valueFrom) continue;
    const resolved = resolveResourceValue(resourceByName.get(entry.valueFrom));
    if (resolved) out[entry.name] = resolved;
  }
  return out;
}

/**
 * Flatten `resources.apps.<key>.config.env` into a `name -> value` map.
 * Auto-picks the app only when the bundle defines exactly one.
 */
export function flattenAppEnv(data: unknown): Record<string, string> {
  const parsed = bundleValidateAppsSchema.safeParse(data);
  if (!parsed.success) return {};

  const apps = parsed.data.resources?.apps;
  if (!apps || Object.keys(apps).length === 0) return {};

  const key = pickAppResourceId(apps);
  if (!key) return {};

  const app = apps[key];
  if (!app?.config?.env?.length) return {};

  const resourceByName = new Map(
    (app.resources ?? [])
      .filter((resource) => resource.name)
      .map((resource) => [resource.name!, resource]),
  );

  const out: Record<string, string> = {};
  for (const entry of app.config.env) {
    if (!entry.name) continue;
    const value = coreConfig.bundleValue.safeParse(entry.value);
    if (value.success) {
      out[entry.name] = value.data;
      continue;
    }
    if (!entry.value_from) continue;
    const resolved = resolveResourceValue(resourceByName.get(entry.value_from));
    if (resolved) out[entry.name] = resolved;
  }
  return out;
}

async function loadAppYaml(cwd: string): Promise<ConfigFile | undefined> {
  for (const fileName of APP_YAML_NAMES) {
    const configFile = resolveConfigFile(cwd, fileName);
    if (!configFile) continue;
    try {
      const text = await readFile(configFile, "utf8");
      const data = parseYaml(text);
      if (!object.isRecord(data)) {
        return undefined;
      }
      return { path: configFile, data };
    } catch {
      logger.warn("failed to parse app yaml", { path: configFile });
    }
  }
  return undefined;
}

function resolveConfigFile(cwd: string, configFile: string): string | undefined {
  if (coreConfig.isDatabricksAppEnv()) return undefined;
  for (const rootDir of project.resolveProjectRoots(cwd)) {
    const bundlePath = resolve(rootDir, configFile);
    if (file.statSync(bundlePath)?.isFile()) return bundlePath;
  }
  return undefined;
}

/**
 * The validated bundle for `cwd` - {@link coreConfig.bundleFile}, which caches it
 * per working directory. Returns `undefined` inside a Databricks App, where the
 * platform has already turned `config.env` into real environment variables and
 * there is no bundle to validate.
 */
export function bundle(cwd?: string): Promise<ConfigFile | undefined> {
  return Promise.resolve(coreConfig.isDatabricksAppEnv() ? undefined : coreConfig.bundleFile(cwd));
}

/**
 * Locate and parse `app.yaml` / `app.yml` from the bundle or project root.
 * Cached per working directory through {@link context.cached}, so a `cwd` change
 * re-reads instead of returning another project's file. Returns `undefined`
 * inside a Databricks App.
 */
export function appYaml(cwd?: string): Promise<ConfigFile | undefined> {
  if (coreConfig.isDatabricksAppEnv()) return Promise.resolve(undefined);
  return context.cached(["appkit", "appYaml"], (resolved) => loadAppYaml(resolved ?? "."), cwd);
}

/**
 * Walk a dot-separated path through bundle validate JSON. When the terminal
 * node is a bundle variable object (`{ value: "..." }`), the `value` field is
 * returned.
 */
export function getBundlePath(data: BundleValidateJson, path: string): string | undefined {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return undefined;

  let current: unknown = data;
  for (let i = 0; i < parts.length; i++) {
    if (!object.isRecord(current)) return undefined;
    const part = parts[i]!;
    const next = current[part];
    if (i === parts.length - 1) {
      if (typeof next === "string" && next) return next;
      if (object.isRecord(next)) {
        const value = next.value;
        return typeof value === "string" && value ? value : undefined;
      }
      return undefined;
    }
    current = next;
  }
  return undefined;
}

async function resolveAppEnvMap(
  options: ResolveConfigValueOptions,
): Promise<Record<string, string>> {
  const appData = options.appData ?? (await appYaml());
  const bundleData = options.bundleData ?? (await bundle());
  const fromYaml = appData ? flattenAppYamlEnv(appData.data) : {};
  const fromBundle = bundleData ? flattenAppEnv(bundleData.data) : {};
  return { ...fromYaml, ...fromBundle };
}

function resolveSources(options: ResolveConfigValueOptions): ConfigSource[] {
  const sources = [...(options.sources ?? defaultConfigSources)];
  if (options.explicit !== undefined && !sources.includes("explicit")) {
    sources.unshift("explicit");
  }
  return sources;
}

/**
 * Resolve a configuration string from the configured sources. Returns the first
 * non-empty value, or `undefined` when nothing matches.
 *
 * Precedence follows AppKit's: explicit config, then environment variable, then
 * whatever the Databricks App / bundle definition supplies.
 *
 * @example
 * import { bundle } from "@dbx-tools/appkit";
 *
 * const warehouseId = await bundle.resolveConfigValue("DATABRICKS_WAREHOUSE_ID", {
 *   cli: { DATABRICKS_WAREHOUSE_ID: flags.warehouse },
 *   sources: bundle.withCliSources(),
 * });
 */
export async function resolveConfigValue(
  name: string,
  options: ResolveConfigValueOptions = {},
): Promise<string | undefined> {
  const keys = envKeysForName(name).toArray();
  if (keys.length === 0) return undefined;
  const sources = resolveSources(options);
  let appEnvMap: Record<string, string> | undefined;
  const values = (async function* () {
    for (const source of sources) {
      switch (source) {
        case "explicit":
          yield readMap(keys, options.explicit);
          break;
        case "cli":
          yield readMap(keys, options.cli);
          break;
        case "env":
          yield readEnv(keys);
          break;
        case "bundle":
          if (appEnvMap === undefined) appEnvMap = await resolveAppEnvMap(options);
          yield readAppEnv(keys, appEnvMap);
          break;
        default:
          throw ValidationError.invalidValue(
            "sources",
            source,
            "one of: explicit, cli, env, bundle",
          );
      }
    }
  })();
  for await (const value of values) {
    if (value) return value;
  }
  return undefined;
}

/**
 * Sources with `cli` included, in CLI-first order. Use for dev commands that
 * accept flag overrides.
 */
export function withCliSources(sources: ConfigSource[] = defaultConfigSources): ConfigSource[] {
  const rest = sources.filter((source) => source !== "cli" && source !== "explicit");
  return ["cli", "explicit", ...rest];
}
