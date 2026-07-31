/**
 * Configuration for the AI Search plugin: the typed
 * {@link SearchPluginConfig} (the plugin's slice of AppKit config), the JSON
 * Schema the manifest publishes for it, and {@link resolveSearchConfig}
 * which layers that config over environment defaults into the concrete
 * {@link ResolvedSearchConfig} the runtime, client, tools, and routes read.
 *
 * The design goal is "one index, zero config": name a default index (or set
 * `DATABRICKS_VECTOR_SEARCH_INDEX`) and everything else - the columns to
 * return, the page size, the match mode, the mounted route path, the embedding
 * model used when creating an index - has a sensible default that can be
 * overridden when a deployment needs to go deeper.
 *
 * Which index / endpoint is used follows the standard precedence: explicit
 * plugin config, then environment, then a default.
 *
 * Env fallbacks: `DATABRICKS_VECTOR_SEARCH_INDEX` (the default index),
 * `SEARCH_INDEX`, `SEARCH_ENDPOINT`, `SEARCH_COLUMNS`,
 * `SEARCH_PAGE_SIZE`, `SEARCH_MODE`, `SEARCH_EMBEDDING_MODEL`,
 * `SEARCH_TIMEOUT_MS`, `SEARCH_WRITE`.
 *
 * @module
 */

import { ConfigurationError, type BasePluginConfig } from "@databricks/appkit";
import type { SearchDocument, SearchMode } from "@dbx-tools/shared-search";
import { object, string } from "@dbx-tools/shared-core";
import type { JSONSchema7 } from "json-schema";

/** The default index, honoring AppKit's standard Vector Search binding name. */
export const INDEX_ENV = "SEARCH_INDEX";

/** AppKit's standard environment name for a Vector Search index binding. */
export const DATABRICKS_INDEX_ENV = "DATABRICKS_VECTOR_SEARCH_INDEX";

/** Dedicated override for the Vector Search serving endpoint that hosts indexes. */
export const ENDPOINT_ENV = "SEARCH_ENDPOINT";

/** Default match mode when a request does not name one. Hybrid suits most search boxes. */
export const DEFAULT_MODE: SearchMode = "hybrid";

/** Default number of hits a search returns (a good autocomplete / results-list size). */
export const DEFAULT_PAGE_SIZE = 10;

/** Default per-call timeout for a search / index operation. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Base path the plugin mounts its routes under, unless overridden. */
export const DEFAULT_BASE_PATH = "/api/search";

/**
 * A configured index the plugin knows about ahead of time. Only `name` (or
 * `alias`) is required; the rest is resolved from the live index definition
 * when omitted, so a deployment can register `{ name }` and let the plugin fill
 * in the primary key and columns.
 */
export interface SearchIndexConfig {
  /** Unity Catalog name of the index (catalog.schema.index). */
  name: string;
  /** Short alias a caller may use in place of `name` (defaults to the last name segment). */
  alias?: string;
  /** Primary-key column. Resolved from the index definition when omitted. */
  primaryKey?: string;
  /** Columns to return per hit, in display order. Defaults to every indexed column. */
  columns?: string[];
}

/**
 * The AI Search plugin's slice of AppKit config. Every field is optional - the
 * plugin works with nothing but an index name in the environment.
 */
export interface SearchPluginConfig extends BasePluginConfig {
  /** The default index searched when a request omits one (name or alias). */
  index?: string;
  /** Indexes the plugin should know about (for aliases, universal search, and the UI catalogue). */
  indexes?: Array<string | SearchIndexConfig>;
  /** The Vector Search serving endpoint indexes live on (only needed to create an index). */
  endpoint?: string;
  /** Default columns to return per hit. Falls back to each index's own columns. */
  columns?: string[];
  /** Default number of hits a search returns. */
  pageSize?: number;
  /** Default match mode. */
  mode?: SearchMode;
  /** Embedding model endpoint used when the plugin CREATES a Delta Sync index. Fuzzy-resolved. */
  embeddingModel?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
  /** Enable the write surface (`add_documents` tool + `POST /documents`). Off by default. */
  allowWrite?: boolean;
  /**
   * Provision a REAL index at boot: ensure the endpoint + index exist and seed
   * documents when the index is empty. Runs in the background during `setup()`
   * (a slow first-time endpoint/index build never blocks the server) using the
   * boot-time SDK auth (env / config profile). Idempotent - safe every boot.
   *
   * The default is a MANAGED direct-access index (Databricks embeds the text
   * column), so `documents` are plain rows and search-by-text works with no
   * Delta table, no warehouse, and no vectors to compute. Point it at a
   * `sourceTable` to provision a Delta Sync index instead.
   */
  ensureOnSetup?: EnsureOnSetupConfig;
}

/** Boot-time provisioning + seeding for a single index (see `ensureOnSetup`). */
export interface EnsureOnSetupConfig {
  /** UC name of the index to ensure (catalog.schema.index). Defaults to the plugin's `index`. */
  index?: string;
  /** Vector Search endpoint to host it on. Defaults to the plugin's `endpoint`. */
  endpoint?: string;
  /** Primary-key column. Defaults to `id`. */
  primaryKey?: string;
  /** Text column Databricks embeds (managed direct-access). Defaults to `text`. */
  textColumn?: string;
  /** Embedding model endpoint. Fuzzy-matched; defaults to the best embedding endpoint. */
  embeddingModel?: string;
  /** For a Delta Sync index instead of managed direct-access: the source Delta table. */
  sourceTable?: string;
  /** Column -> type map for the managed direct-access `schema_json`. Inferred from `documents` when omitted. */
  schema?: Record<string, string>;
  /** Documents to seed when the index is empty. Plain `{ id, text, ... }` rows for a managed index. */
  documents?: SearchDocument[];
  /** Max time to wait for endpoint + index readiness. Defaults to 20 minutes. */
  timeoutMs?: number;
}

/** A fully resolved index entry (the plugin-known form). */
export interface ResolvedIndexConfig {
  name: string;
  alias: string;
  primaryKey?: string;
  columns?: string[];
}

/** The concrete config the runtime, client, tools, and routes read. */
export interface ResolvedSearchConfig {
  defaultIndex?: string;
  indexes: ResolvedIndexConfig[];
  endpoint?: string;
  columns?: string[];
  pageSize: number;
  mode: SearchMode;
  embeddingModel?: string;
  basePath: string;
  timeoutMs: number;
  allowWrite: boolean;
  ensureOnSetup?: EnsureOnSetupConfig;
}

/** JSON Schema the plugin manifest publishes for {@link SearchPluginConfig}. */
export const SEARCH_CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: true,
  properties: {
    index: {
      type: "string",
      description: "Default index to search (catalog.schema.index or a configured alias).",
    },
    indexes: {
      type: "array",
      description: "Indexes the plugin knows about, for aliases, universal search, and the UI.",
      items: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              alias: { type: "string" },
              primaryKey: { type: "string" },
              columns: { type: "array", items: { type: "string" } },
            },
          },
        ],
      },
    },
    endpoint: {
      type: "string",
      description: "Vector Search serving endpoint indexes live on (needed only to create one).",
    },
    columns: {
      type: "array",
      items: { type: "string" },
      description: "Default columns to return.",
    },
    pageSize: { type: "number", description: "Default number of hits per search." },
    mode: { enum: ["hybrid", "vector", "keyword"], description: "Default match mode." },
    embeddingModel: {
      type: "string",
      description: "Embedding endpoint used when creating a Delta Sync index (fuzzy-matched).",
    },
    timeoutMs: { type: "number", description: "Per-call timeout in milliseconds." },
    allowWrite: {
      type: "boolean",
      description: "Enable the document write surface (add_documents tool + route).",
    },
    ensureOnSetup: {
      type: "object",
      description:
        "Provision a real index at boot: ensure the endpoint + index exist and seed " +
        "documents when empty. Runs in the background during setup using boot-time auth.",
      additionalProperties: true,
      properties: {
        index: { type: "string" },
        endpoint: { type: "string" },
        primaryKey: { type: "string" },
        textColumn: { type: "string" },
        embeddingModel: { type: "string" },
        sourceTable: { type: "string" },
        schema: { type: "object", additionalProperties: { type: "string" } },
        documents: { type: "array", items: { type: "object", additionalProperties: true } },
        timeoutMs: { type: "number" },
      },
    },
  },
};

/** Derive the default alias for an index name (its last dotted segment). */
export function defaultAlias(name: string): string {
  const segments = name.split(".").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : name;
}

/** Normalize a config index entry (string or object) into a {@link ResolvedIndexConfig}. */
function toResolvedIndex(entry: string | SearchIndexConfig): ResolvedIndexConfig | null {
  const raw = typeof entry === "string" ? { name: entry } : entry;
  const name = string.trimToNull(raw.name);
  if (name === null) return null;
  return {
    name,
    alias: string.trimToNull(raw.alias) ?? defaultAlias(name),
    ...(raw.primaryKey ? { primaryKey: raw.primaryKey } : {}),
    ...(raw.columns && raw.columns.length > 0 ? { columns: [...raw.columns] } : {}),
  };
}

/** Coerce a positive integer from config or an env var, falling back to a default. */
function resolvePositiveInt(
  configured: number | undefined,
  envVar: string,
  fallback: number,
): number {
  const raw = configured ?? Number(process.env[envVar]);
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

/** Parse and validate a {@link SearchMode} from config or an env var. */
function resolveMode(configured: SearchMode | undefined): SearchMode {
  const raw = configured ?? string.trimToNull(process.env.SEARCH_MODE) ?? undefined;
  if (raw === undefined) return DEFAULT_MODE;
  if (raw !== "hybrid" && raw !== "vector" && raw !== "keyword") {
    throw new ConfigurationError(
      'mode must be "hybrid", "vector" or "keyword" (env: SEARCH_MODE)',
      { context: { field: "mode", envVar: "SEARCH_MODE" } },
    );
  }
  return raw;
}

/**
 * Resolve plugin config over environment defaults into the concrete
 * {@link ResolvedSearchConfig}. The default index is unioned into the known
 * indexes so it always appears in the catalogue, aliases are de-duplicated,
 * and a bad mode throws a {@link ConfigurationError} naming the field.
 */
export function resolveSearchConfig(config: SearchPluginConfig = {}): ResolvedSearchConfig {
  const defaultIndexRaw =
    string.trimToNull(config.index) ??
    string.trimToNull(process.env[INDEX_ENV]) ??
    string.trimToNull(process.env[DATABRICKS_INDEX_ENV]) ??
    undefined;

  const configured = (config.indexes ?? [])
    .map(toResolvedIndex)
    .filter((entry): entry is ResolvedIndexConfig => entry !== null);

  // Ensure the default index is represented in the known set.
  if (defaultIndexRaw && !configured.some((i) => i.name === defaultIndexRaw)) {
    const fromEnv = string.parseList(process.env.SEARCH_COLUMNS);
    configured.unshift({
      name: defaultIndexRaw,
      alias: defaultAlias(defaultIndexRaw),
      ...(fromEnv.length > 0 ? { columns: fromEnv } : {}),
    });
  }

  const seenAliases = new Set<string>();
  const indexes = configured.map((entry) => {
    let alias = entry.alias;
    while (seenAliases.has(alias)) alias = `${alias}_`;
    seenAliases.add(alias);
    return { ...entry, alias };
  });

  const defaultIndex = defaultIndexRaw ?? indexes[0]?.name;
  const columns = config.columns ?? string.parseList(process.env.SEARCH_COLUMNS);

  return {
    ...(defaultIndex ? { defaultIndex } : {}),
    indexes,
    ...((string.trimToNull(config.endpoint) ?? string.trimToNull(process.env[ENDPOINT_ENV]))
      ? {
          endpoint:
            string.trimToNull(config.endpoint) ??
            string.trimToNull(process.env[ENDPOINT_ENV]) ??
            undefined,
        }
      : {}),
    ...(columns.length > 0 ? { columns } : {}),
    pageSize: resolvePositiveInt(config.pageSize, "SEARCH_PAGE_SIZE", DEFAULT_PAGE_SIZE),
    mode: resolveMode(config.mode),
    ...((string.trimToNull(config.embeddingModel) ??
    string.trimToNull(process.env.SEARCH_EMBEDDING_MODEL))
      ? {
          embeddingModel:
            string.trimToNull(config.embeddingModel) ??
            string.trimToNull(process.env.SEARCH_EMBEDDING_MODEL) ??
            undefined,
        }
      : {}),
    basePath: DEFAULT_BASE_PATH,
    timeoutMs: resolvePositiveInt(config.timeoutMs, "SEARCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    allowWrite: config.allowWrite ?? object.toBoolean(process.env.SEARCH_WRITE) ?? false,
    ...(config.ensureOnSetup ? { ensureOnSetup: config.ensureOnSetup } : {}),
  };
}

/**
 * Resolve a caller-supplied index reference (a full UC name or a configured
 * alias) into a concrete index name. Falls back to the default index when the
 * reference is empty. Returns `null` when nothing can be resolved so callers
 * raise a stable, user-facing error rather than calling a phantom index.
 */
export function resolveIndexName(
  config: ResolvedSearchConfig,
  reference: string | undefined,
): string | null {
  const ref = string.trimToNull(reference);
  if (ref === null) return config.defaultIndex ?? null;
  const byAlias = config.indexes.find((i) => i.alias === ref || i.name === ref);
  if (byAlias) return byAlias.name;
  // Accept an unregistered but fully-qualified UC name (three dotted parts).
  if (ref.split(".").filter(Boolean).length === 3) return ref;
  return config.defaultIndex ?? null;
}

/** The known config for an index name, when the plugin was told about it. */
export function indexConfigFor(
  config: ResolvedSearchConfig,
  name: string,
): ResolvedIndexConfig | undefined {
  return config.indexes.find((i) => i.name === name || i.alias === name);
}
