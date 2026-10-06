/**
 * Generic reasoning-budget translation for Model Serving and gateway callers.
 *
 * Provider wires disagree on effort labels (`xhigh`, `ultra`, `med`, `none`, …).
 * This module owns one industry-shaped ladder and two parsers:
 *
 * - {@link parseReasoning}: fuzzy-match one label onto {@link ReasoningLevel}
 * - {@link parseReasoningLevels}: unwrap nested / double-encoded error bodies
 * - {@link remapReasoning} / {@link adaptRequestReasoning}: map a request onto a
 *   supported ladder and rewrite `reasoning_effort` / `reasoning.effort`
 *
 * Documented model ladders come from the committed HTML snapshot refreshed by
 * `bun run --filter '@dbx-tools/model' metadata` (same cache path as
 * capabilities / rate limits). Error-body parsing is never cached; callers
 * persist learned ladders via the metadata module.
 *
 * Error bodies arrive as complete HTTP JSON whether the request asked for
 * streaming or not (Databricks rejects unsupported efforts with 400 before SSE
 * starts), so {@link parseReasoningLevels} applies to both paths.
 *
 * @module
 */

import { json } from "@dbx-tools/shared-core";
import { isRecord } from "@dbx-tools/shared-core/object";
import * as stringUtils from "@dbx-tools/shared-core/string-utils";
import Fuse from "fuse.js";

import { modelFamily, modelSearchQuery } from "./policy.ts";

/** Industry-generic reasoning budget levels, lowest to highest. */
export type ReasoningLevel = "low" | "medium" | "high" | "extra-high" | "max";

/** Runtime values for {@link ReasoningLevel}. */
export const ReasoningLevel = {
  Low: "low",
  Medium: "medium",
  High: "high",
  ExtraHigh: "extra-high",
  Max: "max",
} as const satisfies Record<string, ReasoningLevel>;

/** Canonical ladder order used when sorting or ranking remaps. */
export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  ReasoningLevel.Low,
  ReasoningLevel.Medium,
  ReasoningLevel.High,
  ReasoningLevel.ExtraHigh,
  ReasoningLevel.Max,
];

/** Model identity → accepted {@link ReasoningLevel} ladder. */
export type ReasoningModelCatalogue = Readonly<Record<string, readonly ReasoningLevel[]>>;

const STANDARD: readonly ReasoningLevel[] = [
  ReasoningLevel.Low,
  ReasoningLevel.Medium,
  ReasoningLevel.High,
];

const WITH_EXTRA_HIGH: readonly ReasoningLevel[] = [
  ReasoningLevel.Low,
  ReasoningLevel.Medium,
  ReasoningLevel.High,
  ReasoningLevel.ExtraHigh,
];

const WITH_MAX: readonly ReasoningLevel[] = [
  ReasoningLevel.Low,
  ReasoningLevel.Medium,
  ReasoningLevel.High,
  ReasoningLevel.ExtraHigh,
  ReasoningLevel.Max,
];

const GPT_5_5_PRO: readonly ReasoningLevel[] = [
  ReasoningLevel.Medium,
  ReasoningLevel.High,
  ReasoningLevel.ExtraHigh,
];

/**
 * Alias table for exact / near-exact labels. Keys are {@link normalizeReasoningToken}
 * results. Provider wires (`xhigh`) and plain English (`ultra`, `med`) both land
 * on the generic ladder.
 */
const ALIASES: Readonly<Record<string, ReasoningLevel>> = {
  low: ReasoningLevel.Low,
  l: ReasoningLevel.Low,
  none: ReasoningLevel.Low,
  off: ReasoningLevel.Low,
  disable: ReasoningLevel.Low,
  disabled: ReasoningLevel.Low,
  zero: ReasoningLevel.Low,
  minimal: ReasoningLevel.Low,
  min: ReasoningLevel.Low,
  tiny: ReasoningLevel.Low,
  light: ReasoningLevel.Low,
  medium: ReasoningLevel.Medium,
  med: ReasoningLevel.Medium,
  mid: ReasoningLevel.Medium,
  moderate: ReasoningLevel.Medium,
  default: ReasoningLevel.Medium,
  normal: ReasoningLevel.Medium,
  balanced: ReasoningLevel.Medium,
  high: ReasoningLevel.High,
  hi: ReasoningLevel.High,
  heavy: ReasoningLevel.High,
  "extra-high": ReasoningLevel.ExtraHigh,
  extrahigh: ReasoningLevel.ExtraHigh,
  xhigh: ReasoningLevel.ExtraHigh,
  xh: ReasoningLevel.ExtraHigh,
  ultra: ReasoningLevel.ExtraHigh,
  "ultra-high": ReasoningLevel.ExtraHigh,
  ultrahigh: ReasoningLevel.ExtraHigh,
  max: ReasoningLevel.Max,
  maximum: ReasoningLevel.Max,
  highest: ReasoningLevel.Max,
  full: ReasoningLevel.Max,
};

const SUPPORTED_VALUES_PATTERN =
  /supported\s+values?\s+are\s*:?\s*(.+?)(?:\.?\s*(?:param|type|code)\b|$)/is;
const TOKEN_PATTERN = /'([^']+)'|"([^"]+)"|`([^`]+)`|\b([a-z][a-z0-9_-]*)\b/gi;
const MAX_JSON_UNWRAP_DEPTH = 8;

interface AliasDocument {
  readonly token: string;
  readonly level: ReasoningLevel;
}

const aliasDocuments: readonly AliasDocument[] = Object.entries(ALIASES).map(([token, level]) => ({
  token,
  level,
}));

const aliasFuse = new Fuse(aliasDocuments, {
  keys: ["token"],
  includeScore: true,
  threshold: 0.35,
  ignoreLocation: true,
});

/**
 * Fuzzy-match one reasoning label onto {@link ReasoningLevel}.
 *
 * Returns `undefined` when the input is empty or cannot be mapped confidently.
 */
export function parseReasoning(value: unknown): ReasoningLevel | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }
  const normalized = normalizeReasoningToken(String(value));
  if (!normalized) return undefined;
  const exact = ALIASES[normalized] ?? ALIASES[normalized.replace(/-/g, "")];
  if (exact) return exact;
  const [match] = aliasFuse.search(normalized);
  if (!match || (match.score ?? 1) > 0.35) return undefined;
  return match.item.level;
}

/**
 * Extract supported reasoning levels from an upstream error body.
 *
 * Accepts raw response text, already-parsed JSON, or Databricks envelopes that
 * nest JSON strings several times. Returns `[]` when no supported-values list
 * can be recovered. Results are not cached.
 */
export function parseReasoningLevels(body: unknown): ReasoningLevel[] {
  const levels: ReasoningLevel[] = [];
  const seen = new Set<ReasoningLevel>();
  for (const text of collectTextLeaves(body)) {
    for (const token of extractSupportedTokens(text)) {
      const level = parseReasoning(token);
      if (!level || seen.has(level)) continue;
      seen.add(level);
      levels.push(level);
    }
  }
  return levels;
}

/**
 * Look up documented levels for a model identity inside a catalogue.
 *
 * Matches exact catalogue keys and suffix identities.
 */
export function documentedReasoningLevels(
  model: string,
  catalogue: ReasoningModelCatalogue,
): ReasoningLevel[] | undefined {
  const keys = catalogueKeysFor(model);
  for (const key of keys) {
    const levels = catalogue[key];
    if (levels?.length) return [...levels];
  }
  for (const [key, levels] of Object.entries(catalogue)) {
    if (keys.some((candidate) => key.endsWith(candidate) || candidate.endsWith(key))) {
      return [...levels];
    }
  }
  return undefined;
}

/**
 * Hard-coded family defaults used when documentation has no entry.
 *
 * Unknown families return the standard low/medium/high ladder.
 */
export function defaultReasoningLevels(model: string): ReasoningLevel[] {
  const family = modelFamily(model)?.toLowerCase();
  const normalized = model.toLowerCase();
  if (family === "grok" || normalized.includes("grok")) return [...WITH_EXTRA_HIGH];
  if (family === "gemini" || normalized.includes("gemini")) return [...STANDARD];
  if (family === "claude" || normalized.includes("claude")) return [...WITH_MAX];
  if (family === "glm" || normalized.includes("glm")) {
    return [ReasoningLevel.High, ReasoningLevel.Max];
  }
  if (
    family === "deepseek" ||
    normalized.includes("deepseek") ||
    family === "kimi" ||
    normalized.includes("kimi")
  ) {
    return [ReasoningLevel.Low, ReasoningLevel.High, ReasoningLevel.Max];
  }
  if (family === "inkling" || normalized.includes("inkling")) return [...WITH_MAX];
  if (family === "gpt" || normalized.includes("gpt") || normalized.includes("codex")) {
    if (normalized.includes("oss")) return [...STANDARD];
    if (/(?:^|[-_.])5[-_.]?5(?:[-_.]|$)/.test(normalized) && normalized.includes("pro")) {
      return [...GPT_5_5_PRO];
    }
    if (
      /(?:^|[-_.])5[-_.]?6(?:[-_.]|$)/.test(normalized) ||
      /(?:^|[-_.])6(?:[-_.]|$)/.test(normalized)
    ) {
      return [...WITH_MAX];
    }
    return [...STANDARD];
  }
  if (/(?:^|[-_./])o(?:1|3|4)(?:[-_./]|$)/.test(model) || normalized.includes("codex")) {
    return [...STANDARD];
  }
  return [...STANDARD];
}

/**
 * Prefer a documentation catalogue when provided, otherwise
 * {@link defaultReasoningLevels}.
 */
export function reasoningLevelsFor(
  model: string,
  catalogue?: ReasoningModelCatalogue,
): ReasoningLevel[] {
  if (catalogue) {
    const documented = documentedReasoningLevels(model, catalogue);
    if (documented?.length) return documented;
  }
  return defaultReasoningLevels(model);
}

/**
 * Map a generic level onto the most common provider wire token.
 *
 * `extra-high` becomes `xhigh` because that is what Databricks / OpenAI error
 * messages advertise today.
 */
export function formatReasoning(level: ReasoningLevel): string {
  return level === ReasoningLevel.ExtraHigh ? "xhigh" : level;
}

/** Wire tokens that mean "do not reason" rather than "use a low budget". */
const DISABLED_REASONING_TOKENS = new Set(["none", "off", "disable", "disabled"]);

/**
 * Remap a requested effort onto the nearest supported {@link ReasoningLevel}.
 *
 * `none` / `off` (and disable aliases) are not a low budget: when the model
 * requires reasoning, they snap to the supported level closest to
 * {@link ReasoningLevel.Medium}. Other requests prefer the highest allowed
 * level at or below the request, otherwise the lowest allowed level.
 *
 * Returns `undefined` when the request cannot be parsed or `levels` is empty.
 */
export function remapReasoning(
  requested: unknown,
  levels: readonly ReasoningLevel[],
): ReasoningLevel | undefined {
  if (levels.length === 0) return undefined;
  if (isDisabledReasoningToken(requested)) {
    return nearestReasoning(ReasoningLevel.Medium, levels);
  }
  const parsed = parseReasoning(requested);
  if (!parsed) return undefined;
  if (levels.includes(parsed)) return parsed;
  const requestedIndex = REASONING_LEVELS.indexOf(parsed);
  let best: ReasoningLevel | undefined;
  let bestIndex = Number.NEGATIVE_INFINITY;
  for (const level of levels) {
    const index = REASONING_LEVELS.indexOf(level);
    if (index <= requestedIndex && index > bestIndex) {
      best = level;
      bestIndex = index;
    }
  }
  return best ?? levels[0];
}

function isDisabledReasoningToken(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return false;
  }
  return DISABLED_REASONING_TOKENS.has(normalizeReasoningToken(String(value)));
}

/** Closest supported level to `target`; ties prefer the higher budget. */
function nearestReasoning(
  target: ReasoningLevel,
  levels: readonly ReasoningLevel[],
): ReasoningLevel | undefined {
  if (levels.length === 0) return undefined;
  if (levels.includes(target)) return target;
  const targetIndex = REASONING_LEVELS.indexOf(target);
  let best: ReasoningLevel | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    const distance = Math.abs(REASONING_LEVELS.indexOf(level) - targetIndex);
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        REASONING_LEVELS.indexOf(level) > REASONING_LEVELS.indexOf(best ?? level))
    ) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/** Result of adapting reasoning fields on a gateway request body. */
export interface AdaptedRequestReasoning {
  /** Body with remapped wire tokens (same reference when unchanged). */
  readonly body: Readonly<Record<string, unknown>>;
  /** True when any reasoning field was rewritten. */
  readonly changed: boolean;
  /** Wire token written when a reasoning field was present and remapped. */
  readonly wireEffort?: string;
}

/**
 * Rewrite `reasoning_effort` / `reasoning.effort` onto a supported ladder.
 *
 * Model-agnostic: callers supply the allowed levels (learned, documented, or
 * defaults). Bodies without reasoning fields are returned unchanged.
 */
export function adaptRequestReasoning(
  body: Readonly<Record<string, unknown>>,
  levels: readonly ReasoningLevel[],
): AdaptedRequestReasoning {
  if (levels.length === 0) return { body, changed: false };

  const topLevel = body.reasoning_effort;
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
  const nested = reasoning?.effort;
  const requested = topLevel ?? nested;
  if (requested === undefined) return { body, changed: false };

  const remapped = remapReasoning(requested, levels);
  if (!remapped) return { body, changed: false };
  const wire = formatReasoning(remapped);

  let changed = false;
  let next: Record<string, unknown> = { ...body };

  if (typeof topLevel === "string" || typeof topLevel === "number") {
    if (String(topLevel) !== wire) {
      next = { ...next, reasoning_effort: wire };
      changed = true;
    }
  }
  if (reasoning && (typeof nested === "string" || typeof nested === "number")) {
    if (String(nested) !== wire) {
      next = { ...next, reasoning: { ...reasoning, effort: wire } };
      changed = true;
    }
  }

  return changed
    ? { body: next, changed: true, wireEffort: wire }
    : { body, changed: false, wireEffort: wire };
}

/** Normalize labels for alias lookup (`Extra High` → `extra-high`). */
export function normalizeReasoningToken(value: string): string {
  return (
    stringUtils
      .trimToNull(value)
      ?.toLowerCase()
      .replace(/[_\s]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") ?? ""
  );
}

/** Deduplicate levels while preserving first-seen order. */
export function uniqueReasoningLevels(levels: readonly ReasoningLevel[]): ReasoningLevel[] {
  const seen = new Set<ReasoningLevel>();
  const ordered: ReasoningLevel[] = [];
  for (const level of levels) {
    if (seen.has(level)) continue;
    seen.add(level);
    ordered.push(level);
  }
  return ordered;
}

function extractSupportedTokens(text: string): string[] {
  const match = SUPPORTED_VALUES_PATTERN.exec(text);
  if (!match?.[1]) return [];
  return tokensFromFragment(match[1]);
}

function catalogueKeysFor(model: string): string[] {
  const keys = new Set<string>();
  const direct = modelCatalogueKey(model);
  if (direct) keys.add(direct);
  const stripped = model
    .toLowerCase()
    .replace(/^databricks\//, "")
    .replace(/^system\.ai\./, "")
    .replace(/^databricks-/, "");
  const strippedKey = modelCatalogueKey(stripped);
  if (strippedKey) keys.add(strippedKey);
  const withPrefix = modelCatalogueKey(`databricks-${stripped}`);
  if (withPrefix) keys.add(withPrefix);
  return [...keys];
}

function modelCatalogueKey(name: string): string | undefined {
  const trimmed = stringUtils.trimToNull(name);
  if (!trimmed) return undefined;
  return (
    modelSearchQuery(trimmed)?.replaceAll(" ", "-") ??
    trimmed
      .toLowerCase()
      .replace(/^databricks-/, "")
      .replace(/[^a-z0-9._-]+/g, "-")
  );
}

function tokensFromFragment(fragment: string): string[] {
  const tokens: string[] = [];
  for (const part of fragment.matchAll(TOKEN_PATTERN)) {
    const token = part[1] ?? part[2] ?? part[3] ?? part[4];
    if (!token || token === "and" || token === "or" || token === "of") continue;
    tokens.push(token.replace(/^["'`]+|["'`]+$/g, ""));
  }
  return tokens;
}

/**
 * Walk a value tree, unwrapping nested JSON strings, and collect text leaves
 * that may contain a supported-values sentence.
 */
function collectTextLeaves(value: unknown, depth = 0): string[] {
  if (value == null || depth > MAX_JSON_UNWRAP_DEPTH) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parsed = tryUnwrapJson(trimmed);
    if (parsed !== undefined && parsed !== trimmed) {
      return collectTextLeaves(parsed, depth + 1);
    }
    return [trimmed];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextLeaves(entry, depth + 1));
  }
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((entry) => collectTextLeaves(entry, depth + 1));
}

function tryUnwrapJson(text: string): unknown {
  const asRecord = json.parseRecord(text);
  if (asRecord) return asRecord;
  const parsed = json.parse(text);
  if (parsed !== undefined) return parsed;
  if (text.includes('\\"') || text.includes("\\n")) {
    const unescaped = text.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    if (unescaped !== text) {
      const nested = json.parse(unescaped);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}
