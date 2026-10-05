"""Generated-model client ownership for the LiteLLM host."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from ._generated import ModelClient, create_model_client

_runtime: ModelProxyRuntime | None = None
_runtime_lock = asyncio.Lock()


class ModelProxyRuntime:
    """Thin asynchronous facade over the generated Node model client."""

    def __init__(self, client: ModelClient) -> None:
        self.client = client
        self._client_lock = asyncio.Lock()

    @classmethod
    async def create(cls) -> ModelProxyRuntime:
        return cls(await create_model_client())

    async def route(
        self,
        requested: str,
        *,
        protocol: str | None = None,
        requires_tools: bool = False,
    ) -> dict[str, Any]:
        options: dict[str, Any] = {
            "explicit": requested,
            "requiresTools": requires_tools,
        }
        if protocol is not None:
            options["protocol"] = protocol
        return await self.client.route(options)

    async def models(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        endpoints = await self.client.list_models(refresh)
        ranked_chat = await self.client.search_models({}, refresh)
        ranked_embeddings = await self.client.search_models(
            {"modelClass": "embedding"},
            refresh,
        )
        ordered = [
            match["endpoint"]
            for match in [*ranked_chat, *ranked_embeddings]
            if isinstance(match.get("endpoint"), Mapping)
        ]
        ranked_names = {endpoint["name"] for endpoint in ordered}
        ordered.extend(endpoint for endpoint in endpoints if endpoint["name"] not in ranked_names)
        metadata = await asyncio.gather(*(self.client.metadata(endpoint) for endpoint in ordered))
        return [
            {**endpoint, "metadata": model_metadata}
            for endpoint, model_metadata in zip(ordered, metadata, strict=True)
        ]

    async def lookup(
        self,
        query: Mapping[str, Any],
        *,
        refresh: bool = False,
    ) -> list[dict[str, Any]]:
        return await self.client.search_models(dict(query), refresh)

    async def status(self) -> dict[str, Any]:
        return await self.client.status()

    async def profiles(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        return await self.client.list_profiles(refresh)

    async def switch_profile(self, profile: str | None) -> dict[str, Any]:
        async with self._client_lock:
            options = {"auth": {"profile": profile}} if profile is not None else {}
            replacement = await create_model_client(options)
            await replacement.list_models(True)
            self.client = replacement
            return await replacement.status()


async def get_runtime() -> ModelProxyRuntime:
    """Return the process-wide lazy runtime."""
    global _runtime
    if _runtime is not None:
        return _runtime
    async with _runtime_lock:
        if _runtime is None:
            _runtime = await ModelProxyRuntime.create()
        return _runtime
