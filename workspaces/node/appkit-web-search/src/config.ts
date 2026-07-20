/**
 * Configuration for the web-search plugin: the typed
 * {@link WebSearchPluginConfig} (the plugin's slice of AppKit config), the
 * JSON Schema the manifest publishes for it, and {@link resolveWebSearchConfig}
 * which layers that config over environment defaults into the concrete
 * {@link ResolvedWebSearchConfig} the runtime + tools read.
 *
 * `web_search` runs on the Databricks Model Serving native web-search tool
 * (see `provider.ts` / `search.ts`), so the key knob is which web-search-
 * capable model to use. It resolves independently of the calling agent's chat
 * model: `model` (a name, loose name, or capability class) is fuzzy-matched
 * against the workspace catalogue, and when nothing is pinned the
 * {@link WebSearchPluginConfig.modelFallbacks} order (Gemini, then GPT, then a
 * repo floor) picks the first web-search-capable endpoint that exists.
 *
 * Resolution never throws here; it just fills defaults. Precedence per field:
 * explicit plugin config wins, then the matching environment variable, then a
 * built-in default.
 *
 * Env fallbacks: `WEB_SEARCH_MODEL`, `WEB_SEARCH_MODEL_FALLBACKS`,
 * `WEB_SEARCH_TOOLS` (JSON), `WEB_SEARCH_ALLOWED_URLS`,
 * `WEB_SEARCH_MAX_CITATIONS`, `WEB_SEARCH_FETCH_MAX_LENGTH`,
 * `WEB_SEARCH_TIMEOUT_MS`, `WEB_SEARCH_FUZZY`, `WEB_SEARCH_FUZZY_THRESHOLD`.
 *
 * @module
 */

import type { BasePluginConfig } from "@databricks/appkit";
import { object, type OneOrMany } from "@dbx-tools/shared-core";
import type { JSONSchema7 } from "json-schema";
import { parseAllowedUrls, toUrlAllowList, type UrlAllowList } from "./allowlist";

/**
 * A URL-pattern gate for per-tool approval. `true` gates every call; a
 * pattern (or list of patterns, in the {@link OneOrMany} shape used across
 * the repo) gates only calls whose URL matches. Patterns use the same glob
 * syntax as the allow-list (see `allowlist.ts`). Omit / `false` for no
 * approval.
 */
export type ApprovalGate = boolean | OneOrMany<string> | string;

/**
 * Default web-search model preference, tried in order when no model is
 * pinned. Gemini first, then GPT - both support the native web-search tool;
 * a workspace typically has at least one. Each is fuzzy-matched against the
 * live catalogue, so a close variant (e.g. `databricks-gemini-3-1-pro`) is
 * picked when the exact id isn't present.
 */
export const DEFAULT_MODEL_FALLBACKS: readonly string[] = [
  "databricks-gemini-3-pro",
  "databricks-gemini-2-5-pro",
  "databricks-gpt-5",
  "databricks-gpt-5-mini",
];

/** Default cap on the number of citations returned from a single search. */
export const DEFAULT_MAX_CITATIONS = 10;

/** Default cap on characters returned from a single `web_fetch`. */
export const DEFAULT_FETCH_MAX_LENGTH = 50_000;

/** Default per-request network timeout (ms) for search + fetch. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** AppKit config accepted by the web-search plugin. */
export interface WebSearchPluginConfig extends BasePluginConfig {
  /**
   * The web-search model to use by default: a Databricks serving endpoint
   * name (`"databricks-gemini-3-pro"`), a loose name (`"gemini"`, `"gpt"`),
   * or a capability class. Fuzzy-matched against the live catalogue. Falls
   * back to `WEB_SEARCH_MODEL`, then the {@link modelFallbacks} order. Chosen
   * independently of the calling agent's chat model.
   */
  model?: string;
  /**
   * Priority-ordered web-search model candidates tried when {@link model} is
   * unset, each fuzzy-matched and checked for web-search support. Falls back
   * to `WEB_SEARCH_MODEL_FALLBACKS` (comma/space-separated), then
   * {@link DEFAULT_MODEL_FALLBACKS} (Gemini, then GPT).
   */
  modelFallbacks?: string | string[];
  /**
   * Provider -> tool-spec override map, merged over the built-in
   * {@link WEB_SEARCH_PROVIDERS} defaults. Keyed by provider family
   * (`"openai"`, `"gemini"`); each value may override the `tool` entry
   * and/or the `api` surface. Use to change the tool shape as the platform
   * evolves without a code change. Falls back to `WEB_SEARCH_TOOLS` parsed as
   * JSON. This is the `WEB_SEARCH_TOOLS` setting.
   */
  webSearchTools?: Record<string, unknown>;
  /**
   * Enable fuzzy matching of loose model names against the catalogue.
   * Defaults to `true`; falls back to `WEB_SEARCH_FUZZY`.
   */
  modelFuzzyMatch?: boolean;
  /** Fuse.js fuzzy threshold. Falls back to `WEB_SEARCH_FUZZY_THRESHOLD`, then 0.4. */
  modelFuzzyThreshold?: number;
  /**
   * Hard cap on the number of citations a single search returns. Falls back
   * to `WEB_SEARCH_MAX_CITATIONS`, then {@link DEFAULT_MAX_CITATIONS}.
   */
  maxCitations?: number;
  /**
   * Hard cap on the character length of a single `web_fetch` result. Falls
   * back to `WEB_SEARCH_FETCH_MAX_LENGTH`, then {@link DEFAULT_FETCH_MAX_LENGTH}.
   */
  fetchMaxLength?: number;
  /**
   * Per-request network timeout in ms for search + fetch. Falls back to
   * `WEB_SEARCH_TIMEOUT_MS`, then {@link DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * Optional URL allow-list. Each entry is a glob (or bare host) tested
   * against a URL's full `href`. When set, `web_search` silently filters
   * citations to the permitted set and `web_fetch` refuses a disallowed URL.
   * Accepts a `string[]` or a comma-/whitespace-separated string; falls back
   * to `WEB_SEARCH_ALLOWED_URLS`. Omit (or leave empty) for no restriction.
   * See `allowlist.ts`.
   */
  allowedUrls?: string | string[];
  /**
   * Approval gate applied to BOTH tools (per-tool overrides via
   * {@link WebSearchToolOptions.approval} win). `true` gates every call;
   * a URL-pattern (or list) gates only matching calls. Omit for no approval.
   */
  approval?: ApprovalGate;
}

/** Concrete, validated config the runtime + tools read. */
export interface ResolvedWebSearchConfig {
  /** Pinned web-search model, when configured (else undefined - use fallbacks). */
  model?: string;
  /** Ordered fallback model candidates (Gemini, then GPT, then a floor). */
  modelFallbacks: readonly string[];
  /** Provider -> tool-spec override map, merged over the built-in defaults. */
  webSearchTools: Record<string, unknown>;
  /** Whether to fuzzy-match loose model names. */
  fuzzy: boolean;
  /** Fuse.js fuzzy threshold. */
  fuzzyThreshold: number;
  maxCitations: number;
  fetchMaxLength: number;
  timeoutMs: number;
  /** Compiled allow-list (permit-all when unconfigured). */
  allowList: UrlAllowList;
  /** Default per-tool approval gate. */
  approval: ApprovalGate;
}

/** JSON Schema published on the manifest's `config.schema`. */
export const WEB_SEARCH_CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    model: {
      type: "string",
      description:
        "Default web-search model (endpoint name, loose name, or class). Fuzzy-matched. Env: WEB_SEARCH_MODEL.",
    },
    modelFallbacks: {
      type: "array",
      items: { type: "string" },
      description:
        "Ordered web-search model candidates when `model` is unset (Gemini, then GPT). Env: WEB_SEARCH_MODEL_FALLBACKS.",
    },
    webSearchTools: {
      type: "object",
      description:
        'Provider -> tool-spec override map merged over the built-in defaults (openai -> {"type":"web_search"}, gemini -> {"google_search":{}}). Env: WEB_SEARCH_TOOLS (JSON).',
    },
    maxCitations: {
      type: "number",
      description: "Hard cap on citations returned (env: WEB_SEARCH_MAX_CITATIONS).",
    },
    fetchMaxLength: {
      type: "number",
      description: "Hard cap on web_fetch content length (env: WEB_SEARCH_FETCH_MAX_LENGTH).",
    },
    timeoutMs: {
      type: "number",
      description: "Per-request network timeout in ms (env: WEB_SEARCH_TIMEOUT_MS).",
    },
    allowedUrls: {
      type: "array",
      items: { type: "string" },
      description:
        'URL allow-list of globs / bare hosts (e.g. "*.databricks.com", "docs.example.com"). Also accepts a comma/space-separated string. Falls back to WEB_SEARCH_ALLOWED_URLS. Empty = unrestricted.',
    },
  },
};

/** Split a CSV / whitespace / array value into a trimmed, non-empty string list. */
function toStringList(raw: string | string[] | undefined): string[] {
  const entries = typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : [];
  return [
    ...object
      .sequence(entries)
      .map((e) => e.trim())
      .filter((e) => e.length > 0)
      .distinct()
      .toArray(),
  ];
}

/** Parse a positive integer env/config value, else the fallback. */
function resolvePositiveInt(value: number | undefined, envKey: string, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const env = Number(process.env[envKey]);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : fallback;
}

/** Parse the `WEB_SEARCH_TOOLS` env var (JSON), else `{}`. Bad JSON is ignored. */
function parseToolsEnv(): Record<string, unknown> {
  const raw = process.env["WEB_SEARCH_TOOLS"];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve plugin config over environment defaults into the concrete
 * {@link ResolvedWebSearchConfig}. Never throws - the model is resolved
 * lazily at call time (against the live catalogue), so an unconfigured plugin
 * resolves to sensible defaults with no restrictions.
 */
export function resolveWebSearchConfig(
  config: WebSearchPluginConfig = {},
): ResolvedWebSearchConfig {
  const patterns = parseAllowedUrls(config.allowedUrls ?? process.env["WEB_SEARCH_ALLOWED_URLS"]);
  const model = config.model ?? process.env["WEB_SEARCH_MODEL"];
  const fallbacks = toStringList(config.modelFallbacks ?? process.env["WEB_SEARCH_MODEL_FALLBACKS"]);
  const fuzzyThresholdRaw = config.modelFuzzyThreshold ?? Number(process.env["WEB_SEARCH_FUZZY_THRESHOLD"]);
  return {
    ...(model ? { model } : {}),
    modelFallbacks: fallbacks.length > 0 ? fallbacks : DEFAULT_MODEL_FALLBACKS,
    webSearchTools: { ...parseToolsEnv(), ...(config.webSearchTools ?? {}) },
    fuzzy:
      config.modelFuzzyMatch ?? object.toBoolean(process.env["WEB_SEARCH_FUZZY"]) ?? true,
    fuzzyThreshold: Number.isFinite(fuzzyThresholdRaw) && fuzzyThresholdRaw ? Number(fuzzyThresholdRaw) : 0.4,
    maxCitations: resolvePositiveInt(config.maxCitations, "WEB_SEARCH_MAX_CITATIONS", DEFAULT_MAX_CITATIONS),
    fetchMaxLength: resolvePositiveInt(
      config.fetchMaxLength,
      "WEB_SEARCH_FETCH_MAX_LENGTH",
      DEFAULT_FETCH_MAX_LENGTH,
    ),
    timeoutMs: resolvePositiveInt(config.timeoutMs, "WEB_SEARCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    allowList: toUrlAllowList(patterns),
    approval: config.approval ?? false,
  };
}

/**
 * Resolve an {@link ApprovalGate} against a set of candidate URLs into a
 * concrete boolean: `true`/`false` pass through; a pattern (or list) gates
 * when ANY candidate matches. Empty candidates with a pattern gate never
 * match (nothing to approve). Reuses the allow-list matcher so approval
 * globs read exactly like allow-list globs.
 */
export function approvalMatches(gate: ApprovalGate, urls: readonly string[]): boolean {
  if (typeof gate === "boolean") return gate;
  const patterns = parseAllowedUrls(typeof gate === "string" ? gate : [...gate]);
  if (patterns.length === 0) return false;
  const list = toUrlAllowList(patterns);
  return urls.some((url) => list.allows(url));
}
