from __future__ import annotations

from collections.abc import Iterable
from typing import Any

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


def repair_trailing_assistant_messages(messages: list[Any]) -> list[Any]:
    """Remove unsupported trailing assistant-prefill turns.

    Databricks rejects a transcript ending on an assistant text turn. A
    trailing tool call is preserved because the client may be about to answer
    it; an unanswered tool call is a different provider rule. An all-assistant
    transcript is returned unchanged rather than inventing user input.
    """
    if not messages or not _is_removable_assistant_prefill(messages[-1]):
        return messages
    repaired = list(messages)
    while repaired and _is_removable_assistant_prefill(repaired[-1]):
        repaired.pop()
    return repaired or messages


repairTrailingAssistantMessages = repair_trailing_assistant_messages


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


def _message_field(message: object, name: str) -> object:
    if isinstance(message, dict):
        return message.get(name)
    return getattr(message, name, None)


def _is_removable_assistant_prefill(message: object) -> bool:
    return (
        _message_field(message, "role") == "assistant"
        and not _message_field(message, "tool_calls")
        and not _message_field(message, "function_call")
    )
