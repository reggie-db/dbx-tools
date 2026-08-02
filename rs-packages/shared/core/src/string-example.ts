/**
 * Small Rosetta-source example derived from `packages/shared/core/src/string.ts`.
 * The TypeScript below is copied to the Node package. The annotated block is
 * extracted into the matching Python package.
 */

export function trimToEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function trimToNull(value: unknown): string | null {
  return trimToEmpty(value) || null;
}

export function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const trimmed = trimToNull(value);
    if (trimmed) return trimmed;
  }
  return null;
}

export function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/* @rs-python
from typing import Any


def trim_to_empty(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def trim_to_null(value: Any) -> str | None:
    return trim_to_empty(value) or None


def first_non_empty(*values: Any) -> str | None:
    for value in values:
        trimmed = trim_to_null(value)
        if trimmed:
            return trimmed
    return None


def capitalize(value: str) -> str:
    return value[:1].upper() + value[1:] if value else value
@rs-end */
