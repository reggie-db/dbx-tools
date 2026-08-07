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
 * Which endpoint id is used follows the standard precedence - explicit plugin
 * config, then environment, then a default - with two environment sources:
 *
 *   1. `model` in plugin config;
 *   2. `WEB_SEARCH_MODEL`, the dedicated override, so a deployment can point
 *      web search at a different endpoint than the agent's chat model;
 *   3. `DATABRICKS_SERVING_ENDPOINT_NAME`, AppKit's standard name for a
 *      Model Serving binding, honored so the resource declared in the manifest
 *      wires this plugin up like any other. Because that binding is shared
 *      with whatever else the app serves, it is treated as a preference: an
 *      endpoint that cannot run the native web-search tool is skipped in
 *      favor of {@link WebSearchPluginConfig.modelFallbacks} rather than
 *      failing the call. A pin from (1) or (2) is explicit and DOES fail;
 *   4. otherwise the fallback order, resolved against the live catalogue.
 *
 * Which model wins is decided lazily, at call time, against the live
 * catalogue. Resolution here is eager about everything else and fails loudly
 * on a contradiction: an unparseable `WEB_SEARCH_TOOLS`, an unknown
 * {@link UrlPolicyMode}, or a URL policy that disagrees with the allow-list it
 * was given.
 *
 * Env fallbacks: `WEB_SEARCH_MODEL`, `DATABRICKS_SERVING_ENDPOINT_NAME`,
 * `WEB_SEARCH_MODEL_FALLBACKS`, `WEB_SEARCH_TOOLS` (JSON),
 * `WEB_SEARCH_URL_POLICY`, `WEB_SEARCH_ALLOWED_URLS`,
 * `WEB_SEARCH_MAX_CITATIONS`, `WEB_SEARCH_FETCH_MAX_LENGTH`,
 * `WEB_SEARCH_TIMEOUT_MS`, `WEB_SEARCH_SCRAPE_FALLBACK`, `WEB_SEARCH_FUZZY`,
 * `WEB_SEARCH_FUZZY_THRESHOLD`.
 *
 * @module
 */

import { ConfigurationError, type BasePluginConfig } from "@databricks/appkit";
import { config as coreConfig } from "@dbx-tools/core";
import { serving } from "@dbx-tools/model";
import { json, object, type OneOrMany, string } from "@dbx-tools/shared-core";
import type { JSONSchema7 } from "json-schema";
import { parseAllowedUrls, toUrlAllowList, type UrlAllowList } from "./allowlist.ts";

/**
 * A URL-pattern gate for per-tool approval. `true` gates every call; a
 * pattern (or list of patterns, in the {@link OneOrMany} shape used across
 * the repo) gates only calls whose URL matches. Patterns use the same glob
 * syntax as the allow-list (see `allowlist.ts`). Omit / `false` for no
 * approval. Normalized to an {@link ApprovalPolicy} before use.
 */
export type ApprovalGate = boolean | OneOrMany<string> | string;

/**
 * The normalized form of an {@link ApprovalGate}: which calls pause for a
 * human. `"none"` runs every call straight through, `"always"` gates all of
 * them, and `"urls"` gates only calls whose URL matches one of `patterns`.
 */
export type ApprovalPolicy =
  | { readonly mode: "none" }
  | { readonly mode: "always" }
  | { readonly mode: "urls"; readonly patterns: readonly string[] };

/**
 * Which URLs the tools may reach. `"allowlist"` permits only the configured
 * entries; `"unrestricted"` names the permissive mode explicitly, so an
 * unrestricted deployment is a stated choice visible in the boot log rather
 * than an empty list nobody noticed.
 */
export type UrlPolicyMode = "unrestricted" | "allowlist";

/** Dedicated override for the web-search endpoint id. */
export const MODEL_ENV = "WEB_SEARCH_MODEL";

/** AppKit's standard environment name for a Model Serving endpoint binding. */
export const SERVING_ENDPOINT_ENV = "DATABRICKS_SERVING_ENDPOINT_NAME";

/** Where the pinned web-search endpoint id came from, or `"none"` when unpinned. */
export type ModelSource = "config" | typeof MODEL_ENV | typeof SERVING_ENDPOINT_ENV | "none";

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
   * back to `WEB_SEARCH_MODEL`, then `DATABRICKS_SERVING_ENDPOINT_NAME`, then
   * the {@link modelFallbacks} order. Chosen independently of the calling
   * agent's chat model.
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
  /** Fuse.js fuzzy threshold. Falls back to `WEB_SEARCH_FUZZY_THRESHOLD`, then the shared default. */
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
   * Fall back to a DuckDuckGo scrape when the workspace has NO deployed
   * web-search-capable model (no GPT / Gemini serving endpoint). The native
   * Databricks tool is always preferred; this only kicks in when there is no
   * native option, so the tool still returns results instead of erroring.
   * Defaults to `true`; set `false` (or `WEB_SEARCH_SCRAPE_FALLBACK=0`) to
   * require a native model and error otherwise.
   */
  scrapeFallback?: boolean;
  /**
   * Which URLs the tools may reach ({@link UrlPolicyMode}). Falls back to
   * `WEB_SEARCH_URL_POLICY`, then to `"allowlist"` when {@link allowedUrls}
   * has entries and `"unrestricted"` when it does not. Naming the mode
   * explicitly is the way to state that an open deployment is intended;
   * `"allowlist"` with no entries, or `"unrestricted"` alongside entries, is
   * a contradiction and fails at resolution.
   */
  urlPolicy?: UrlPolicyMode;
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
   * a URL-pattern (or list) gates only matching calls; an
   * {@link ApprovalPolicy} states the mode directly. Omit for no approval.
   */
  approval?: ApprovalGate | ApprovalPolicy;
}

/** Concrete, validated config the runtime + tools read. */
export interface ResolvedWebSearchConfig {
  /** Pinned web-search model, when configured (else undefined - use fallbacks). */
  model?: string;
  /** Where {@link model} came from, which decides whether an unsupported pin is fatal. */
  modelSource: ModelSource;
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
  /** Whether to scrape-fallback when no native web-search model is deployed. */
  scrapeFallback: boolean;
  /** The named URL policy in force. */
  urlPolicy: UrlPolicyMode;
  /** Compiled allow-list (permit-all under the `unrestricted` policy). */
  allowList: UrlAllowList;
  /** Default per-tool approval policy. */
  approval: ApprovalPolicy;
}

/** JSON Schema published on the manifest's `config.schema`. */
export const WEB_SEARCH_CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    model: {
      type: "string",
      description:
        "Default web-search model (endpoint name, loose name, or class). Fuzzy-matched. Env: WEB_SEARCH_MODEL, then DATABRICKS_SERVING_ENDPOINT_NAME.",
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
    modelFuzzyMatch: {
      type: "boolean",
      description:
        "Fuzzy-match loose model names against the live catalogue. Default true (env: WEB_SEARCH_FUZZY).",
    },
    modelFuzzyThreshold: {
      type: "number",
      description:
        "Fuse.js score threshold below which a fuzzy model match is accepted (env: WEB_SEARCH_FUZZY_THRESHOLD).",
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
    scrapeFallback: {
      type: "boolean",
      description:
        "Fall back to a DuckDuckGo scrape when no web-search-capable model is deployed. Default true (env: WEB_SEARCH_SCRAPE_FALLBACK).",
    },
    urlPolicy: {
      type: "string",
      enum: ["unrestricted", "allowlist"],
      description:
        "Which URLs the tools may reach. Defaults to allowlist when allowedUrls has entries, else unrestricted (env: WEB_SEARCH_URL_POLICY).",
    },
    allowedUrls: {
      type: "array",
      items: { type: "string" },
      description:
        'URL allow-list of globs / bare hosts (e.g. "*.databricks.com", "docs.example.com"). Also accepts a comma/space-separated string. Falls back to WEB_SEARCH_ALLOWED_URLS. Empty = unrestricted.',
    },
    approval: {
      description:
        'Approval gate for both tools: true gates every call, a glob (or list of globs) gates only matching URLs, or state the mode directly as {"mode":"none"|"always"|"urls"}. Default none.',
      oneOf: [
        { type: "boolean" },
        { type: "string" },
        { type: "array", items: { type: "string" } },
        {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["none", "always", "urls"] },
            patterns: { type: "array", items: { type: "string" } },
          },
          required: ["mode"],
        },
      ],
    },
  },
};

/**
 * Parse the `WEB_SEARCH_TOOLS` env var (JSON object), else `{}`. A value that
 * is set but not a JSON object is a deployment mistake that would otherwise
 * silently leave the built-in tool specs in place, so it throws.
 */
function parseToolsEnv(): Record<string, unknown> {
  const raw = coreConfig.text("WEB_SEARCH_TOOLS", coreConfig.ENV_ONLY);
  if (raw === undefined) return {};
  const parsed = json.parseRecord(raw);
  if (!parsed) {
    throw new ConfigurationError(
      "WEB_SEARCH_TOOLS must be a JSON object mapping a provider family to its tool spec",
      { context: { envVar: "WEB_SEARCH_TOOLS" } },
    );
  }
  return parsed;
}

/** Read the pinned endpoint id and record which source supplied it. */
function resolveModelPin(config: WebSearchPluginConfig): { model?: string; source: ModelSource } {
  const fromConfig = string.trimToNull(config.model);
  if (fromConfig !== null) return { model: fromConfig, source: "config" };
  const fromModelEnv = coreConfig.text(MODEL_ENV, coreConfig.ENV_ONLY);
  if (fromModelEnv !== undefined) return { model: fromModelEnv, source: MODEL_ENV };
  const fromResourceEnv = coreConfig.text(SERVING_ENDPOINT_ENV, coreConfig.ENV_ONLY);
  if (fromResourceEnv !== undefined) {
    return { model: fromResourceEnv, source: SERVING_ENDPOINT_ENV };
  }
  return { source: "none" };
}

/**
 * Resolve the named {@link UrlPolicyMode}, failing on a stated mode that
 * contradicts the allow-list entries it was given.
 */
function resolveUrlPolicy(
  configured: UrlPolicyMode | undefined,
  patterns: readonly string[],
): UrlPolicyMode {
  const raw = configured ?? coreConfig.text("WEB_SEARCH_URL_POLICY", coreConfig.ENV_ONLY);
  if (raw === undefined) return patterns.length > 0 ? "allowlist" : "unrestricted";
  if (raw !== "allowlist" && raw !== "unrestricted") {
    throw new ConfigurationError(
      'urlPolicy must be "allowlist" or "unrestricted" (env: WEB_SEARCH_URL_POLICY)',
      { context: { field: "urlPolicy", envVar: "WEB_SEARCH_URL_POLICY" } },
    );
  }
  if (raw === "allowlist" && patterns.length === 0) {
    throw new ConfigurationError(
      'urlPolicy "allowlist" needs at least one entry in allowedUrls (env: WEB_SEARCH_ALLOWED_URLS)',
      { context: { field: "allowedUrls", envVar: "WEB_SEARCH_ALLOWED_URLS" } },
    );
  }
  if (raw === "unrestricted" && patterns.length > 0) {
    throw new ConfigurationError(
      'urlPolicy "unrestricted" cannot be combined with allowedUrls entries; drop the entries or set urlPolicy to "allowlist"',
      { context: { field: "allowedUrls", envVar: "WEB_SEARCH_ALLOWED_URLS" } },
    );
  }
  return raw;
}

/**
 * Normalize any accepted approval spelling into an {@link ApprovalPolicy}.
 * A pattern gate with no usable patterns collapses to `"none"` rather than
 * gating everything, so a blank env var can never wedge the tools behind an
 * approval nobody configured.
 */
export function toApprovalPolicy(gate: ApprovalGate | ApprovalPolicy | undefined): ApprovalPolicy {
  if (gate === undefined || gate === false) return { mode: "none" };
  if (gate === true) return { mode: "always" };
  if (object.isRecord(gate) && "mode" in gate) {
    if (gate.mode === "urls") {
      const patterns = parseAllowedUrls([...gate.patterns]);
      return patterns.length > 0 ? { mode: "urls", patterns } : { mode: "none" };
    }
    if (gate.mode === "always" || gate.mode === "none") return { mode: gate.mode };
    throw new ConfigurationError('approval mode must be "none", "always" or "urls"', {
      context: { field: "approval" },
    });
  }
  const patterns = parseAllowedUrls(typeof gate === "string" ? gate : [...gate]);
  return patterns.length > 0 ? { mode: "urls", patterns } : { mode: "none" };
}

/**
 * Resolve plugin config over environment defaults into the concrete
 * {@link ResolvedWebSearchConfig}. Which model is used stays lazy - it is
 * picked at call time against the live catalogue - but everything else is
 * settled here, and a contradiction (unparseable `WEB_SEARCH_TOOLS`, an
 * unknown URL policy, a policy that disagrees with its allow-list) throws a
 * {@link ConfigurationError} naming the field and the environment variable.
 */
export function resolveWebSearchConfig(
  config: WebSearchPluginConfig = {},
): ResolvedWebSearchConfig {
  const patterns = parseAllowedUrls(
    config.allowedUrls ?? coreConfig.text("WEB_SEARCH_ALLOWED_URLS", coreConfig.ENV_ONLY),
  );
  const urlPolicy = resolveUrlPolicy(config.urlPolicy, patterns);
  const { model, source } = resolveModelPin(config);
  const fallbacks = coreConfig.list(
    config.modelFallbacks,
    "WEB_SEARCH_MODEL_FALLBACKS",
    undefined,
    coreConfig.ENV_ONLY,
  );
  return {
    ...(model ? { model } : {}),
    modelSource: source,
    modelFallbacks: fallbacks.length > 0 ? fallbacks : DEFAULT_MODEL_FALLBACKS,
    webSearchTools: { ...parseToolsEnv(), ...(config.webSearchTools ?? {}) },
    fuzzy:
      coreConfig.boolean(config.modelFuzzyMatch, "WEB_SEARCH_FUZZY", coreConfig.ENV_ONLY) ?? true,
    fuzzyThreshold: coreConfig.positiveNumber(
      config.modelFuzzyThreshold,
      "WEB_SEARCH_FUZZY_THRESHOLD",
      serving.DEFAULT_FUZZY_THRESHOLD,
      coreConfig.ENV_ONLY,
    ),
    maxCitations: coreConfig.positiveInt(
      config.maxCitations,
      "WEB_SEARCH_MAX_CITATIONS",
      DEFAULT_MAX_CITATIONS,
      coreConfig.ENV_ONLY,
    ),
    fetchMaxLength: coreConfig.positiveInt(
      config.fetchMaxLength,
      "WEB_SEARCH_FETCH_MAX_LENGTH",
      DEFAULT_FETCH_MAX_LENGTH,
      coreConfig.ENV_ONLY,
    ),
    timeoutMs: coreConfig.positiveInt(
      config.timeoutMs,
      "WEB_SEARCH_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      coreConfig.ENV_ONLY,
    ),
    scrapeFallback:
      coreConfig.boolean(
        config.scrapeFallback,
        "WEB_SEARCH_SCRAPE_FALLBACK",
        coreConfig.ENV_ONLY,
      ) ?? true,
    urlPolicy,
    allowList: toUrlAllowList(urlPolicy === "allowlist" ? patterns : []),
    approval: toApprovalPolicy(config.approval),
  };
}

/**
 * Resolve an approval gate against a set of candidate URLs into a concrete
 * boolean: `"none"` / `"always"` pass straight through; a `"urls"` policy
 * gates when ANY candidate matches. Empty candidates with a pattern gate
 * never match (nothing to approve). Reuses the allow-list matcher so approval
 * globs read exactly like allow-list globs.
 */
export function approvalMatches(
  gate: ApprovalGate | ApprovalPolicy,
  urls: readonly string[],
): boolean {
  const policy = toApprovalPolicy(gate);
  if (policy.mode === "none") return false;
  if (policy.mode === "always") return true;
  const list = toUrlAllowList(policy.patterns);
  return urls.some((url) => list.allows(url));
}
