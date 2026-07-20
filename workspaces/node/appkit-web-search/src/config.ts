/**
 * Configuration for the web-search plugin: the typed
 * {@link WebSearchPluginConfig} (the plugin's slice of AppKit config), the
 * JSON Schema the manifest publishes for it, and {@link resolveWebSearchConfig}
 * which layers that config over environment defaults into the concrete
 * {@link ResolvedWebSearchConfig} the runtime + tools read.
 *
 * Unlike the email add-on there are no credentials to resolve - the backend
 * (duck-duck-scrape) needs no API key - so resolution never throws; it just
 * fills defaults. Precedence per field: explicit plugin config wins, then the
 * matching environment variable, then a built-in default.
 *
 * Env fallbacks: `WEB_SEARCH_SAFE_SEARCH`, `WEB_SEARCH_REGION`,
 * `WEB_SEARCH_MAX_RESULTS`, `WEB_SEARCH_ALLOWED_URLS`,
 * `WEB_SEARCH_FETCH_MAX_LENGTH`, `WEB_SEARCH_TIMEOUT_MS`.
 *
 * @module
 */

import type { BasePluginConfig } from "@databricks/appkit";
import type { OneOrMany } from "@dbx-tools/shared-core";
import type { JSONSchema7 } from "json-schema";
import { parseAllowedUrls, toUrlAllowList, type UrlAllowList } from "./allowlist";
import type { SafeSearch } from "./schema";

/**
 * A URL-pattern gate for per-tool approval. `true` gates every call; a
 * pattern (or list of patterns, in the {@link OneOrMany} shape used across
 * the repo) gates only calls whose URL matches - a search is gated when ANY
 * result URL matches, a fetch when its target URL matches. Patterns use the
 * same glob syntax as the allow-list (see `allowlist.ts`). Omit / `false`
 * for no approval.
 */
export type ApprovalGate = boolean | OneOrMany<string> | string;

/** Default cap on results returned from a single `web_search`. */
export const DEFAULT_MAX_RESULTS = 10;

/** Default cap on characters returned from a single `web_fetch`. */
export const DEFAULT_FETCH_MAX_LENGTH = 50_000;

/** Default per-request network timeout (ms) for search + fetch. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** AppKit config accepted by the web-search plugin. */
export interface WebSearchPluginConfig extends BasePluginConfig {
  /**
   * Default safe-search strength for `web_search` when the model doesn't
   * specify one. Falls back to `WEB_SEARCH_SAFE_SEARCH`, then `"moderate"`.
   */
  safeSearch?: SafeSearch;
  /**
   * Default result region/locale (e.g. `"us-en"`, `"wt-wt"`). Falls back to
   * `WEB_SEARCH_REGION`, then `"wt-wt"` (any region).
   */
  region?: string;
  /**
   * Hard cap on the number of results a single `web_search` returns,
   * regardless of what the model requests. Falls back to
   * `WEB_SEARCH_MAX_RESULTS`, then {@link DEFAULT_MAX_RESULTS}.
   */
  maxResults?: number;
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
   * results to the permitted set and `web_fetch` refuses a disallowed URL.
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
  safeSearch: SafeSearch;
  region: string;
  maxResults: number;
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
    safeSearch: {
      type: "string",
      enum: ["strict", "moderate", "off"],
      description: "Default safe-search strength (env: WEB_SEARCH_SAFE_SEARCH).",
    },
    region: {
      type: "string",
      description: 'Default result region/locale, e.g. "us-en" (env: WEB_SEARCH_REGION).',
    },
    maxResults: {
      type: "number",
      description: "Hard cap on web_search results (env: WEB_SEARCH_MAX_RESULTS).",
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

/** Map the friendly {@link SafeSearch} enum to itself, defaulting safely. */
function resolveSafeSearch(value: SafeSearch | undefined): SafeSearch {
  const raw = value ?? (process.env["WEB_SEARCH_SAFE_SEARCH"] as SafeSearch | undefined);
  return raw === "strict" || raw === "off" ? raw : "moderate";
}

/** Parse a positive integer env/config value, else the fallback. */
function resolvePositiveInt(value: number | undefined, envKey: string, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const env = Number(process.env[envKey]);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : fallback;
}

/**
 * Resolve plugin config over environment defaults into the concrete
 * {@link ResolvedWebSearchConfig}. Never throws - the backend needs no
 * credentials, so an unconfigured plugin resolves to sensible defaults with
 * no restrictions.
 */
export function resolveWebSearchConfig(
  config: WebSearchPluginConfig = {},
): ResolvedWebSearchConfig {
  const patterns = parseAllowedUrls(config.allowedUrls ?? process.env["WEB_SEARCH_ALLOWED_URLS"]);
  return {
    safeSearch: resolveSafeSearch(config.safeSearch),
    region: config.region ?? process.env["WEB_SEARCH_REGION"] ?? "wt-wt",
    maxResults: resolvePositiveInt(config.maxResults, "WEB_SEARCH_MAX_RESULTS", DEFAULT_MAX_RESULTS),
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
