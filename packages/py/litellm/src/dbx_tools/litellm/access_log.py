"""One-line-per-request access log with streaming and cache diagnostics.

LiteLLM's own debug output renders whole request payloads, which buries the few
numbers that explain a slow turn. This logger emits a single line per call
carrying time to first token, total time, token counts, prompt-cache hits, and
whether the stream was real or replayed from a buffered response.
"""

from __future__ import annotations

import logging
import os
import sys
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from threading import Lock
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

LOGGER_NAME = "dbx_tools.litellm.access"
LEVEL_ENV = "DBX_LITELLM_ACCESS_LOG_LEVEL"

# A faked stream emits nothing until the upstream response is fully buffered, so
# its first token lands with the final one. Real streams separate the two by the
# generation time, far above any plausible scheduling jitter.
FAKE_STREAM_EPSILON = 0.01
MAX_REASONING_LOG_ENTRIES = 4096


@dataclass(frozen=True)
class ReasoningLogState:
    requested: str
    selected: str | None = None


_reasoning_log_state: OrderedDict[str, ReasoningLogState] = OrderedDict()
_reasoning_log_lock = Lock()


def record_reasoning_log_state(
    call_id: str | None,
    *,
    requested: str,
    selected: str | None = None,
) -> None:
    if not call_id:
        return
    with _reasoning_log_lock:
        current = _reasoning_log_state.get(call_id)
        _reasoning_log_state[call_id] = ReasoningLogState(
            requested=requested,
            selected=selected if selected is not None else current.selected if current else None,
        )
        _reasoning_log_state.move_to_end(call_id)
        while len(_reasoning_log_state) > MAX_REASONING_LOG_ENTRIES:
            _reasoning_log_state.popitem(last=False)


def reasoning_log_state(kwargs: dict[str, Any]) -> ReasoningLogState | None:
    call_id = _call_id(kwargs)
    if call_id is None:
        return None
    with _reasoning_log_lock:
        return _reasoning_log_state.get(call_id)


def _build_logger() -> logging.Logger:
    """Attach a dedicated handler so access lines survive LiteLLM's log setup.

    The proxy leaves the root logger at WARNING, which would drop these records
    entirely. Owning the handler also keeps one request on one line regardless of
    the surrounding debug formatting.
    """
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(os.getenv(LEVEL_ENV, "INFO").upper())
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter("%(asctime)s dbx-access %(message)s", "%H:%M:%S"))
        logger.addHandler(handler)
    # Keep these lines out of the root handler to avoid duplicate output.
    logger.propagate = False
    return logger


logger = _build_logger()


class DbxAccessLogger(CustomLogger):
    """Log per-request latency, token, and streaming-mode diagnostics."""

    async def async_log_success_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        logger.info(_format(kwargs, status="ok", response_obj=response_obj))

    async def async_log_failure_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        logger.warning(_format(kwargs, status="error", response_obj=response_obj))


def _format(kwargs: dict[str, Any], *, status: str, response_obj: Any = None) -> str:
    payload = kwargs.get("standard_logging_object") or {}
    fields: list[str] = [
        f"status={status}",
        f"ip={_request_ip(kwargs, payload) or 'unknown'}",
        f"requested_model={_requested_model(kwargs, payload) or 'unknown'}",
        f"model={payload.get('model') or kwargs.get('model')}",
        f"call={payload.get('call_type') or kwargs.get('call_type')}",
    ]

    thinking = reasoning_log_state(kwargs)
    if thinking is not None:
        fields.append(f"thinking_requested={thinking.requested}")
        if thinking.selected is not None:
            fields.append(f"thinking_selected={thinking.selected}")

    started = payload.get("startTime")
    completed = payload.get("completionStartTime")
    ended = payload.get("endTime")
    total = _elapsed(started, ended)
    ttft = _elapsed(started, completed)

    if ttft is not None:
        fields.append(f"ttft={ttft:.2f}s")
    if total is not None:
        fields.append(f"total={total:.2f}s")

    streaming = bool(payload.get("stream") or kwargs.get("stream"))
    fields.append(f"stream={streaming}")
    if streaming:
        # completionStartTime defaults to the end of the call, so a faked stream
        # reports the two as equal; a real one reports a genuine first-token time.
        emulated = (
            ttft is not None and total is not None and abs(total - ttft) < FAKE_STREAM_EPSILON
        )
        fields.append(f"emulated={emulated}")

    prompt_tokens = payload.get("prompt_tokens")
    completion_tokens = payload.get("completion_tokens")
    if prompt_tokens is not None:
        fields.append(f"in={prompt_tokens}")
    if completion_tokens is not None:
        fields.append(f"out={completion_tokens}")

    usage = _usage(kwargs, payload, response_obj)
    cached = _nested(usage, "prompt_tokens_details", "cached_tokens")
    if cached is not None and prompt_tokens:
        fields.append(f"cached={cached}({100 * cached // prompt_tokens}%)")
    reasoning = _nested(usage, "completion_tokens_details", "reasoning_tokens")
    if reasoning:
        fields.append(f"reasoning={reasoning}")

    if completion_tokens and total and total > 0:
        fields.append(f"tok/s={completion_tokens / total:.1f}")

    error = payload.get("error_str") or kwargs.get("exception")
    if error:
        fields.append(f"error={str(error)[:200]!r}")

    return " ".join(fields)


def normalize_request_ip(value: Any) -> str | None:
    """Return the originating address from one IP or a forwarded IP chain."""
    if not isinstance(value, str):
        return None
    address = value.split(",", 1)[0].strip()
    return address or None


def _requested_model(kwargs: Mapping[str, Any], payload: Mapping[str, Any]) -> str | None:
    metadata = payload.get("metadata")
    request_metadata = metadata if isinstance(metadata, Mapping) else {}
    litellm_metadata = kwargs.get("litellm_metadata")
    call_metadata = litellm_metadata if isinstance(litellm_metadata, Mapping) else {}
    values = (
        kwargs.get("_litellm_client_requested_model"),
        payload.get("model_group"),
        request_metadata.get("model_group"),
        call_metadata.get("model_group"),
        kwargs.get("model_group"),
        kwargs.get("model"),
    )
    return next(
        (value.strip() for value in values if isinstance(value, str) and value.strip()), None
    )


def _request_ip(kwargs: Mapping[str, Any], payload: Mapping[str, Any]) -> str | None:
    metadata = payload.get("metadata")
    request_metadata = metadata if isinstance(metadata, Mapping) else {}
    litellm_metadata = kwargs.get("litellm_metadata")
    call_metadata = litellm_metadata if isinstance(litellm_metadata, Mapping) else {}
    values = (
        payload.get("requester_ip_address"),
        request_metadata.get("requester_ip_address"),
        call_metadata.get("requester_ip_address"),
        kwargs.get("requester_ip_address"),
    )
    return next((address for value in values if (address := normalize_request_ip(value))), None)


def _elapsed(start: Any, end: Any) -> float | None:
    if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
        return None
    return max(0.0, float(end) - float(start))


def _usage(
    kwargs: dict[str, Any], payload: dict[str, Any], response_obj: Any = None
) -> dict[str, Any]:
    """Find the usage block, which moves around by call type and stream mode.

    On the streaming Responses path hidden_params carries no usage_object, so the
    response object (or the aggregated streaming response) is the only place the
    cache counters appear.
    """
    hidden = payload.get("hidden_params") or {}
    response = payload.get("response")
    candidates = (
        hidden.get("usage_object"),
        getattr(response_obj, "usage", None),
        getattr(kwargs.get("async_complete_streaming_response"), "usage", None),
        getattr(kwargs.get("complete_streaming_response"), "usage", None),
        response.get("usage") if isinstance(response, dict) else None,
        kwargs.get("usage"),
    )
    for usage in candidates:
        if usage is None:
            continue
        if hasattr(usage, "model_dump"):
            usage = usage.model_dump()
        if isinstance(usage, dict) and usage:
            return usage
    return {}


def _nested(usage: dict[str, Any], group: str, field: str) -> int | None:
    details = usage.get(group)
    if hasattr(details, "model_dump"):
        details = details.model_dump()
    if not isinstance(details, dict):
        return None
    value = details.get(field)
    return value if isinstance(value, int) else None


def _call_id(kwargs: dict[str, Any]) -> str | None:
    value = kwargs.get("litellm_call_id")
    if isinstance(value, str) and value:
        return value
    litellm_params = kwargs.get("litellm_params")
    if isinstance(litellm_params, dict):
        value = litellm_params.get("litellm_call_id")
        if isinstance(value, str) and value:
            return value
    return None


dbx_access_logger = DbxAccessLogger()
