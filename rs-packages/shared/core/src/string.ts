/**
 * Browser-safe string toolkit: tokenization, identifier / slug
 * generation (with hash-suffix collision resistance), HTML escaping,
 * header-value trimming, and a nested description-tree renderer for
 * long-form LLM prompt / tool-description text. Depends only on the
 * local {@link fnvHashWithOptions} for deterministic hash suffixes.
 *
 * @module
 */
import { fnvHashWithOptions } from "./hash.ts";

/**
 * Options controlling {@link tokenizeWithOptions}. All default off except
 * `camelCase`.
 *
 * - `distinct` - drop duplicate tokens (first occurrence wins).
 * - `lowerCase` - lowercase every token.
 * - `capitalize` - upper-case each token's first letter (then
 *   {@link TOKENIZE_OVERRIDES} fix up `ai` -> `AI`, `fs` -> `FS`, and
 *   `v2` -> `V2`).
 * - `omitUriScheme` - strip a leading `scheme://` before tokenizing.
 * - `omitEmailDomain` - keep only the local part of an email.
 * - `camelCase` - split on camelCase boundaries / digit runs / acronyms
 *   (default `true`); when `false`, split only on non-alphanumerics.
 */
export type TokenizeOptions = {
  distinct?: boolean;
  lowerCase?: boolean;
  capitalize?: boolean;
  omitUriScheme?: boolean;
  omitEmailDomain?: boolean;
  camelCase?: boolean;
};

// Keys/identifiers/slugs are always lowercased; `lowerCase` is not a
// caller-configurable option.
export type KeyOptions = Omit<TokenizeOptions, "lowerCase" | "capitalize"> & {
  maxLength?: number;
  truncateStrategy?: "hash" | "trim" | "empty";
  truncateHashLength?: number;
};

export type IdentifierOptions = KeyOptions & {
  delimiter?: string;
};

type ResolvedTokenizeOptions = Required<TokenizeOptions>;
type ResolvedIdentifierOptions = Required<
  IdentifierOptions & Pick<TokenizeOptions, "lowerCase" | "capitalize">
>;

// A leading `v`/`V` immediately followed by digits (a version marker like
// `v2`) is kept as ONE token instead of splitting into `v` + `2`; it leads the
// alternation so it wins over the generic letter / digit runs. Everything else
// is the usual camelCase word / number / all-caps-acronym split.
const TOKENIZE_CAMEL_CASE_REGEXP = /[vV][0-9]+|[A-Z]?[a-z]+|[0-9]+|[A-Z]+(?![a-z])/g;
const TOKENIZE_NON_ALPHANUMERIC_REGEXP = /[a-zA-Z0-9]+/g;
const TOKENIZE_OVERRIDES: ((token: string, options: TokenizeOptions) => string)[] = [
  (token, options) => {
    if (!options.capitalize) return token;
    const lower = token.toLowerCase();
    if (lower === "ai") return "AI";
    if (lower === "fs") return "FS";
    return token;
  },
  // Version marker `v2` -> `V2` when capitalizing (the leading `v` uppercases,
  // the digits stay), so it reads as one unit rather than "V 2".
  (token, options) => {
    if (options.capitalize && /^v[0-9]+$/.test(token)) {
      return `V${token.slice(1)}`;
    }
    return token;
  },
];
const URI_REGEXP = /^([a-zA-Z][a-zA-Z0-9+.-]*)?:\/\/([^\s/?#][^\s]*)?$/;
const EMAIL_REGEXP = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)$/;

const TOKENIZE_DEFAULTS: ResolvedTokenizeOptions = {
  distinct: false,
  lowerCase: false,
  capitalize: false,
  omitUriScheme: false,
  omitEmailDomain: false,
  camelCase: true,
};

const IDENTIFIER_DEFAULTS: ResolvedIdentifierOptions = {
  ...TOKENIZE_DEFAULTS,
  lowerCase: true,
  maxLength: Infinity,
  truncateStrategy: "hash",
  truncateHashLength: 6,
  delimiter: "-",
};

export function* tokenizeWithOptions(
  options: TokenizeOptions,
  ...values: unknown[]
): Generator<string> {
  const opts: ResolvedTokenizeOptions = { ...TOKENIZE_DEFAULTS, ...options };
  const seen = opts.distinct ? new Set<string>() : undefined;
  const regexp = opts.camelCase ? TOKENIZE_CAMEL_CASE_REGEXP : TOKENIZE_NON_ALPHANUMERIC_REGEXP;

  for (const value of values) {
    if (value == null) continue;
    let stringValue = typeof value === "string" ? value : String(value);
    if (!stringValue) continue;
    if (opts.omitUriScheme) {
      const match = stringValue.match(URI_REGEXP);
      if (match) stringValue = match[2] ?? "";
    }
    if (opts.omitEmailDomain) {
      const match = stringValue.match(EMAIL_REGEXP);
      if (match) stringValue = match[1] ?? "";
    }
    if (!stringValue) continue;
    for (const tokenMatch of stringValue.matchAll(regexp)) {
      let token = tokenMatch[0]!;
      if (opts.lowerCase) token = token.toLowerCase();
      if (opts.capitalize) token = capitalize(token);
      if (!token) continue;
      for (const override of TOKENIZE_OVERRIDES) {
        token = override(token, opts);
        if (!token) break;
      }
      if (!token || seen?.has(token)) continue;
      seen?.add(token);
      yield token;
    }
  }
}

export function* tokenize(...values: unknown[]): Generator<string> {
  yield* tokenizeWithOptions({}, ...values);
}

/**
 * Join tokenized values with `delimiter`. When the next token would push the
 * result over `maxLength`: `trim` stops adding; `empty` returns `""`; `hash`
 * appends a digest of accepted tokens plus the overflow token if the result
 * still fits, otherwise `""`.
 */
export function toIdentifierWithOptions(options: IdentifierOptions, ...values: unknown[]): string {
  const opts: ResolvedIdentifierOptions = {
    ...IDENTIFIER_DEFAULTS,
    ...options,
    lowerCase: true,
  };
  const tokens: string[] = [];
  let currentLength = 0;

  for (const token of tokenizeWithOptions(opts, ...values)) {
    const sepLength = tokens.length > 0 ? opts.delimiter.length : 0;
    const nextLength = currentLength + sepLength + token.length;

    if (nextLength > opts.maxLength) {
      if (opts.truncateStrategy === "empty") return "";
      if (opts.truncateStrategy === "trim") break;

      const hash = digestTokens(opts.truncateHashLength, tokens, token);
      if (currentLength + sepLength + hash.length <= opts.maxLength) {
        return tokens.length > 0 ? tokens.join(opts.delimiter) + opts.delimiter + hash : hash;
      }
      return "";
    }

    tokens.push(token);
    currentLength = nextLength;
  }

  return tokens.join(opts.delimiter);
}

export function toIdentifier(...values: unknown[]): string {
  return toIdentifierWithOptions({}, ...values);
}

/**
 * Slugified identifier: same rules as {@link toIdentifierWithOptions} with the
 * delimiter forced to `-`. Accepts {@link KeyOptions} so callers cannot
 * override the delimiter.
 */
export function toSlugWithOptions(options: KeyOptions, ...values: unknown[]): string {
  return toIdentifierWithOptions({ ...options, delimiter: "-" }, ...values);
}

export function toSlug(...values: unknown[]): string {
  return toSlugWithOptions({}, ...values);
}

/**
 * Trim `value` and return `null` for non-strings, `undefined`, or
 * strings that are empty after trimming. Lets call sites collapse the
 * common
 *
 * ```ts
 * typeof v === "string" && v.trim() ? v.trim() : null
 * ```
 *
 * dance into a single helper. Useful for HTTP header / query / form
 * extractors where downstream code wants `string | null` to drive a
 * cheap `??` / `if (x)` cascade.
 */
export function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Config lists arrive either already split (an array) or as one env-var string
// with entries separated by commas and/or whitespace.
const LIST_SEPARATOR_REGEXP = /[\s,]+/;

/**
 * Normalize a config list that may arrive as an array or as a single
 * comma/whitespace-separated string: split, apply `transform`, drop empties,
 * and de-duplicate (first occurrence wins).
 *
 * This is the shape every allow-list / fallback-order setting in this repo
 * takes, because the same value can come from typed config (`string[]`) or from
 * an environment variable (`"a, b c"`). Pass `transform` to normalize entries
 * as they are read; it defaults to trimming.
 *
 * @example
 * parseList("docs.example.com, *.databricks.com");
 * parseList(process.env.MODEL_FALLBACKS);
 * parseList(raw, normalizeUrlPattern);
 */
export function parseList(
  raw: string | readonly string[] | undefined | null,
  transform: (entry: string) => string = (entry) => entry.trim(),
): string[] {
  const entries =
    typeof raw === "string" ? raw.split(LIST_SEPARATOR_REGEXP) : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = transform(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * {@link trimToNull} with an empty-string miss instead of `null`, for callers
 * that build a string unconditionally and treat "absent" as "".
 *
 * Reading loosely-typed JSON is the motivating case: a field that should be a
 * string may be missing or the wrong type, and the caller wants `""` rather
 * than a null check at every access.
 *
 * @example
 * const title = trimToEmpty(record.title); // always a string
 */
export function trimToEmpty(value: unknown): string {
  return trimToNull(value) ?? "";
}

/**
 * Trim the first usable string out of `value`. Returns `null` when
 * `value` is `undefined`, `null`, an empty string, or an array whose
 * first string member is empty. Mirrors how Express / Node header
 * accessors expose single vs. repeated headers - the first
 * non-empty entry wins, everything else is ignored.
 */
export function firstNonEmpty(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const trimmed = trimToNull(item);
      if (trimmed) return trimmed;
    }
    return null;
  }
  return trimToNull(value);
}

/**
 * Escape the five characters significant in HTML text and
 * double-quoted attribute values (`&`, `<`, `>`, `"`, `'`) so an
 * untrusted string can be interpolated into markup without breaking
 * out of its context. `&` is replaced first so ampersands introduced
 * by the later replacements aren't double-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Slugify `value` (using the standard {@link toIdentifierWithOptions}
 * tokenizer + delimiter rules) and **always** suffix a short
 * deterministic hash. Use when you need a stable, slugified id that
 * is guaranteed to be unique across descriptions sharing the same
 * leading tokens (tool ids, cache keys, etc.).
 *
 * Behaviour differs from `toIdentifierWithOptions({ maxLength,
 * truncateStrategy: "hash" })`: that helper only appends a hash when
 * the slug *overflows* `maxLength`. This helper appends a hash
 * unconditionally so the result is collision-resistant even for
 * short inputs. The hash is computed over the raw `value` so two
 * descriptions producing the same slug still get different ids.
 *
 * @param value - Source string (typically a tool/agent description).
 * @param options.delimiter - Token separator (default `"_"`).
 * @param options.slugMaxLength - Cap on the slug portion (the part
 *   before the hash). Default 32.
 * @param options.hashLength - Length of the suffix produced by
 *   {@link fnvHashWithOptions} (Crockford-style base-32 alphabet, max 7
 *   chars). Default 6.
 * @param options.fallbackPrefix - Prefix used when the slug is empty
 *   (e.g. punctuation-only input). Default `"id"`.
 */
export function toUniqueSlug(
  value: string,
  options: {
    delimiter?: string;
    slugMaxLength?: number;
    hashLength?: number;
    fallbackPrefix?: string;
  } = {},
): string {
  const delimiter = options.delimiter ?? "_";
  const slugMaxLength = options.slugMaxLength ?? 32;
  const hashLength = options.hashLength ?? 6;
  const fallbackPrefix = options.fallbackPrefix ?? "id";
  const slug = toIdentifierWithOptions(
    { delimiter, maxLength: slugMaxLength, truncateStrategy: "trim" },
    value,
  );
  const suffix = fnvHashWithOptions({ length: hashLength }, value);
  return slug ? `${slug}${delimiter}${suffix}` : `${fallbackPrefix}${delimiter}${suffix}`;
}

function digestTokens(length: number, parts: readonly string[], extra?: string): string {
  let combined = "";
  for (const part of parts) combined += part + "\0";
  if (extra !== undefined) combined += extra + "\0";
  return fnvHashWithOptions({ length }, combined);
}

/**
 * A node in the description tree consumed by {@link toDescription}.
 *
 * - `string` - a text paragraph.
 * - `Description[]` - a sequence of stacked blocks at the same level
 *   (no list markers). Plain text adjacent to a list (either direction)
 *   flushes together so the prose reads as a lead-in or trailing
 *   summary. Two text paragraphs, two adjacent lists, and anything
 *   touching a map get a blank-line break.
 * - `{ bullets: [...] }` / `{ numbered: [...] }` - explicit list. A
 *   list of one bare string drops its marker (`-` / `1.`); a list of
 *   one item with nested children keeps its marker as the visual anchor
 *   for the indented children.
 * - any other object - headers map: each key becomes a `Header:` line
 *   followed by a blank line and the rendered value.
 */
export type Description = string | readonly Description[] | { readonly [key: string]: Description };

const LIST_KEYS = ["bullets", "numbered"] as const;
type ListKind = (typeof LIST_KEYS)[number];

/**
 * Format a nested description tree as a Markdown-ish string suitable
 * for an LLM system prompt, Zod `.describe()` block, Mastra tool
 * description, or any other long-form text destination.
 *
 * Every string section is dedented (common leading whitespace stripped),
 * right-trimmed line by line, and freed of leading / trailing blank
 * lines, so callers can write multi-line template literals indented
 * naturally in source without leaking that indentation into the
 * consumer-facing output. Plain-string inputs flow through unchanged
 * apart from the same normalization pass, so a single multi-line
 * template literal works directly:
 *
 * ```ts
 * toDescription(`
 *   Ask the Genie space "${alias}" a question.
 *   Pass the answer through as-is.
 * `);
 * // Ask the Genie space "default" a question.
 * // Pass the answer through as-is.
 *
 * toDescription([
 *   `
 *     Ask the Genie space a question.
 *     Phrase it from the user's perspective.
 *   `,
 *   { bullets: [
 *     ["Pass the answer through as-is", { numbered: ["item", "item"] }],
 *   ]},
 *   { Instructions: "Reply with the SQL only." },
 * ]);
 * // Ask the Genie space a question.
 * // Phrase it from the user's perspective.
 * // - Pass the answer through as-is
 * //   1. item
 * //   2. item
 * //
 * // Instructions:
 * //
 * // Reply with the SQL only.
 * ```
 *
 * See {@link Description} for the node grammar.
 */
export function toDescription(node: Description): string {
  return renderBlock(node, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");
}

function renderBlock(node: Description, pad: string): string {
  if (node == null) return "";
  if (typeof node === "string") return prependPad(dedentSection(node), pad);
  if (Array.isArray(node)) return renderSequence(node, pad);
  const kind = listKind(node as Record<string, unknown>);
  if (kind) {
    return renderList((node as Record<ListKind, readonly Description[]>)[kind], pad, kind);
  }
  return renderMap(node as Record<string, Description>, pad);
}

/**
 * Normalize a string section: right-strip every line, drop the
 * common leading-whitespace prefix shared by all non-blank lines,
 * and trim leading / trailing blank lines. Matches Python's
 * `textwrap.dedent` semantics so embedded indented template
 * literals round-trip cleanly.
 */
function dedentSection(text: string): string {
  if (!text) return "";
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  let min = Infinity;
  for (const line of lines) {
    if (!line) continue;
    const match = /^[ \t]*/.exec(line);
    const width = match ? match[0].length : 0;
    if (width < min) min = width;
  }
  const stripped =
    min === Infinity || min === 0 ? lines : lines.map((line) => (line ? line.slice(min) : ""));
  let start = 0;
  let end = stripped.length;
  while (start < end && !stripped[start]) start += 1;
  while (end > start && !stripped[end - 1]) end -= 1;
  return stripped.slice(start, end).join("\n");
}

/**
 * An object is treated as a typed list only when it has exactly one
 * own key, that key is `bullets` or `numbered`, and the value is an
 * array. Everything else is a headers map - so callers wanting a
 * single header literally named `bullets` or `numbered` can use a
 * multi-key map or rename.
 */
function listKind(node: Record<string, unknown>): ListKind | null {
  const keys = Object.keys(node);
  if (keys.length !== 1) return null;
  const key = keys[0]!;
  if ((LIST_KEYS as readonly string[]).includes(key) && Array.isArray(node[key])) {
    return key as ListKind;
  }
  return null;
}

function prependPad(text: string, pad: string): string {
  if (!text) return "";
  if (!pad) return text;
  return text
    .split("\n")
    .map((line) => (line ? pad + line : ""))
    .join("\n");
}

function renderSequence(items: readonly Description[], pad: string): string {
  const rendered: { text: string; node: Description }[] = [];
  for (const item of items) {
    const text = renderBlock(item, pad);
    if (!text) continue;
    rendered.push({ text, node: item });
  }
  if (rendered.length === 0) return "";
  let out = rendered[0]!.text;
  for (let i = 1; i < rendered.length; i += 1) {
    const sep = needsBlankLineBetween(rendered[i - 1]!.node, rendered[i]!.node) ? "\n\n" : "\n";
    out += sep + rendered[i]!.text;
  }
  return out;
}

/**
 * Maps always create their own section boundary (a `Header:` line plus
 * a blank line before the body), so anything touching a map gets a
 * blank-line break. Plain text adjacent to a typed list flushes
 * together in either direction: text-before-list reads as a lead-in,
 * text-after-list as a trailing summary. Two text paragraphs and two
 * adjacent lists both get a blank-line break for legibility.
 */
function needsBlankLineBetween(prev: Description, curr: Description): boolean {
  if (isMap(prev) || isMap(curr)) return true;
  const prevIsText = typeof prev === "string";
  const currIsText = typeof curr === "string";
  if (prevIsText !== currIsText) return false;
  return true;
}

/**
 * A node is a headers map when it is a non-array, non-list object.
 * `bullets` / `numbered` single-key objects are the only structured
 * objects that aren't maps.
 */
function isMap(node: Description): boolean {
  if (node == null) return false;
  if (typeof node === "string") return false;
  if (Array.isArray(node)) return false;
  return listKind(node as Record<string, unknown>) === null;
}

function renderList(items: readonly Description[], pad: string, kind: ListKind): string {
  if (items.length === 0) return "";
  if (items.length === 1 && typeof items[0] === "string") {
    return prependPad(items[0], pad);
  }
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const marker = kind === "bullets" ? "- " : `${i + 1}. `;
    const body = renderBlock(item, "");
    const bodyLines = body.split("\n");
    lines.push(`${pad}${marker}${bodyLines[0] ?? ""}`);
    const continuation = pad + " ".repeat(marker.length);
    for (const line of bodyLines.slice(1)) {
      lines.push(line ? `${continuation}${line}` : "");
    }
  }
  return lines.join("\n");
}

function renderMap(node: Record<string, Description>, pad: string): string {
  const parts: string[] = [];
  for (const [header, value] of Object.entries(node)) {
    const body = renderBlock(value, pad);
    if (!body && !header.trim()) continue;
    const headerLine = header.trim() ? `${pad}${header}:` : "";
    parts.push(body ? `${headerLine}\n\n${body}` : headerLine);
  }
  return parts.join("\n\n");
}

/**
 * Format a count with its noun, pluralizing (naive `+s`) unless the count is 1:
 * `pluralize(1, "barrel")` -> `"1 barrel"`, `pluralize(3, "barrel")` ->
 * `"3 barrels"`. Collapses the `${n} noun${n === 1 ? "" : "s"}` idiom.
 */
export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Title-case a snake / kebab / camel identifier into a human-readable label:
 * tokenize (lowercased, capitalized), then join with spaces. Falls back to
 * the raw `value` when it yields no tokens (e.g. punctuation-only input).
 * `bge_large_en` -> `"Bge Large En"`, `promptId` -> `"Prompt Id"`.
 *
 * The single source of truth for the "humanize a column / field name" idiom -
 * reused by the chat data-grid headers and the export renderer. Extra
 * {@link TokenizeOptions} (e.g. `camelCase: false`) merge over the defaults.
 */
export function toLabel(value: string, options?: TokenizeOptions): string {
  const tokens = [...tokenizeWithOptions({ lowerCase: true, capitalize: true, ...options }, value)];
  return tokens.length > 0 ? tokens.join(" ") : value;
}

/**
 * Upper-case the first character of `value`, leaving the rest untouched.
 * `"working"` -> `"Working"`. Collapses the
 * `s.charAt(0).toUpperCase() + s.slice(1)` idiom.
 */
export function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/* @rs-python
from __future__ import annotations

import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import Any, TypeAlias


Description: TypeAlias = str | Sequence["Description"] | Mapping[str, "Description"]

_TOKENIZE_CAMEL_CASE_REGEXP = re.compile(r"[vV][0-9]+|[A-Z]?[a-z]+|[0-9]+|[A-Z]+(?![a-z])")
_TOKENIZE_NON_ALPHANUMERIC_REGEXP = re.compile(r"[a-zA-Z0-9]+")
_URI_REGEXP = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*)?://([^\s/?#][^\s]*)?$")
_EMAIL_REGEXP = re.compile(
    r"^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)$"
)
_LIST_SEPARATOR_REGEXP = re.compile(r"[\s,]+")
_BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
_MISSING = object()


def _option(options: Mapping[str, Any], camel: str, snake: str, default: Any) -> Any:
    value = options.get(camel, _MISSING)
    if value is _MISSING:
        value = options.get(snake, _MISSING)
    return default if value is _MISSING else value


def _string_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def capitalize(value: str) -> str:
    return value[:1].upper() + value[1:] if value else value


def tokenize_with_options(
    options: Mapping[str, Any] | None = None,
    *values: Any,
) -> Iterator[str]:
    options = options or {}
    distinct = bool(_option(options, "distinct", "distinct", False))
    lower_case = bool(_option(options, "lowerCase", "lower_case", False))
    capitalize_tokens = bool(_option(options, "capitalize", "capitalize", False))
    omit_uri_scheme = bool(_option(options, "omitUriScheme", "omit_uri_scheme", False))
    omit_email_domain = bool(_option(options, "omitEmailDomain", "omit_email_domain", False))
    camel_case = bool(_option(options, "camelCase", "camel_case", True))
    regexp = _TOKENIZE_CAMEL_CASE_REGEXP if camel_case else _TOKENIZE_NON_ALPHANUMERIC_REGEXP
    seen: set[str] | None = set() if distinct else None

    for value in values:
        if value is None:
            continue
        string_value = value if isinstance(value, str) else _string_value(value)
        if not string_value:
            continue
        if omit_uri_scheme:
            match = _URI_REGEXP.fullmatch(string_value)
            if match:
                string_value = match.group(2) or ""
        if omit_email_domain:
            match = _EMAIL_REGEXP.fullmatch(string_value)
            if match:
                string_value = match.group(1) or ""
        if not string_value:
            continue

        for match in regexp.finditer(string_value):
            token = match.group(0)
            if lower_case:
                token = token.lower()
            if capitalize_tokens:
                token = capitalize(token)
                lower = token.lower()
                if lower == "ai":
                    token = "AI"
                elif lower == "fs":
                    token = "FS"
                elif re.fullmatch(r"v[0-9]+", lower):
                    token = f"V{token[1:]}"
            if not token or (seen is not None and token in seen):
                continue
            if seen is not None:
                seen.add(token)
            yield token


def tokenize(*values: Any) -> Iterator[str]:
    yield from tokenize_with_options({}, *values)


def _utf16_units(value: str) -> Iterator[int]:
    encoded = value.encode("utf-16-le", "surrogatepass")
    for index in range(0, len(encoded), 2):
        yield encoded[index] | (encoded[index + 1] << 8)


def _to_base32(value: int, alphabet: str = _BASE32_ALPHABET) -> str:
    value &= 0xFFFFFFFF
    if value == 0:
        return alphabet[0]
    result = ""
    while value > 0:
        result = alphabet[value & 31] + result
        value >>= 5
    return result


def _fnv_hash_string(value: str, length: int = 6) -> str:
    digest = 0x811C9DC5
    for token in ("[", "string:", value, ",", "]"):
        for code_unit in _utf16_units(token):
            digest ^= code_unit
            digest = (digest * 0x01000193) & 0xFFFFFFFF
    return _to_base32(digest).rjust(7, _BASE32_ALPHABET[0])[: min(length, 7)]


def _digest_tokens(length: int, parts: Sequence[str], extra: str | None = None) -> str:
    combined = "".join(f"{part}\0" for part in parts)
    if extra is not None:
        combined += f"{extra}\0"
    return _fnv_hash_string(combined, length)


def to_identifier_with_options(
    options: Mapping[str, Any] | None = None,
    *values: Any,
) -> str:
    options = options or {}
    delimiter = str(_option(options, "delimiter", "delimiter", "-"))
    max_length = _option(options, "maxLength", "max_length", float("inf"))
    truncate_strategy = str(_option(options, "truncateStrategy", "truncate_strategy", "hash"))
    truncate_hash_length = int(
        _option(options, "truncateHashLength", "truncate_hash_length", 6)
    )
    tokenize_options = dict(options)
    tokenize_options["lowerCase"] = True
    tokens: list[str] = []
    current_length = 0

    for token in tokenize_with_options(tokenize_options, *values):
        separator_length = len(delimiter) if tokens else 0
        next_length = current_length + separator_length + len(token)
        if next_length > max_length:
            if truncate_strategy == "empty":
                return ""
            if truncate_strategy == "trim":
                break
            digest = _digest_tokens(truncate_hash_length, tokens, token)
            if current_length + separator_length + len(digest) <= max_length:
                return delimiter.join([*tokens, digest]) if tokens else digest
            return ""
        tokens.append(token)
        current_length = next_length

    return delimiter.join(tokens)


def to_identifier(*values: Any) -> str:
    return to_identifier_with_options({}, *values)


def to_slug_with_options(options: Mapping[str, Any] | None = None, *values: Any) -> str:
    return to_identifier_with_options({**(options or {}), "delimiter": "-"}, *values)


def to_slug(*values: Any) -> str:
    return to_slug_with_options({}, *values)


def trim_to_null(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def parse_list(
    raw: str | Sequence[str] | None,
    transform: Callable[[str], str] = str.strip,
) -> list[str]:
    if isinstance(raw, str):
        entries = _LIST_SEPARATOR_REGEXP.split(raw)
    elif isinstance(raw, Sequence):
        entries = raw
    else:
        entries = []
    output: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        normalized = transform(entry)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        output.append(normalized)
    return output


def trim_to_empty(value: Any) -> str:
    return trim_to_null(value) or ""


def first_non_empty(value: Any) -> str | None:
    if isinstance(value, (list, tuple)):
        for item in value:
            trimmed = trim_to_null(item)
            if trimmed:
                return trimmed
        return None
    return trim_to_null(value)


def escape_html(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def to_unique_slug(value: str, options: Mapping[str, Any] | None = None) -> str:
    options = options or {}
    delimiter = str(_option(options, "delimiter", "delimiter", "_"))
    slug_max_length = int(_option(options, "slugMaxLength", "slug_max_length", 32))
    hash_length = int(_option(options, "hashLength", "hash_length", 6))
    fallback_prefix = str(_option(options, "fallbackPrefix", "fallback_prefix", "id"))
    slug = to_identifier_with_options(
        {
            "delimiter": delimiter,
            "maxLength": slug_max_length,
            "truncateStrategy": "trim",
        },
        value,
    )
    suffix = _fnv_hash_string(value, hash_length)
    prefix = slug or fallback_prefix
    return f"{prefix}{delimiter}{suffix}"


def to_description(node: Description) -> str:
    rendered = re.sub(r"[ \t]+$", "", _render_block(node, ""), flags=re.MULTILINE)
    return re.sub(r"\n+$", "", rendered)


def _render_block(node: Description | None, pad: str) -> str:
    if node is None:
        return ""
    if isinstance(node, str):
        return _prepend_pad(_dedent_section(node), pad)
    if isinstance(node, Sequence) and not isinstance(node, (str, bytes)):
        return _render_sequence(node, pad)
    kind = _list_kind(node)
    if kind:
        return _render_list(node[kind], pad, kind)
    return _render_map(node, pad)


def _dedent_section(text: str) -> str:
    if not text:
        return ""
    lines = [re.sub(r"[ \t]+$", "", line) for line in text.split("\n")]
    widths = [len(re.match(r"^[ \t]*", line).group(0)) for line in lines if line]
    width = min(widths) if widths else 0
    stripped = [line[width:] if line else "" for line in lines]
    while stripped and not stripped[0]:
        stripped.pop(0)
    while stripped and not stripped[-1]:
        stripped.pop()
    return "\n".join(stripped)


def _list_kind(node: Mapping[str, Any]) -> str | None:
    keys = list(node.keys())
    if len(keys) != 1:
        return None
    key = keys[0]
    value = node[key]
    return (
        key
        if key in ("bullets", "numbered")
        and isinstance(value, Sequence)
        and not isinstance(value, (str, bytes))
        else None
    )


def _prepend_pad(text: str, pad: str) -> str:
    if not text or not pad:
        return text
    return "\n".join(f"{pad}{line}" if line else "" for line in text.split("\n"))


def _render_sequence(items: Sequence[Description], pad: str) -> str:
    rendered = [(text, item) for item in items if (text := _render_block(item, pad))]
    if not rendered:
        return ""
    output = rendered[0][0]
    for index in range(1, len(rendered)):
        separator = "\n\n" if _needs_blank_line_between(rendered[index - 1][1], rendered[index][1]) else "\n"
        output += separator + rendered[index][0]
    return output


def _needs_blank_line_between(previous: Description, current: Description) -> bool:
    if _is_map(previous) or _is_map(current):
        return True
    previous_is_text = isinstance(previous, str)
    current_is_text = isinstance(current, str)
    return previous_is_text == current_is_text


def _is_map(node: Description | None) -> bool:
    return isinstance(node, Mapping) and _list_kind(node) is None


def _render_list(items: Sequence[Description], pad: str, kind: str) -> str:
    if not items:
        return ""
    if len(items) == 1 and isinstance(items[0], str):
        return _prepend_pad(items[0], pad)
    lines: list[str] = []
    for index, item in enumerate(items):
        marker = "- " if kind == "bullets" else f"{index + 1}. "
        body_lines = _render_block(item, "").split("\n")
        lines.append(f"{pad}{marker}{body_lines[0] if body_lines else ''}")
        continuation = pad + " " * len(marker)
        lines.extend(f"{continuation}{line}" if line else "" for line in body_lines[1:])
    return "\n".join(lines)


def _render_map(node: Mapping[str, Description], pad: str) -> str:
    parts: list[str] = []
    for header, value in node.items():
        body = _render_block(value, pad)
        if not body and not header.strip():
            continue
        header_line = f"{pad}{header}:" if header.strip() else ""
        parts.append(f"{header_line}\n\n{body}" if body else header_line)
    return "\n\n".join(parts)


def pluralize(count: int | float, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def to_label(value: str, options: Mapping[str, Any] | None = None) -> str:
    merged = {"lowerCase": True, "capitalize": True, **(options or {})}
    tokens = list(tokenize_with_options(merged, value))
    return " ".join(tokens) if tokens else value
@rs-end */
