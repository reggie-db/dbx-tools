"""Thin LiteLLM provider that adds live Databricks model-name resolution."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator, Mapping
from threading import RLock
from typing import Any, cast

import litellm
from litellm import CustomLLM
from litellm.types.utils import (
    EmbeddingResponse,
    GenericStreamingChunk,
    ModelResponse,
    ModelResponseStream,
)

from .backend import DatabricksLiteLLMBackend
from .models import requires_responses_api


class DbxCustomLLM(CustomLLM):
    """Resolve model intent, then delegate unchanged calls to LiteLLM Databricks."""

    def __init__(self) -> None:
        super().__init__()
        self._backend: DatabricksLiteLLMBackend | None = None
        self._backend_lock = RLock()

    @property
    def backend(self) -> DatabricksLiteLLMBackend:
        with self._backend_lock:
            if self._backend is None:
                self._backend = DatabricksLiteLLMBackend()
            return self._backend

    def completion(
        self,
        model: str,
        messages: list[Any],
        optional_params: dict[str, Any],
        timeout: Any = None,
        **_: Any,
    ) -> ModelResponse:
        resolved = self.backend.resolve(model, requires_tools=_requires_tools(optional_params))
        return litellm.completion(
            model=_delegate_chat_model(resolved),
            messages=messages,
            stream=False,
            **_delegated_params(optional_params, self.backend, timeout=timeout),
        )

    async def acompletion(
        self,
        model: str,
        messages: list[Any],
        optional_params: dict[str, Any],
        timeout: Any = None,
        **_: Any,
    ) -> ModelResponse:
        resolved = await asyncio.to_thread(
            self.backend.resolve,
            model,
            requires_tools=_requires_tools(optional_params),
        )
        return await litellm.acompletion(
            model=_delegate_chat_model(resolved),
            messages=messages,
            stream=False,
            **_delegated_params(optional_params, self.backend, timeout=timeout),
        )

    def streaming(
        self,
        model: str,
        messages: list[Any],
        optional_params: dict[str, Any],
        timeout: Any = None,
        **_: Any,
    ) -> Iterator[GenericStreamingChunk]:
        resolved = self.backend.resolve(model, requires_tools=_requires_tools(optional_params))
        stream = litellm.completion(
            model=_delegate_chat_model(resolved),
            messages=messages,
            stream=True,
            **_delegated_params(optional_params, self.backend, timeout=timeout),
        )
        return _generic_stream(stream)

    async def astreaming(
        self,
        model: str,
        messages: list[Any],
        optional_params: dict[str, Any],
        timeout: Any = None,
        **_: Any,
    ) -> AsyncIterator[GenericStreamingChunk]:
        resolved = await asyncio.to_thread(
            self.backend.resolve,
            model,
            requires_tools=_requires_tools(optional_params),
        )
        stream = await litellm.acompletion(
            model=_delegate_chat_model(resolved),
            messages=messages,
            stream=True,
            **_delegated_params(optional_params, self.backend, timeout=timeout),
        )
        async for chunk in stream:
            yield from_chunk(chunk)

    def embedding(
        self,
        model: str,
        input: list[Any],
        optional_params: dict[str, Any],
        timeout: Any = None,
        **_: Any,
    ) -> EmbeddingResponse:
        resolved = self.backend.resolve(model)
        return litellm.embedding(
            model=f"databricks/{resolved}",
            input=input,
            **_delegated_params(optional_params, self.backend, timeout=timeout),
        )

    async def aembedding(
        self,
        model: str,
        input: list[Any],
        optional_params: dict[str, Any],
        timeout: Any = None,
        **_: Any,
    ) -> EmbeddingResponse:
        resolved = await asyncio.to_thread(self.backend.resolve, model)
        return await litellm.aembedding(
            model=f"databricks/{resolved}",
            input=input,
            **_delegated_params(optional_params, self.backend, timeout=timeout),
        )


def _delegate_chat_model(resolved: str) -> str:
    # LiteLLM's own Responses bridge owns Chat<->Responses conversion for
    # Responses-only Databricks models such as Codex.
    infix = "responses/" if requires_responses_api(resolved) else ""
    return f"databricks/{infix}{resolved}"


def _requires_tools(optional_params: Mapping[str, Any]) -> bool:
    tools = optional_params.get("tools")
    return isinstance(tools, list) and bool(tools)


# Params the Chat Completions surface (/serving-endpoints/<name>/invocations)
# refuses with "<name>: Extra inputs are not permitted", failing the whole turn.
# LiteLLM's `drop_params` does not cover these: it only removes params its own
# Databricks allowlist knows about, so an unrecognized key is forwarded verbatim
# and rejected upstream. We are the last hop before that call, so drop them here.
#
# Scoped to the CHAT delegation path on purpose — support is per-surface, and the
# native Responses surfaces accept some of these (open-responses takes
# `client_metadata` and honours `parallel_tool_calls`), so nothing is stripped
# from requests that route natively.
_REJECTED_CHAT_PARAMS = (
    # Codex sends this on every turn; Databricks chat rejects it outright.
    "client_metadata",
)


def _delegated_params(
    optional_params: Mapping[str, Any],
    backend: DatabricksLiteLLMBackend,
    *,
    timeout: Any = None,
) -> dict[str, Any]:
    # These values are supplied explicitly to the nested LiteLLM call. Everything
    # else, including messages, tools, reasoning, and provider options, is left to
    # LiteLLM's built-in Databricks transformations.
    params = dict(optional_params)
    for key in ("model", "messages", "input", "stream"):
        params.pop(key, None)
    for key in _REJECTED_CHAT_PARAMS:
        params.pop(key, None)
    if timeout is not None:
        params.setdefault("timeout", timeout)
    # A cached token keeps the nested call off LiteLLM's per-request SDK auth,
    # which would otherwise construct a WorkspaceClient and mint a fresh token.
    if not params.get("api_key") and not params.get("api_base"):
        credentials = backend.credentials()
        params["api_key"] = credentials.token
        params["api_base"] = credentials.api_base
    return params


def _generic_stream(stream: Any) -> Iterator[GenericStreamingChunk]:
    for chunk in stream:
        yield from_chunk(chunk)


def from_chunk(chunk: ModelResponseStream) -> GenericStreamingChunk:
    """Adapt a normalized LiteLLM chunk without rebuilding its delta content."""
    choice = chunk.choices[0] if chunk.choices else None
    delta = choice.delta if choice is not None else None
    content = getattr(delta, "content", None)
    tool_calls = getattr(delta, "tool_calls", None)
    finish_reason = getattr(choice, "finish_reason", None) if choice is not None else None
    generic = {
        "text": content if isinstance(content, str) else "",
        "tool_use": _dump(tool_calls[0]) if isinstance(tool_calls, list) and tool_calls else None,
        "is_finished": finish_reason is not None,
        "finish_reason": str(finish_reason or ""),
        "usage": _dump(getattr(chunk, "usage", None)),
        "index": getattr(choice, "index", 0) if choice is not None else 0,
        # LiteLLM's CustomStreamWrapper uses this normalized source chunk to
        # retain reasoning, annotations, multiple tool calls, and provider fields.
        "original_chunk": chunk,
    }
    return cast(GenericStreamingChunk, generic)


def _dump(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    return value


dbx_provider = DbxCustomLLM()
