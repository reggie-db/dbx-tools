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
            messages=_ensure_json_mentioned(messages, optional_params),
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
            messages=_ensure_json_mentioned(messages, optional_params),
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
            messages=_ensure_json_mentioned(messages, optional_params),
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
            messages=_ensure_json_mentioned(messages, optional_params),
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


# OpenAI-family endpoints refuse `response_format: {"type": "json_object"}` unless
# the prompt itself mentions JSON: "'messages' must contain the word 'json' in some
# form, to use 'response_format' of type 'json_object'" (the Responses surface says
# the same about `text.format`). It is a prompt-content rule, not a param rule, so
# no amount of param filtering satisfies it.
#
# Real callers trip this: Mem0's memory extraction (mem0/memory/main.py) always
# sets json_object while its prompt never says "json", so every memory write fails
# and cross-session memory silently degrades. Mem0 is a vendored dependency we
# can't patch, and we are the last hop before the endpoint, so the nudge goes here
# and fixes every client at once.
_JSON_NUDGE = " Respond with a JSON object."


def _needs_json_nudge(optional_params: Mapping[str, Any]) -> bool:
    response_format = optional_params.get("response_format")
    if not isinstance(response_format, Mapping):
        return False
    return response_format.get("type") == "json_object"


def _message_text(message: Any) -> str:
    """Flatten one message's content, including multi-part content blocks."""
    if not isinstance(message, Mapping):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, Mapping))
    return ""


def _ensure_json_mentioned(messages: list[Any], optional_params: Mapping[str, Any]) -> list[Any]:
    """Append a JSON instruction when json_object is requested but unmentioned.

    Returns `messages` unchanged unless the nudge is actually required, so a
    well-formed request is never rewritten.

    System messages are ignored on BOTH sides of this — when deciding whether the
    word is already present, and when choosing where to put it. LiteLLM's
    chat->Responses bridge hoists system content into the top-level `instructions`
    field, and Databricks only scans `input`, so a mention that lives in a system
    message does not count and a nudge placed there would not be seen either
    (verified against /serving-endpoints/responses).

    This is exactly how Mem0 trips it: its extraction system prompt says "Return
    ONLY valid JSON parsable by json.loads()", so treating a system mention as
    sufficient skipped the nudge while the request still failed upstream. Only a
    user/assistant turn survives into `input` on the Responses path and stays in
    `messages` on the chat path, so one rewrite satisfies both.
    """
    if not _needs_json_nudge(optional_params):
        return messages
    if any(
        "json" in _message_text(message).lower()
        for message in messages
        if not (isinstance(message, Mapping) and message.get("role") == "system")
    ):
        return messages

    patched = [dict(m) if isinstance(m, Mapping) else m for m in messages]
    for message in reversed(patched):
        if not isinstance(message, dict) or message.get("role") == "system":
            continue
        content = message.get("content")
        if isinstance(content, str):
            message["content"] = f"{content}{_JSON_NUDGE}"
            return patched
        if isinstance(content, list):
            # Multi-part content: append a text part rather than rewriting parts.
            message["content"] = [*content, {"type": "text", "text": _JSON_NUDGE.strip()}]
            return patched
    # No usable non-system turn (e.g. a system-only request): add a user turn, the
    # one role that is guaranteed to survive into `input`.
    return [*patched, {"role": "user", "content": _JSON_NUDGE.strip()}]


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
