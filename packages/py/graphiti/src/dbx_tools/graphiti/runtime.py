import logging
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from time import perf_counter
from typing import Any

import httpx
from graphiti_core import Graphiti
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from openai import AsyncOpenAI
from typing_extensions import Self

from ._generated.node.auth.bindings import AuthClient, create_auth_client
from ._generated.node.model.bindings import ModelClient, create_model_client
from ._generated.node.shared_model.openai_chat import chat_content_to_text
from ._generated.sync.postgraph.postgraph_driver import PostGraphDriver
from .database import _DatabaseRuntime, _start_database
from .options import (
    GraphitiOptionsInput,
    ResolvedGraphitiOptionsResponse,
    normalize_graphiti_options,
)

"""Importable Python runtime for Graphiti, model routing, and embedded persistence."""

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class RuntimeClients:
    """Process-wide authentication, model, and Graphiti model clients."""

    auth: AuthClient
    model: ModelClient
    llm: OpenAIGenericClient
    embedder: OpenAIEmbedder
    cross_encoder: OpenAIRerankerClient
    http: httpx.AsyncClient
    llm_model: str
    embedder_model: str
    embedder_dimensions: int


class _DatabricksRouteAuth(httpx.Auth):
    def __init__(self, auth: AuthClient, routes: dict[str, str]) -> None:
        self._auth = auth
        self._routes = {suffix: httpx.URL(url) for suffix, url in routes.items()}

    async def async_auth_flow(self, request: httpx.Request) -> AsyncIterator[httpx.Request]:
        route = next(
            (url for suffix, url in self._routes.items() if request.url.path.endswith(suffix)),
            None,
        )
        if route is None:
            raise RuntimeError(f"No Databricks route configured for {request.url.path}")
        request.url = route
        request.headers.update(await self._auth.headers())
        yield request


class _GraphitiOpenAIGenericClient(OpenAIGenericClient):
    """Normalize provider content parts before Graphiti parses structured JSON."""

    @staticmethod
    def _strip_code_fences(text: Any) -> str:
        """Flatten structured chat content through the shared model owner."""
        return OpenAIGenericClient._strip_code_fences(chat_content_to_text(text))


class GraphitiRuntime(AbstractAsyncContextManager["GraphitiRuntime"]):
    """Start and stop a complete Graphiti runtime without a CLI or HTTP server."""

    def __init__(self, options: GraphitiOptionsInput | None = None) -> None:
        self.options = normalize_graphiti_options(options)
        self.clients: RuntimeClients | None = None
        self.database: _DatabaseRuntime | None = None
        self.graphiti: Graphiti | None = None

    @classmethod
    def from_options(
        cls,
        options: GraphitiOptionsInput | None = None,
    ) -> "GraphitiRuntime":
        """Create a runtime from the same shared option contract used by Node and CLI."""
        return cls(options)

    async def __aenter__(self) -> Self:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def start(self) -> Graphiti:
        """Start model clients and initialize PostgreSQL-backed Graphiti."""
        if self.graphiti is not None:
            return self.graphiti
        started_at = perf_counter()
        database_mode = "external" if self.options.get("databaseUrl") else "embedded"
        _LOGGER.info("Graphiti runtime starting database=%s", database_mode)
        self.clients = await create_runtime_clients(self.options)
        try:
            self.database = await _start_database(self.options)
            driver = PostGraphDriver(
                dsn=self.database.dsn,
                embedding_dim=self.clients.embedder_dimensions,
                connection_options=self.database.connection_options,
            )
            self.graphiti = Graphiti(
                graph_driver=driver,
                llm_client=self.clients.llm,
                embedder=self.clients.embedder,
                cross_encoder=self.clients.cross_encoder,
            )
            await self.graphiti.build_indices_and_constraints()
            _LOGGER.info(
                "Graphiti runtime started database=%s llm_model=%r embedder_model=%r "
                "embedding_dimensions=%d duration_ms=%.1f",
                database_mode,
                self.clients.llm_model,
                self.clients.embedder_model,
                self.clients.embedder_dimensions,
                (perf_counter() - started_at) * 1000,
            )
            return self.graphiti
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        """Close Graphiti and model transports."""
        if self.graphiti is None and self.database is None and self.clients is None:
            return
        started_at = perf_counter()
        _LOGGER.info("Graphiti runtime stopping")
        if self.graphiti is not None:
            await self.graphiti.close()
            self.graphiti = None
        if self.database is not None:
            await self.database.close()
            self.database = None
        if self.clients is not None:
            await self.clients.http.aclose()
            self.clients = None
        _LOGGER.info("Graphiti runtime stopped duration_ms=%.1f", (perf_counter() - started_at) * 1000)


async def create_runtime_clients(
    options: ResolvedGraphitiOptionsResponse,
) -> RuntimeClients:
    """Create authentication and routed OpenAI clients from shared options."""
    profile = options.get("profile")
    auth = await create_auth_client({"profile": profile}) if profile else await create_auth_client()
    model = (
        await create_model_client({"auth": {"profile": profile}})
        if profile
        else await create_model_client()
    )
    chat_route = await model.route(
        {
            "modelClass": options["modelClass"],
            "protocol": "chat",
        }
    )
    matches = await model.search_models({"modelClass": "embedding", "limit": 1})
    if not matches:
        raise RuntimeError("No embedding model is available")
    endpoint = matches[0]["endpoint"]
    embedding_route = await model.route(
        {
            "explicit": endpoint["name"],
            "fuzzy": False,
            "modelClass": "embedding",
            "protocol": "embeddings",
        }
    )
    dimensions = _required_embedding_dimensions(endpoint)
    http = httpx.AsyncClient(
        auth=_DatabricksRouteAuth(
            auth,
            {
                "/chat/completions": chat_route["url"],
                "/embeddings": embedding_route["url"],
            },
        ),
        follow_redirects=True,
        timeout=60,
    )
    openai = AsyncOpenAI(api_key="managed", base_url=chat_route["host"], http_client=http)
    llm_config = LLMConfig(
        api_key="managed",
        base_url=chat_route["host"],
        model=chat_route["modelId"],
        small_model=chat_route["modelId"],
        temperature=float(options["temperature"]),
    )
    llm = _GraphitiOpenAIGenericClient(
        config=llm_config,
        client=openai,
        structured_output_mode=options["structuredOutputMode"],
    )
    embedder = OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            embedding_model=embedding_route["modelId"],
            embedding_dim=dimensions,
        ),
        client=openai,
    )
    return RuntimeClients(
        auth=auth,
        model=model,
        llm=llm,
        embedder=embedder,
        cross_encoder=OpenAIRerankerClient(config=llm_config, client=openai),
        http=http,
        llm_model=chat_route["modelId"],
        embedder_model=embedding_route["modelId"],
        embedder_dimensions=dimensions,
    )


def _required_embedding_dimensions(endpoint: dict[str, object]) -> int:
    """Return positive embedding dimensions published by model discovery."""
    dimension = endpoint.get("dimension")
    if not isinstance(dimension, (int, float)) or int(dimension) <= 0:
        raise RuntimeError(f"Embedding model {endpoint['name']!r} has no dimension metadata")
    return int(dimension)


def configure_graphiti_client(client: Graphiti, clients: RuntimeClients) -> None:
    """Attach shared model clients to every reference held by upstream Graphiti."""
    clients.llm.set_tracer(client.tracer)
    client.llm_client = clients.llm
    client.embedder = clients.embedder
    client.cross_encoder = clients.cross_encoder
    client.clients.llm_client = clients.llm
    client.clients.embedder = clients.embedder
    client.clients.cross_encoder = clients.cross_encoder
    client.nodes.embedder = clients.embedder
    client.edges.embedder = clients.embedder
