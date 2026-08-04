from __future__ import annotations

from collections.abc import Iterable

UNSUPPORTED_CHAT_FIELDS = (
    "parallel_tool_calls",
    "store",
    "metadata",
    "service_tier",
    "prompt_cache_key",
    "safety_identifier",
)


def strip_unsupported_chat_fields(body: dict[str, object], extra: Iterable[str] = ()) -> list[str]:
    dropped = []
    for field in (*UNSUPPORTED_CHAT_FIELDS, *extra):
        if field in body:
            del body[field]
            dropped.append(field)
    return dropped


def sanitize_chat_request(body: dict[str, object], extra: Iterable[str] = ()) -> dict[str, object]:
    sanitized = dict(body)
    strip_unsupported_chat_fields(sanitized, extra)
    return sanitized


def chat_content_to_text(
    content: object,
    options: dict[str, object] | None = None,
    *,
    separator: str = "",
    types: Iterable[str] | None = None,
) -> str:
    if options:
        separator = str(options.get("separator", separator))
        option_types = options.get("types")
        if isinstance(option_types, list) and all(isinstance(value, str) for value in option_types):
            types = option_types
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    accepted = set(types) if types is not None else None
    parts = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if accepted is not None and part.get("type") not in accepted:
            continue
        text = part.get("text")
        if isinstance(text, str):
            parts.append(text)
    return separator.join(parts)
