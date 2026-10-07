import logging
import os
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from graphiti_core import Graphiti

from ._generated.node.shared_core.bindings import log_level_enabled
from ._generated.node.shared_graphiti.options import graphiti_options_from_environment
from ._generated.sync.graphiti_mcp import graphiti_mcp_server as graphiti_mcp
from ._generated.sync.graphiti_mcp.config.schema import (
    GraphitiConfig,
    OpenAIProviderConfig,
)
from ._generated.sync.graphiti_mcp.services.queue_service import QueueService
from ._generated.sync.graphiti_server.graph_service.routers import ingest, retrieve
from ._generated.sync.graphiti_server.graph_service.zep_graphiti import get_graphiti
from .options import ResolvedGraphitiOptionsResponse, normalize_graphiti_options
from .runtime import GraphitiRuntime, RuntimeClients, configure_graphiti_client

"""Compose Graphiti's existing REST routers and MCP server in one FastAPI app."""

_QUIET_LOGGERS = (
    "httpx",
    "mcp.server.streamable_http",
)
_UPSTREAM_OPENAI_PLACEHOLDER_KEY = "managed"


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
    return normalize_graphiti_options(overrides)


def mcp_settings(
    options: ResolvedGraphitiOptionsResponse,
    llm_model: str | None = None,
    embedder_model: str | None = None,
    embedder_dimensions: int | None = None,
) -> GraphitiConfig:
    """Map shared Graphiti options to the upstream MCP settings."""
    config = GraphitiConfig()
    listen = options["listen"]
    openai = OpenAIProviderConfig(api_key="managed")
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
        }
    )


async def _get_graphiti_with_runtime(
    request: Request,
) -> AsyncIterator[Graphiti]:
    """Yield the singleton Graphiti client to upstream REST routes."""
    runtime: GraphitiRuntime = request.app.state.runtime
    if runtime.clients is None or runtime.graphiti is None:
        raise RuntimeError("Graphiti runtime is not ready")
    yield runtime.graphiti


async def initialize_mcp(
    config: GraphitiConfig | None = None,
    graphiti_client: Graphiti | None = None,
    clients: RuntimeClients | None = None,
) -> None:
    """Initialize Graphiti MCP services without parsing CLI arguments or starting a server."""
    resolved = config or GraphitiConfig()
    service = graphiti_mcp.GraphitiService(
        resolved,
        graphiti_mcp.SEMAPHORE_LIMIT,
    )
    if graphiti_client is None:
        raise RuntimeError("Graphiti client is required")
    service.client = graphiti_client
    service.entity_types = graphiti_mcp.build_entity_types(resolved.graphiti.entity_types)
    service.edge_types = graphiti_mcp.build_edge_types(resolved.graphiti.edge_types)
    service.edge_type_map = graphiti_mcp.build_edge_type_map(resolved.graphiti.edge_type_map)
    client = graphiti_client
    if clients is not None:
        configure_graphiti_client(client, clients)
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
    app.state.ready = False
    runtime = GraphitiRuntime(options)
    await runtime.start()
    app.state.runtime = runtime
    if runtime.clients is None or runtime.graphiti is None:
        raise RuntimeError("Graphiti runtime did not initialize")
    try:
        with _upstream_openai_credentials():
            await initialize_mcp(
                mcp_settings(
                    options,
                    runtime.clients.llm_model,
                    runtime.clients.embedder_model,
                    runtime.clients.embedder_dimensions,
                ),
                runtime.graphiti,
                runtime.clients,
            )
            async with graphiti_mcp.mcp.session_manager.run():
                app.state.ready = True
                yield
    finally:
        app.state.ready = False
        await runtime.close()


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
    ready = bool(getattr(app.state, "ready", False))
    return JSONResponse(
        content={"status": "healthy" if ready else "starting"},
        status_code=200 if ready else 503,
    )
