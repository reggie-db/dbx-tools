from __future__ import annotations

from collections.abc import Mapping
from typing import TypedDict

import httpx


class HttpResult(TypedDict):
    status: int
    headers: dict[str, str]
    body: str


async def execute_http(
    url: str,
    *,
    method: str | None = None,
    headers: Mapping[str, str] | None = None,
    body: str | None = None,
    timeout_ms: int | None = None,
) -> HttpResult:
    """Execute one HTTP request and return a portable response record."""
    if not url.strip():
        raise ValueError("HTTP URL must not be empty")
    timeout = None if timeout_ms is None else timeout_ms / 1000
    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
        response = await client.request(method or "GET", url, headers=headers, content=body)
    return {
        "status": response.status_code,
        "headers": dict(response.headers),
        "body": response.text,
    }
