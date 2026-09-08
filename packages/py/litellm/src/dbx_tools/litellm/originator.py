from __future__ import annotations

from collections.abc import Mapping
from typing import Any

"""Identify the client originator carried through LiteLLM proxy metadata."""

ORIGINATOR_HEADER = "originator"
CODEX_ORIGINATOR_PREFIX = "codex"


def is_codex_originator(value: object) -> bool:
    """Return whether an originator value identifies a Codex client."""
    return (
        isinstance(value, str)
        and bool(normalized := value.strip())
        and normalized.casefold().startswith(CODEX_ORIGINATOR_PREFIX)
    )


def request_originator(data: Mapping[str, Any]) -> str | None:
    """Read the incoming originator from LiteLLM's request snapshots."""
    direct = _originator_from_request(data.get("proxy_server_request"))
    if direct is not None:
        return direct

    for key in ("litellm_params", "metadata", "litellm_metadata"):
        nested = data.get(key)
        if not isinstance(nested, Mapping):
            continue
        value = _originator_from_request(nested.get("proxy_server_request"))
        if value is not None:
            return value
        value = _originator_from_headers(nested.get("headers"))
        if value is not None:
            return value
    return None


def is_codex_request(data: Mapping[str, Any]) -> bool:
    """Return whether LiteLLM metadata identifies an incoming Codex request."""
    return is_codex_originator(request_originator(data))


def forward_codex_originator(data: dict[str, Any]) -> None:
    """Forward the incoming Codex originator through LiteLLM's header parameter."""
    originator = request_originator(data)
    if not is_codex_originator(originator):
        return
    current = data.get("extra_headers")
    headers = dict(current) if isinstance(current, Mapping) else {}
    headers[ORIGINATOR_HEADER] = originator
    data["extra_headers"] = headers


def _originator_from_request(value: object) -> str | None:
    if not isinstance(value, Mapping):
        return None
    return _originator_from_headers(value.get("headers"))


def _originator_from_headers(value: object) -> str | None:
    if not isinstance(value, Mapping):
        return None
    for name, header in value.items():
        if (
            isinstance(name, str)
            and name.casefold() == ORIGINATOR_HEADER
            and isinstance(header, str)
            and (originator := header.strip())
        ):
            return originator
    return None
