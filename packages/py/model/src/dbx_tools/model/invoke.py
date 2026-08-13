from __future__ import annotations

import json
import re
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen

"""Model Serving URL, authentication, and JSON invocation helpers."""

INVOCATIONS_SUFFIX = "invocations"
RESPONSES_PATH = "serving-endpoints/responses"
OPEN_RESPONSES_PATH = "serving-endpoints/open-responses"
CHAT_COMPLETIONS_PATH = "serving-endpoints/chat/completions"


class AuthenticatingConfig(Protocol):
    def authenticate(self) -> Mapping[str, str]: ...


class AuthenticatingClientLike(Protocol):
    config: AuthenticatingConfig


@dataclass
class _AuthenticationState:
    """Process-local state that lets concurrent SDK authentication calls converge."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    generation: int = 0
    headers: dict[str, str] | None = None


_AUTHENTICATION_STATES_LOCK = threading.RLock()
_AUTHENTICATION_STATES: dict[int, tuple[AuthenticatingConfig, _AuthenticationState]] = {}


def invocations_url(host: str, endpoint: str) -> str:
    return urljoin(host, f"serving-endpoints/{quote(endpoint, safe='')}/{INVOCATIONS_SUFFIX}")


def responses_url(host: str) -> str:
    return urljoin(host, RESPONSES_PATH)


def open_responses_url(host: str) -> str:
    return urljoin(host, OPEN_RESPONSES_PATH)


def chat_completions_url(host: str) -> str:
    return urljoin(host, CHAT_COMPLETIONS_PATH)


def is_responses_only(endpoint: str) -> bool:
    normalized = endpoint.lower()
    if "codex" in normalized:
        return True
    if re.search(r"gpt[-_. ]?oss", normalized):
        return False
    version = re.search(r"gpt[^0-9]*(\d+)(?:[._-](\d+))?", normalized)
    if version is None:
        return False
    major = int(version.group(1))
    minor = int(version.group(2) or 0)
    return major > 5 or (major == 5 and minor >= 4)


def responses_upstream_url(host: str, endpoint: str) -> str:
    normalized = endpoint.lower()
    openai_family = (
        "gpt" in normalized
        or "codex" in normalized
        or re.search(r"(^|[^a-z])o[1-9]([^a-z]|$)", normalized) is not None
        or "openai" in normalized
    )
    return responses_url(host) if openai_family else open_responses_url(host)


def auth_headers(client: AuthenticatingClientLike) -> dict[str, str]:
    """Authenticate once for each concurrent caller group sharing an SDK config."""
    state = _authentication_state(client.config)
    generation = state.generation
    with state.lock:
        if state.generation != generation and state.headers is not None:
            return dict(state.headers)
        headers = dict(client.config.authenticate())
        state.headers = headers
        state.generation += 1
        return dict(headers)


def _authentication_state(config: AuthenticatingConfig) -> _AuthenticationState:
    key = id(config)
    with _AUTHENTICATION_STATES_LOCK:
        entry = _AUTHENTICATION_STATES.get(key)
        if entry is not None and entry[0] is config:
            return entry[1]
        state = _AuthenticationState()
        _AUTHENTICATION_STATES[key] = (config, state)
        return state


def post_json(
    client: AuthenticatingClientLike,
    url: str,
    body: Mapping[str, object],
    *,
    timeout: float | None = None,
    opener: Callable[..., Any] = urlopen,
) -> object:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    headers.update(auth_headers(client))
    request = Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with opener(request, timeout=timeout) as response:
        return json.loads(response.read())


def invoke_json(
    client: AuthenticatingClientLike,
    host: str,
    endpoint: str,
    body: Mapping[str, object],
    **options: object,
) -> object:
    return post_json(client, invocations_url(host, endpoint), body, **options)
