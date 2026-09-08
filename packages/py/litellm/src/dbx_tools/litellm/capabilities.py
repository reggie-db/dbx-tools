from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable, Mapping
from threading import RLock
from typing import Any

import httpx
from cachetools import TTLCache

from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler

"""Adaptive model-parameter capability caching."""

_CAPABILITY_CACHE_TTL_SECONDS = 24 * 60 * 60
_MAX_CAPABILITY_RETRIES = 3
_PROTECTED_PARAMETERS = frozenset({"input", "messages", "model", "stream"})
_REJECTION_PATTERNS = (
    re.compile(r"""unknown field\s+["'](?P<name>[A-Za-z_][\w.-]*)["']""", re.IGNORECASE),
    re.compile(
        r"""does not support(?:\s+the)?\s+["'](?P<name>[A-Za-z_][\w.-]*)["']""",
        re.IGNORECASE,
    ),
    re.compile(r"""unsupported parameter\s+["'](?P<name>[A-Za-z_][\w.-]*)["']""", re.IGNORECASE),
)
_INVALID_RESPONSE_ITEM_ID = re.compile(
    r"""Invalid 'input\[(?P<index>\d+)\]\.id'.*Expected an ID that begins with 'fc'""",
    re.IGNORECASE,
)
_handler: AdaptiveHTTPHandler | None = None
_handler_lock = RLock()
logger = logging.getLogger(__name__)


def _error_message(payload: object) -> str | None:
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, Mapping):
        return None
    error = payload.get("error")
    if isinstance(error, Mapping):
        message = error.get("message")
        if isinstance(message, str):
            return message
    message = payload.get("message")
    return message if isinstance(message, str) else None


def _json_payload(request: httpx.Request) -> Mapping[str, Any] | None:
    try:
        payload = json.loads(request.content)
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, Mapping) else None


def _request_with_payload(
    request: httpx.Request,
    payload: Mapping[str, Any],
) -> httpx.Request:
    content = json.dumps(payload, separators=(",", ":")).encode()
    headers = httpx.Headers(request.headers)
    headers.pop("transfer-encoding", None)
    headers["content-length"] = str(len(content))
    return httpx.Request(
        method=request.method,
        url=request.url,
        headers=headers,
        content=content,
        extensions=request.extensions,
    )


def _repair_response_item_id(
    payload: Mapping[str, Any],
    error_payload: object,
) -> Mapping[str, Any] | None:
    message = _error_message(error_payload)
    match = _INVALID_RESPONSE_ITEM_ID.search(message) if message is not None else None
    items = payload.get("input")
    if match is None or not isinstance(items, list):
        return None
    index = int(match.group("index"))
    if index >= len(items) or not isinstance(items[index], Mapping):
        return None
    item = items[index]
    item_id = item.get("id")
    if not isinstance(item_id, str) or item_id.startswith("fc"):
        return None
    repaired_item = dict(item)
    if repaired_item.get("type") == "function_call" and "call_id" not in repaired_item:
        repaired_item["call_id"] = item_id
    repaired_item.pop("id")
    repaired_items = list(items)
    repaired_items[index] = repaired_item
    return {**payload, "input": repaired_items}


class UnsupportedParameterCache:
    """Cache optional request fields rejected by each resolved model."""

    def __init__(
        self,
        *,
        ttl_seconds: float,
        timer: Callable[[], float] = time.monotonic,
    ) -> None:
        self._cache: TTLCache[str, frozenset[str]] = TTLCache(
            maxsize=256,
            ttl=ttl_seconds,
            timer=timer,
        )
        self._lock = RLock()

    def apply(self, model: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        """Remove fields previously rejected by the resolved model."""
        with self._lock:
            unsupported = self._cache.get(model, frozenset())
        if not unsupported:
            return payload
        return {key: value for key, value in payload.items() if key not in unsupported}

    def learn(
        self,
        model: str,
        error_payload: object,
        request_payload: Mapping[str, Any],
    ) -> str | None:
        """Remember one optional field named by a provider rejection."""
        message = _error_message(error_payload)
        if message is None:
            return None
        for pattern in _REJECTION_PATTERNS:
            match = pattern.search(message)
            if match is None:
                continue
            parameter = match.group("name")
            if parameter in _PROTECTED_PARAMETERS or parameter not in request_payload:
                return None
            with self._lock:
                current = self._cache.get(model, frozenset())
                self._cache[model] = current | {parameter}
            return parameter
        return None

    def parameters(self, model: str) -> frozenset[str]:
        """Return currently cached unsupported fields for tests and diagnostics."""
        with self._lock:
            return self._cache.get(model, frozenset())


class AdaptiveTransport(httpx.AsyncBaseTransport):
    """Retry gateway requests after learning rejected optional fields."""

    def __init__(
        self,
        cache: UnsupportedParameterCache,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        max_retries: int = _MAX_CAPABILITY_RETRIES,
    ) -> None:
        self._cache = cache
        self._transport = transport or httpx.AsyncHTTPTransport()
        self._max_retries = max_retries

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        payload = _json_payload(request)
        model = payload.get("model") if payload is not None else None
        if not isinstance(model, str) or not model:
            return await self._transport.handle_async_request(request)

        capability_key = f"{request.url.scheme}://{request.url.host}{request.url.path}\0{model}"
        active_payload = self._cache.apply(capability_key, payload)
        for attempt in range(self._max_retries + 1):
            response = await self._transport.handle_async_request(
                _request_with_payload(request, active_payload)
            )
            if response.status_code != 400 or attempt == self._max_retries:
                return response
            body = await response.aread()
            try:
                error_payload = json.loads(body)
            except (TypeError, ValueError):
                return response
            parameter = self._cache.learn(capability_key, error_payload, active_payload)
            if parameter is not None:
                logger.info(
                    "Retrying model %s without rejected parameter %s",
                    model,
                    parameter,
                )
                active_payload = self._cache.apply(capability_key, active_payload)
            else:
                repaired = _repair_response_item_id(active_payload, error_payload)
                if repaired is None:
                    return response
                logger.info("Retrying model %s without invalid response item ID", model)
                active_payload = repaired
            await response.aclose()
        return response

    async def aclose(self) -> None:
        await self._transport.aclose()


class AdaptiveHTTPHandler(AsyncHTTPHandler):
    """LiteLLM HTTP handler backed by the adaptive transport."""

    def __init__(self, cache: UnsupportedParameterCache) -> None:
        self._capability_cache = cache
        super().__init__(client_alias="dbx-capabilities")

    def create_client(
        self,
        timeout: float | httpx.Timeout | None,
        event_hooks: Mapping[str, list[Callable[..., object]]] | None,
        ssl_verify: Any = None,
        shared_session: Any = None,
    ) -> httpx.AsyncClient:
        del shared_session
        transport = AdaptiveTransport(
            self._capability_cache,
            transport=httpx.AsyncHTTPTransport(
                verify=True if ssl_verify is None else ssl_verify,
            ),
        )
        return httpx.AsyncClient(
            transport=transport,
            event_hooks=event_hooks,
            timeout=timeout or 600,
            follow_redirects=True,
        )


def adaptive_http_handler() -> AdaptiveHTTPHandler:
    """Return the process-wide capability-aware LiteLLM HTTP handler."""
    global _handler
    with _handler_lock:
        if _handler is None:
            _handler = AdaptiveHTTPHandler(
                UnsupportedParameterCache(ttl_seconds=_CAPABILITY_CACHE_TTL_SECONDS)
            )
        return _handler
