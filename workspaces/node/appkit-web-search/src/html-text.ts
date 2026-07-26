/**
 * Turning fetched HTML into the plain text a model can read.
 *
 * Both scraping paths need this: {@link fetchUrl}'s full-page read and the
 * DuckDuckGo fallback's title/snippet extraction. They previously carried
 * separate entity tables that drifted, so the decode lives here once.
 *
 * This is deliberately regex-based rather than a DOM parse. The inputs are
 * whole pages fetched for summarization, not documents to be queried, so the
 * cost of a real parser buys nothing - and a malformed page still degrades to
 * readable text instead of throwing.
 *
 * @module
 */

/**
 * The named entities that survive tag-stripping in practice, plus numeric
 * escapes. Not a complete HTML entity table - anything rarer passes through
 * as-is, which reads acceptably in model input.
 */
const NAMED_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
};

const NAMED_ENTITY_REGEXP = new RegExp(Object.keys(NAMED_ENTITIES).join("|"), "g");
const NUMERIC_ENTITY_REGEXP = /&#(\d+);/g;
const TAG_REGEXP = /<[^>]+>/g;

/** Decode the HTML entities that survive tag-stripping. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(NAMED_ENTITY_REGEXP, (entity) => NAMED_ENTITIES[entity] ?? entity)
    .replace(NUMERIC_ENTITY_REGEXP, (_, code) => String.fromCodePoint(Number(code)));
}

/**
 * Strip tags and decode entities from a short HTML fragment, collapsing all
 * whitespace to single spaces. For inline snippets (a search result title or
 * summary), where layout carries no meaning.
 */
export function htmlFragmentToText(html: string): string {
  return decodeHtmlEntities(html.replace(TAG_REGEXP, "")).replace(/\s+/g, " ").trim();
}

/**
 * Reduce a full HTML document to readable plain text: drop `<script>` /
 * `<style>` / `<noscript>` blocks and comments, turn block-level tags into
 * newlines, strip the remaining tags, decode entities, and collapse runs of
 * blank lines / trailing spaces. Unlike {@link htmlFragmentToText}, this
 * preserves line structure because paragraph breaks carry meaning in a page.
 */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|header|footer|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(TAG_REGEXP, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
