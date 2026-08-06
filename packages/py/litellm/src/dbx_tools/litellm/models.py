"""Model routing policy specific to the LiteLLM integration."""

from __future__ import annotations

import re
import threading

from dbx_tools.model import is_responses_only, version_tuple

import litellm

_registered: set[str] = set()
_registry_lock = threading.RLock()

# First GPT minor version that refuses function tools on Chat Completions.
# Databricks answers those with "Function tools with reasoning_effort are not
# supported for <model> in /v1/chat/completions. To use function tools, use
# /v1/responses", so they have to be routed natively.
#
# Verified per endpoint (chat + tools + reasoning_effort): gpt-5, gpt-5-mini,
# gpt-5-nano (5.0) and gpt-5-1 (5.1) all succeed; gpt-5-4-mini (5.4),
# gpt-5-5-pro (5.5) and gpt-5-6-sol (5.6) all reject. gpt-oss is a separate
# family (version_tuple reads its parameter count, e.g. 120b -> 120) and is
# excluded below so it can never trip this threshold.
_GPT_RESPONSES_MIN_MINOR = 4


def requires_responses_api(model: str) -> bool:
    """Return whether a Databricks endpoint rejects Chat Completions.

    Keyed on the model FAMILY and version rather than one-off name fragments: the
    previous `{"gpt", "pro"}` check only caught gpt-5-5-pro and silently sent
    every other new GPT (gpt-5-6-sol, gpt-5-4-mini) down the chat path, where any
    tool-carrying turn fails.
    """
    normalized = model.lower()
    tokens = set(re.findall(r"[a-z0-9]+", normalized))
    if is_responses_only(model):
        return True
    if "gpt" not in tokens or "oss" in tokens:
        return False
    major, minor, _ = version_tuple(normalized)
    return major > 5 or (major == 5 and minor >= _GPT_RESPONSES_MIN_MINOR)


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
