/**
 * Flatten unknown JSON into labeled rows for {@link RecordPreview}.
 *
 * @module
 */

import { json, object as objectUtils, stringUtils } from "@dbx-tools/shared-core";

/** One field shown in the table view of {@link RecordPreview}. */
export interface RecordPreviewRow {
  /** Original object key, or `value` for a non-object payload. */
  key: string;
  /** Title-cased label from {@link stringUtils.toLabel}. */
  label: string;
  /** Raw field value, including nested objects and arrays. */
  value: unknown;
}

/** Walk a JSON value into humanized key/value rows. */
export function recordPreviewRows(value: unknown): RecordPreviewRow[] {
  if (value == null) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    return [{ key: "value", label: "Value", value }];
  }
  return Object.entries(value as Record<string, unknown>).map(([key, nested]) => ({
    key,
    label: stringUtils.toLabel(key),
    value: nested,
  }));
}

/** Pretty-print JSON for the raw view; strings stay as authored. */
export function formatRecordPreviewJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Parse a string whose complete value is a serialized JSON object or array. */
export function parseNestedJsonText(
  value: unknown,
): Record<string, unknown> | unknown[] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  const parsed = json.parse(trimmed);
  if (Array.isArray(parsed)) return parsed;
  return objectUtils.isRecord(parsed) ? parsed : undefined;
}

/** YAML document fence at the start of a markdown file (`---` ... `---`). */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Structural markdown markers: ATX headings, fences, quotes, lists, and
 * `[text](url)` links. Requires a space after `#` so paths and hex colors
 * are not treated as headings.
 */
const MARKDOWN_MARKERS = [
  /^#{1,6}\s+\S/m,
  /^```/m,
  /^>\s+\S/m,
  /^\d+\.\s+\S/m,
  /^[-*+]\s+\S/m,
  /\[[^\]]+\]\([^)\s]+\)/,
] as const;

/** True when a string looks like markdown rather than a plain label or path. */
export function looksLikeMarkdown(value: string): boolean {
  const text = value.trim();
  if (text.length < 8) return false;
  if (FRONTMATTER.test(text)) return true;
  return MARKDOWN_MARKERS.some((pattern) => pattern.test(text));
}

/**
 * Rewrite leading YAML frontmatter as a fenced `yaml` block so Streamdown
 * does not turn the `---` fences into horizontal rules.
 */
export function markdownForPreview(value: string): string {
  const trimmed = value.trimStart();
  const match = FRONTMATTER.exec(trimmed);
  if (!match) return value;
  const yaml = match[1]?.trimEnd() ?? "";
  const rest = trimmed.slice(match[0].length);
  return `\`\`\`yaml\n${yaml}\n\`\`\`\n\n${rest}`;
}
