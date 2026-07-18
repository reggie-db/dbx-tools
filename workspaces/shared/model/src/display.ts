/**
 * Human-readable model display names. Pure (no Node-only imports) so a
 * browser client can label a `/models` response without server deps.
 *
 * The endpoint `name` is the invoke id (e.g. `databricks-claude-sonnet-4-6`);
 * this derives a friendly label from it. Prefer a Databricks-provided name
 * (a display-name tag or an external-model name) when the server has one -
 * see `@dbx-tools/model`'s serving lister, which passes it as `provided`.
 */
import { string } from "@dbx-tools/shared-core";

/**
 * Vendor / namespace prefixes stripped from a tokenized endpoint name
 * before title-casing. Lowercased tokens; matched only as leading tokens
 * so a legitimate mid-name token is never dropped. `ai` is stripped ONLY
 * as the second half of the `system.ai.*` builtin namespace (handled
 * below), never on its own - so a model literally named `...-ai-...`
 * keeps its "AI" word via the tokenizer's built-in casing override.
 */
const STRIP_LEADING_TOKENS = new Set(["databricks", "system", "dbx"]);

/** `ai` is stripped only as the `system.ai.*` namespace half (after `system`). */
const NAMESPACE_SECOND_TOKENS: Record<string, string> = { system: "ai" };

/** Segment-internal tokens rendered fully uppercased (acronyms), not title-cased. */
const ACRONYMS = new Set(["gpt", "gte", "bge", "dbrx", "oss", "ai", "llm", "moe"]);

/** Parameter-count unit letters glued to a preceding number (`120b` -> `120B`). */
const SIZE_UNITS = new Set(["b", "m", "k"]);

const SEGMENT_SPLIT = /[-_.\s/]+/;

/**
 * Derive a human-readable display name for a serving endpoint.
 *
 * When `provided` is a non-blank string (a Databricks display-name tag or
 * external-model name), it wins verbatim (trimmed). Otherwise the endpoint
 * `name` is humanized: leading vendor prefixes (`databricks`, the
 * `system.ai` namespace, `dbx`) are dropped, then each `-`/`_`/`.`-separated
 * segment is title-cased (acronyms like GPT/GTE/BGE uppercased, "AI" kept),
 * runs of purely-numeric segments are joined into a dotted version
 * (`...-4-6` -> "4.6"), and a size unit glued to its number (`120b` ->
 * "120B"). Falls back to the trimmed raw `name` if stripping leaves nothing.
 *
 * @example
 * toModelDisplayName("databricks-claude-sonnet-4-6") // "Claude Sonnet 4.6"
 * toModelDisplayName("databricks-gpt-oss-120b")      // "GPT OSS 120B"
 * toModelDisplayName("system.ai.bge_large_en")       // "BGE Large En"
 * toModelDisplayName("x", "Claude 4.6 (Preview)")    // provided wins
 */
export function toModelDisplayName(name: string, provided?: string | null): string {
  const providedTrimmed = string.trimToNull(provided);
  if (providedTrimmed) return providedTrimmed;

  const segments = name.split(SEGMENT_SPLIT).filter(Boolean);
  // Drop known vendor/namespace prefixes only while they lead the list.
  let start = 0;
  while (start < segments.length) {
    const lower = segments[start]!.toLowerCase();
    if (!STRIP_LEADING_TOKENS.has(lower)) break;
    // Consume the namespace's second token too (e.g. the `ai` of `system.ai`).
    if (NAMESPACE_SECOND_TOKENS[lower] === segments[start + 1]?.toLowerCase()) {
      start += 1;
    }
    start += 1;
  }
  const kept = segments.slice(start);
  const source = kept.length > 0 ? kept : segments;

  const pieces: string[] = [];
  let versionRun: string[] = [];
  const flushVersion = () => {
    if (versionRun.length > 0) {
      pieces.push(versionRun.join("."));
      versionRun = [];
    }
  };
  for (const segment of source) {
    if (/^\d+$/.test(segment)) {
      versionRun.push(segment);
      continue;
    }
    flushVersion();
    pieces.push(renderSegment(segment));
  }
  flushVersion();

  return pieces.join(" ") || name.trim();
}

/** Title-case one name segment, uppercasing acronyms and gluing size units. */
function renderSegment(segment: string): string {
  const tokens = [...string.tokenizeWithOptions({ capitalize: true }, segment)];
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const lower = token.toLowerCase();
    // Glue a size unit onto the preceding number: `120` + `b` -> `120B`.
    if (
      SIZE_UNITS.has(lower) &&
      out.length > 0 &&
      /^\d+$/.test(out[out.length - 1]!)
    ) {
      out[out.length - 1] = `${out[out.length - 1]}${lower.toUpperCase()}`;
      continue;
    }
    out.push(ACRONYMS.has(lower) ? lower.toUpperCase() : token);
  }
  return out.join(" ");
}
