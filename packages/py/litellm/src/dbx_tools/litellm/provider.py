"""Thin LiteLLM provider that adds live Databricks model-name resolution."""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from threading import RLock
from typing import Any, TypeVar, cast
from uuid import uuid4

import litellm
from litellm import CustomLLM
from litellm.exceptions import MidStreamFallbackError, RateLimitError
from litellm.types.utils import (
    EmbeddingResponse,
    GenericStreamingChunk,
    ModelResponse,
    ModelResponseStream,
)

from .backend import DatabricksLiteLLMBackend
from .models import requires_responses_api

logger = logging.getLogger(__name__)

RATE_LIMIT_RETRIES = 5
RETRY_BASE_SECONDS = 2.0
RETRY_MAX_SECONDS = 30.0
_ResponseT = TypeVar("_ResponseT")


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
        return _ensure_response_id(
            litellm.completion(
                model=_delegate_chat_model(resolved),
                messages=_prepare_messages(messages, optional_params),
                stream=False,
                **_delegated_params(optional_params, self.backend, timeout=timeout),
            )
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
        return _ensure_response_id(
            await litellm.acompletion(
                model=_delegate_chat_model(resolved),
                messages=_prepare_messages(messages, optional_params),
                stream=False,
                **_delegated_params(optional_params, self.backend, timeout=timeout),
            )
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
        params = _delegated_params(optional_params, self.backend, timeout=timeout)
        return _retrying_generic_stream(
            lambda: litellm.completion(
                model=_delegate_chat_model(resolved),
                messages=_prepare_messages(messages, optional_params),
                stream=True,
                **params,
            )
        )

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
        params = _delegated_params(optional_params, self.backend, timeout=timeout)

        async def create_stream() -> Any:
            return await litellm.acompletion(
                model=_delegate_chat_model(resolved),
                messages=_prepare_messages(messages, optional_params),
                stream=True,
                **params,
            )

        async for chunk in _retrying_async_generic_stream(create_stream):
            yield chunk

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


def _ensure_response_id(response: _ResponseT) -> _ResponseT:
    response_id = (
        response.get("id") if isinstance(response, dict) else getattr(response, "id", None)
    )
    if isinstance(response_id, str) and response_id:
        return response
    generated = f"chatcmpl-{uuid4().hex}"
    if isinstance(response, dict):
        response["id"] = generated
    else:
        response.id = generated
    return response


def _field(message: Any, name: str) -> Any:
    """Read one field from a message, whichever shape it arrives in.

    Messages are NOT always dicts. LiteLLM's Responses->Chat bridge builds
    `litellm.types.utils.Message`, a pydantic model that supports `.get()` and
    `[]` but is not a `Mapping`. An `isinstance(..., Mapping)` guard therefore
    skips exactly the objects on the Codex path, which is why the earlier
    trailing-assistant repair never fired for the failing requests.
    """
    if isinstance(message, Mapping):
        return message.get(name)
    return getattr(message, name, None)


def _as_dict(message: Any) -> Any:
    """Dict copy of a non-Mapping message, so it can be edited without mutating
    the caller's object. LiteLLM accepts dict messages on every path.

    Returns the original when it cannot be dumped, which keeps a message shape we
    do not recognize passing through untouched rather than dropped.
    """
    dump = getattr(message, "model_dump", None)
    if not callable(dump):
        return message
    dumped = dump(exclude_none=True)
    return dumped if isinstance(dumped, dict) else message


def _is_assistant_message(message: Any) -> bool:
    """Whether a message is an assistant message — the prefill trigger."""
    return _field(message, "role") == "assistant"


def _repair_trailing_assistant(messages: list[Any]) -> list[Any]:
    """Drop trailing assistant turns so the transcript ends where Anthropic can continue.

    Databricks rejects a conversation whose last message is an assistant message:
    "This model does not support assistant message prefill. The conversation must
    end with a user message." (the upstream Bedrock route disallows prefill). The
    Codex CLI hits this on RETRY — a stream that disconnects mid-turn is resumed
    with the partial answer already replayed as the last message, so every
    reconnect fails and the chat dies instead of recovering.

    Dropping is the honest repair, not a lossy one: a trailing assistant turn is
    output the model itself just produced, so it is not context the provider needs
    repeated in order to continue. This includes an unanswered tool call. A client
    that has a tool result sends that result as the terminal tool/user turn; when
    no result follows, replaying the assistant tool call is still an unsupported
    prefill and LiteLLM may separately drop its Responses-only tool definition.
    Appending a synthetic "Continue." user turn would also satisfy the provider,
    but it puts words in the user's mouth that then show up in model context.

    Loops rather than checking once, since several assistant turns can be trailing.
    Never empties the list: an all-assistant transcript is not something this can
    rescue, so it is left for the provider to reject with its own message rather
    than inventing a request.
    """
    if not messages or not _is_assistant_message(messages[-1]):
        return messages
    trimmed = list(messages)
    while trimmed and _is_assistant_message(trimmed[-1]):
        trimmed.pop()
    return trimmed or messages


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
    """Flatten one message's content, including multi-part content blocks.

    Reads through _field so pydantic Message objects are searched too, not just
    plain dicts.
    """
    content = _field(message, "content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(_field(part, "text") or "") for part in content)
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
        if _field(message, "role") != "system"
    ):
        return messages

    # Normalize to dicts so a pydantic Message can be edited without mutating the
    # caller's object; LiteLLM accepts dict messages on every path.
    patched = [dict(m) if isinstance(m, Mapping) else _as_dict(m) for m in messages]
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


def _prepare_messages(messages: list[Any], optional_params: Mapping[str, Any]) -> list[Any]:
    """Apply the request repairs Databricks needs, in order.

    The trailing-assistant repair runs FIRST: it can change which message is last,
    and the json nudge appends to the last non-system turn. Running the nudge first
    would let it append to an assistant turn that is then dropped, silently losing
    the nudge and re-failing the json rule.
    """
    return _ensure_json_mentioned(_repair_trailing_assistant(messages), optional_params)


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


def _retry_delay(error: Exception, attempt: int) -> float:
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if isinstance(headers, Mapping):
        for key in ("retry-after", "x-retry-after"):
            value = headers.get(key)
            try:
                if value is not None and float(value) > 0:
                    return min(float(value), RETRY_MAX_SECONDS)
            except (TypeError, ValueError):
                continue
    ceiling = min(RETRY_BASE_SECONDS * (2**attempt), RETRY_MAX_SECONDS)
    return random.uniform(ceiling / 2, ceiling)


def _is_retryable_rate_limit(error: Exception) -> bool:
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, RateLimitError):
            return True
        current = getattr(current, "original_exception", None) or current.__cause__
    return "REQUEST_LIMIT_EXCEEDED" in str(error)


def _retrying_generic_stream(factory: Callable[[], Any]) -> Iterator[GenericStreamingChunk]:
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        emitted = False
        try:
            for chunk in factory():
                emitted = True
                yield from_chunk(chunk)
            return
        except (MidStreamFallbackError, RateLimitError) as error:
            if emitted or attempt >= RATE_LIMIT_RETRIES or not _is_retryable_rate_limit(error):
                raise
            delay = _retry_delay(error, attempt)
            logger.warning(
                "Rate limited before streaming began; retrying in %.1fs (%d/%d)",
                delay,
                attempt + 1,
                RATE_LIMIT_RETRIES,
            )
            time.sleep(delay)


async def _retrying_async_generic_stream(
    factory: Callable[[], Awaitable[Any]],
) -> AsyncIterator[GenericStreamingChunk]:
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        emitted = False
        try:
            stream = await factory()
            async for chunk in stream:
                emitted = True
                yield from_chunk(chunk)
            return
        except (MidStreamFallbackError, RateLimitError) as error:
            if emitted or attempt >= RATE_LIMIT_RETRIES or not _is_retryable_rate_limit(error):
                raise
            delay = _retry_delay(error, attempt)
            logger.warning(
                "Rate limited before streaming began; retrying in %.1fs (%d/%d)",
                delay,
                attempt + 1,
                RATE_LIMIT_RETRIES,
            )
            await asyncio.sleep(delay)


def from_chunk(chunk: ModelResponseStream) -> GenericStreamingChunk:
    """Adapt a normalized LiteLLM chunk without rebuilding its delta content."""
    _ensure_response_id(chunk)
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
