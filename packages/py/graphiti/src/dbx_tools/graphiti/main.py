import logging
import os
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass

import graphiti_mcp_server as graphiti_mcp
import httpx
from config.schema import FalkorDBProviderConfig, GraphitiConfig, OpenAIProviderConfig
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from graph_service.config import Settings, ZepEnvDep
from graph_service.routers import ingest, retrieve
from graph_service.zep_graphiti import ZepGraphiti, get_graphiti, initialize_graphiti
from graphiti_core import Graphiti
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from openai import AsyncOpenAI
from services.queue_service import QueueService

from ._generated.node.auth.bindings import AuthClient, create_auth_client
from ._generated.node.graphiti.options import (
    ResolvedGraphitiOptionsResponse,
    graphiti_options_from_environment,
    resolve_graphiti_options,
)
from ._generated.node.model.bindings import ModelClient, create_model_client
from ._generated.node.shared_core.bindings import log_level_enabled

"""Compose Graphiti's existing REST routers and MCP server in one FastAPI app."""

_QUIET_LOGGERS = (
    "graphiti_core.driver.falkordb_driver",
    "httpx",
    "mcp.server.streamable_http",
)
_UPSTREAM_OPENAI_PLACEHOLDER_KEY = "managed"


@dataclass(frozen=True)
class _GraphitiRuntimeClients:
    """Hold the process-wide Node clients and resolved Graphiti embedder."""

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
    """Route OpenAI requests and attach fresh Databricks authentication headers."""

    def __init__(self, auth: AuthClient, routes: dict[str, str]) -> None:
        self._auth = auth
        self._routes = {suffix: httpx.URL(url) for suffix, url in routes.items()}

    async def async_auth_flow(
        self,
        request: httpx.Request,
    ) -> AsyncIterator[httpx.Request]:
        route = next(
            (url for suffix, url in self._routes.items() if request.url.path.endswith(suffix)),
            None,
        )
        if route is None:
            raise RuntimeError(f"No Databricks route configured for {request.url.path}")
        request.url = route
        request.headers.update(await self._auth.headers())
        yield request


def _configure_dependency_logging() -> None:
    """Restrict routine dependency lifecycle messages to warnings and errors."""
    if not log_level_enabled("debug"):
        for name in _QUIET_LOGGERS:
            logging.getLogger(name).setLevel(logging.WARNING)


_configure_dependency_logging()


@contextmanager
def _upstream_openai_credentials() -> Iterator[None]:
    """Satisfy disposable upstream OpenAI clients until managed clients are attached."""
    existing = os.environ.get("OPENAI_API_KEY")
    if existing is None:
        os.environ["OPENAI_API_KEY"] = _UPSTREAM_OPENAI_PLACEHOLDER_KEY
    try:
        yield
    finally:
        if existing is None:
            os.environ.pop("OPENAI_API_KEY", None)


def load_graphiti_options(
    environment: dict[str, str] | None = None,
) -> ResolvedGraphitiOptionsResponse:
    """Resolve shared Graphiti options from an explicit environment."""
    source = dict(os.environ) if environment is None else environment
    overrides = graphiti_options_from_environment(source)
    return resolve_graphiti_options(overrides)


async def _create_runtime_clients(
    options: ResolvedGraphitiOptionsResponse,
) -> _GraphitiRuntimeClients:
    """Create the process-wide clients and resolve the ranked embedding route."""
    profile = options.get("profile")
    auth = await create_auth_client({"profile": profile}) if profile else await create_auth_client()
    model = (
        await create_model_client({"auth": {"profile": profile}})
        if profile
        else await create_model_client()
    )
    chat_route = await model.route(
        {
            "explicit": options["model"],
            "fuzzy": True,
            "protocol": "chat",
        }
    )
    matches = await model.search_models(
        {
            "search": options["embedderModel"],
            "modelClass": "embedding",
            "limit": 1,
        }
    )
    if not matches:
        raise RuntimeError(f"No embedding model matched {options['embedderModel']!r}")
    endpoint = matches[0]["endpoint"]
    embedding_route = await model.route(
        {
            "explicit": endpoint["name"],
            "fuzzy": False,
            "modelClass": "embedding",
            "protocol": "embeddings",
        }
    )
    dimensions = int(endpoint.get("dimension") or options["embedderDimensions"])
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
    openai = AsyncOpenAI(
        api_key="managed",
        base_url=chat_route["host"],
        http_client=http,
    )
    llm_config = LLMConfig(
        api_key="managed",
        base_url=chat_route["host"],
        model=chat_route["modelId"],
        small_model=chat_route["modelId"],
        temperature=float(options["temperature"]),
    )
    llm = OpenAIGenericClient(
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
    return _GraphitiRuntimeClients(
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


def graph_service_settings(
    options: ResolvedGraphitiOptionsResponse,
    llm_model: str | None = None,
    embedder_model: str | None = None,
) -> Settings:
    """Map shared Graphiti options to the upstream REST settings."""
    falkor_listen = options["falkorListen"]
    return Settings(
        openai_api_key="managed",
        model_name=llm_model or options["model"],
        embedding_model_name=embedder_model or options["embedderModel"],
        db_backend="falkordb",
        falkordb_host=falkor_listen["host"],
        falkordb_port=int(falkor_listen["port"]),
        falkordb_database=options["falkorDatabase"],
    )


def mcp_settings(
    options: ResolvedGraphitiOptionsResponse,
    llm_model: str | None = None,
    embedder_model: str | None = None,
    embedder_dimensions: int | None = None,
) -> GraphitiConfig:
    """Map shared Graphiti options to the upstream MCP settings."""
    config = GraphitiConfig()
    listen = options["listen"]
    falkor_listen = options["falkorListen"]
    openai = OpenAIProviderConfig(api_key="managed")
    falkordb = FalkorDBProviderConfig(
        uri=f"redis://{falkor_listen['host']}:{int(falkor_listen['port'])}",
        database=options["falkorDatabase"],
    )
    return config.model_copy(
        update={
            "server": config.server.model_copy(
                update={
                    "host": listen["host"],
                    "port": int(listen["port"]),
                }
            ),
            "llm": config.llm.model_copy(
                update={
                    "model": llm_model or options["model"],
                    "temperature": float(options["temperature"]),
                    "structured_output_mode": options["structuredOutputMode"],
                    "providers": config.llm.providers.model_copy(update={"openai": openai}),
                }
            ),
            "embedder": config.embedder.model_copy(
                update={
                    "model": embedder_model or options["embedderModel"],
                    "dimensions": embedder_dimensions or int(options["embedderDimensions"]),
                    "providers": config.embedder.providers.model_copy(update={"openai": openai}),
                }
            ),
            "database": config.database.model_copy(
                update={
                    "provider": "falkordb",
                    "providers": config.database.providers.model_copy(
                        update={"falkordb": falkordb}
                    ),
                }
            ),
        }
    )


def _configure_graphiti_client(
    client: Graphiti,
    runtime: _GraphitiRuntimeClients,
) -> None:
    """Attach the process-wide model clients to every upstream Graphiti reference."""
    runtime.llm.set_tracer(client.tracer)
    client.llm_client = runtime.llm
    client.embedder = runtime.embedder
    client.cross_encoder = runtime.cross_encoder
    client.clients.llm_client = runtime.llm
    client.clients.embedder = runtime.embedder
    client.clients.cross_encoder = runtime.cross_encoder
    client.nodes.embedder = runtime.embedder
    client.edges.embedder = runtime.embedder


async def _get_graphiti_with_runtime(
    request: Request,
    settings: ZepEnvDep,
) -> AsyncIterator[ZepGraphiti]:
    """Attach the singleton model clients to each upstream REST Graphiti client."""
    runtime: _GraphitiRuntimeClients = request.app.state.runtime_clients
    async for client in get_graphiti(settings):
        _configure_graphiti_client(client, runtime)
        yield client


async def initialize_mcp(
    config: GraphitiConfig | None = None,
    runtime: _GraphitiRuntimeClients | None = None,
) -> None:
    """Initialize Graphiti MCP services without parsing CLI arguments or starting a server."""
    resolved = config or GraphitiConfig()
    service = graphiti_mcp.GraphitiService(
        resolved,
        graphiti_mcp.SEMAPHORE_LIMIT,
    )
    await service.initialize()
    client = await service.get_client()
    if runtime is not None:
        _configure_graphiti_client(client, runtime)
    queue = QueueService()
    await queue.initialize(client)

    graphiti_mcp.config = resolved
    graphiti_mcp.graphiti_service = service
    graphiti_mcp.graphiti_client = client
    graphiti_mcp.queue_service = queue
    graphiti_mcp.semaphore = service.semaphore


mcp_app = graphiti_mcp.mcp.streamable_http_app(
    streamable_http_path="/",
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialize both upstream applications and own the mounted MCP session manager."""
    options = load_graphiti_options()
    runtime = await _create_runtime_clients(options)
    app.state.runtime_clients = runtime
    try:
        with _upstream_openai_credentials():
            await initialize_graphiti(
                graph_service_settings(
                    options,
                    runtime.llm_model,
                    runtime.embedder_model,
                )
            )
            await initialize_mcp(
                mcp_settings(
                    options,
                    runtime.llm_model,
                    runtime.embedder_model,
                    runtime.embedder_dimensions,
                ),
                runtime,
            )
            async with graphiti_mcp.mcp.session_manager.run():
                yield
    finally:
        await runtime.http.aclose()


app = FastAPI(
    title="Graphiti",
    lifespan=lifespan,
)
app.include_router(retrieve.router)
app.include_router(ingest.router)
app.mount("/mcp", mcp_app)
app.dependency_overrides[get_graphiti] = _get_graphiti_with_runtime


@app.get("/healthcheck")
async def healthcheck() -> JSONResponse:
    """Return the Graphiti service health response."""
    return JSONResponse(content={"status": "healthy"}, status_code=200)
