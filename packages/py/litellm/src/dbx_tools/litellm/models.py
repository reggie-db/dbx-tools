"""Model routing policy specific to the LiteLLM integration."""

from __future__ import annotations

import re
import threading

import litellm
from dbx_tools.model import is_responses_only

_registered: set[str] = set()
_registry_lock = threading.RLock()


def requires_responses_api(model: str) -> bool:
    """Return whether a Databricks endpoint rejects Chat Completions."""
    tokens = set(re.findall(r"[a-z0-9]+", model.lower()))
    return is_responses_only(model) or {"gpt", "pro"}.issubset(tokens)


def register_streaming_support(model: str) -> None:
    """Declare a resolved Databricks endpoint as natively streamable.

    LiteLLM decides whether to fake a stream by looking the model up in its
    built-in cost map. Databricks endpoints are absent from that map, and the
    lookup helper reports False on error, so "unknown model" is read as "cannot
    stream" and every streamed response is buffered to completion before any
    event reaches the client. Databricks does emit real SSE deltas, so record
    the capability to keep LiteLLM on its passthrough path.
    """
    qualified = model if model.startswith("databricks/") else f"databricks/{model}"
    with _registry_lock:
        if qualified in _registered:
            return
        _registered.add(qualified)

    litellm.register_model(
        {
            qualified: {
                "litellm_provider": "databricks",
                "mode": "responses" if requires_responses_api(model) else "chat",
                "supports_native_streaming": True,
            }
        }
    )
