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

/**
 * Derive a human-readable display name for a serving endpoint.
 *
 * When `provided` is a non-blank string (a Databricks display-name tag or
 * external-model name), it wins verbatim (trimmed). Otherwise `name` is
 * tokenized with the shared-core tokenizer (which title-cases and
 * special-cases "AI"), known leading vendor prefixes are dropped, and the
 * remaining tokens are joined with spaces. Falls back to the trimmed raw
 * `name` if stripping leaves nothing.
 *
 * @example
 * toModelDisplayName("databricks-claude-sonnet-4-6") // "Claude Sonnet 4 6"
 * toModelDisplayName("system.ai.bge_large_en")       // "Bge Large En"
 * toModelDisplayName("x", "GPT-5 (Preview)")          // "GPT-5 (Preview)"
 */
export function toModelDisplayName(name: string, provided?: string | null): string {
  const providedTrimmed = string.trimToNull(provided);
  if (providedTrimmed) return providedTrimmed;

  const tokens = [...string.tokenizeWithOptions({ capitalize: true }, name)];
  // Drop known vendor/namespace prefixes only while they lead the list, so
  // a model literally named after one of these words mid-string is kept.
  let start = 0;
  while (start < tokens.length && STRIP_LEADING_TOKENS.has(tokens[start]!.toLowerCase())) {
    // `system` is followed by `ai` in the `system.ai.*` builtin namespace;
    // consume that `ai` too (but only right after `system`, never alone).
    if (
      tokens[start]!.toLowerCase() === "system" &&
      tokens[start + 1]?.toLowerCase() === "ai"
    ) {
      start += 1;
    }
    start += 1;
  }
  const kept = tokens.slice(start);
  const label = (kept.length > 0 ? kept : tokens).join(" ");
  return label || name.trim();
}
