from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from typing import Any, Protocol
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen

INVOCATIONS_SUFFIX = "invocations"
RESPONSES_PATH = "serving-endpoints/responses"
OPEN_RESPONSES_PATH = "serving-endpoints/open-responses"
CHAT_COMPLETIONS_PATH = "serving-endpoints/chat/completions"


class AuthenticatingConfig(Protocol):
    def authenticate(self) -> Mapping[str, str]: ...


class AuthenticatingClientLike(Protocol):
    config: AuthenticatingConfig


def invocations_url(host: str, endpoint: str) -> str:
    return urljoin(host, f"serving-endpoints/{quote(endpoint, safe='')}/{INVOCATIONS_SUFFIX}")


def responses_url(host: str) -> str:
    return urljoin(host, RESPONSES_PATH)


def open_responses_url(host: str) -> str:
    return urljoin(host, OPEN_RESPONSES_PATH)


def chat_completions_url(host: str) -> str:
    return urljoin(host, CHAT_COMPLETIONS_PATH)


def is_responses_only(endpoint: str) -> bool:
    return "codex" in endpoint.lower()


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
    return dict(client.config.authenticate())


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
