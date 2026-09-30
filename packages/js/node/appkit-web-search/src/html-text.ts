/**
 * Turning fetched HTML into the plain text a model can read.
 *
 * Both scraping paths need this: `runWebFetch`'s full-page read and
 * `runScrapeSearch`'s title/snippet extraction. Parser-backed conversion keeps
 * malformed markup, quoted `>` characters, and the complete HTML entity table
 * consistent across both paths.
 *
 * @module
 */

import { decodeHTML } from "entities";
import { compile, type HtmlToTextOptions } from "html-to-text";

const SHARED_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "noscript", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
  ],
};

const fragmentToText = compile({
  ...SHARED_OPTIONS,
  preserveNewlines: false,
});

const documentToText = compile({
  ...SHARED_OPTIONS,
  preserveNewlines: true,
});

/** Decode named, decimal, and hexadecimal HTML entities without throwing. */
export function decodeHtmlEntities(text: string): string {
  return decodeHTML(text);
}

/**
 * Strip tags and decode entities from a short HTML fragment, collapsing all
 * whitespace to single spaces. For inline snippets (a search result title or
 * summary), where layout carries no meaning.
 */
export function htmlFragmentToText(html: string): string {
  return fragmentToText(html).replace(/\s+/g, " ").trim();
}

/**
 * Reduce a full HTML document to readable plain text: drop `<script>` /
 * `<style>` / `<noscript>` blocks and comments, turn block-level tags into
 * newlines, strip the remaining tags, decode entities, and collapse runs of
 * blank lines / trailing spaces. Unlike {@link htmlFragmentToText}, this
 * preserves line structure because paragraph breaks carry meaning in a page.
 */
export function htmlToText(html: string): string {
  return documentToText(html)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
