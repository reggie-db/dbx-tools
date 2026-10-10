import asyncio
import logging
import os
import re
import secrets
import signal
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from inspect import Parameter, getdoc, signature
from time import perf_counter
from typing import Any, get_type_hints

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from graphiti_core import Graphiti
from pydantic import BaseModel, Field, create_model
from starlette.middleware.base import RequestResponseEndpoint

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
_HEALTHCHECK_ACCESS = "/healthcheck"
_QUIET_ENDPOINT_METHODS = frozenset({"OPTIONS"})
_QUIET_ENDPOINT_STATUSES = frozenset({307, 308})
_UVICORN_SHUTDOWN = (
    "Shutting down",
    "Waiting for application shutdown",
    "Application shutdown complete",
    "Finished server process",
)
_LOGGER = logging.getLogger(__name__)
_UPSTREAM_OPENAI_PLACEHOLDER_KEY = "managed"
_TOOL_NAMES = (
    "add_memory",
    "add_memory_sync",
    "add_triplet",
    "build_communities",
    "get_episodes",
    "get_queue_status",
    "get_status",
    "search_memory_facts",
    "search_nodes",
    "summarize_saga",
    "wait_for_memory_queue",
)


class _UvicornShutdownFilter(logging.Filter):
    """Drop Uvicorn's repeated SIGINT/SIGTERM teardown lines."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not any(item in message for item in _UVICORN_SHUTDOWN)


def _add_logger_filter(name: str, log_filter: logging.Filter) -> None:
    """Attach ``log_filter`` to a logger once."""
    logger = logging.getLogger(name)
    if not any(isinstance(item, type(log_filter)) for item in logger.filters):
        logger.addFilter(log_filter)


def _configure_dependency_logging() -> None:
    """Restrict routine dependency lifecycle messages to warnings and errors."""
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    _add_logger_filter("uvicorn.error", _UvicornShutdownFilter())
    _add_logger_filter("uvicorn", _UvicornShutdownFilter())
    if not log_level_enabled("debug"):
        for name in _QUIET_LOGGERS:
            logging.getLogger(name).setLevel(logging.WARNING)


_configure_dependency_logging()


def _request_process_shutdown() -> None:
    """Ask the hosting ASGI server to stop through its installed signal handler."""
    signal.raise_signal(signal.SIGTERM)


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
    llm_model: str,
    embedder_model: str,
    embedder_dimensions: int,
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
                    "model": llm_model,
                    "temperature": float(options["temperature"]),
                    "structured_output_mode": options["structuredOutputMode"],
                    "providers": config.llm.providers.model_copy(update={"openai": openai}),
                }
            ),
            "embedder": config.embedder.model_copy(
                update={
                    "model": embedder_model,
                    "dimensions": embedder_dimensions,
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


async def _request_statistics(request: Request) -> dict[str, object]:
    """Return content-free counters for known Graphiti request payloads."""
    if request.method != "POST" or request.url.path not in {"/get-memory", "/messages"}:
        return {}
    try:
        payload = await request.json()
    except (UnicodeDecodeError, ValueError):
        return {}
    if not isinstance(payload, dict):
        return {}
    statistics: dict[str, object] = {}
    group_id = payload.get("group_id")
    if isinstance(group_id, str):
        statistics["group_id"] = group_id
    messages = payload.get("messages")
    if isinstance(messages, list):
        statistics["message_count"] = len(messages)
    max_facts = payload.get("max_facts")
    if isinstance(max_facts, int):
        statistics["max_facts"] = max_facts
    return statistics


def _log_endpoint(
    request: Request,
    status: int,
    started_at: float,
    statistics: dict[str, object],
) -> None:
    """Log one completed semantic endpoint without request or response content."""
    if (
        request.method in _QUIET_ENDPOINT_METHODS
        or request.url.path == _HEALTHCHECK_ACCESS
        or status in _QUIET_ENDPOINT_STATUSES
    ):
        return
    fields: dict[str, object] = {
        "method": request.method,
        "path": request.url.path,
        "status": status,
        "duration_ms": round((perf_counter() - started_at) * 1000, 1),
        **statistics,
    }
    _LOGGER.info(
        "Graphiti endpoint %s",
        " ".join(f"{name}={value!r}" for name, value in fields.items()),
    )


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


async def _close_runtime(app: FastAPI) -> None:
    """Stop the queue and Graphiti runtime if either was started."""
    app.state.ready = False
    failure: BaseException | None = None
    queue = graphiti_mcp.queue_service
    if queue is not None:
        try:
            await queue.close()
        except BaseException as error:
            failure = error
            _LOGGER.exception("Graphiti asynchronous memory queue failed during shutdown")
    runtime = getattr(app.state, "runtime", None)
    if runtime is not None:
        try:
            await runtime.close()
        except BaseException as error:
            if failure is None:
                failure = error
            _LOGGER.exception("Graphiti runtime cleanup failed")
        finally:
            app.state.runtime = None
    if failure is not None:
        raise failure


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Serve OpenAPI immediately, then start Graphiti and MCP in the background.

    Uvicorn only accepts requests after this context yields. Database, model
    routing, and MCP stay off the first-request path so ``/docs`` and
    ``/openapi.json`` are reachable while ``/healthcheck`` still reports
    ``starting``.
    """
    options = load_graphiti_options()
    app.state.bearer = options.get("bearer")
    app.state.failure = None
    app.state.ready = False
    app.state.runtime = None
    shutdown = asyncio.Event()

    async def boot() -> None:
        runtime = GraphitiRuntime(options)
        app.state.runtime = runtime
        try:
            await runtime.start()
            if runtime.clients is None or runtime.graphiti is None:
                raise RuntimeError("Graphiti runtime did not initialize")
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
                    await shutdown.wait()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            app.state.failure = error
            logging.getLogger(__name__).exception("Graphiti runtime failed to start")
            _request_process_shutdown()
        finally:
            await _close_runtime(app)

    task = asyncio.create_task(boot())
    try:
        yield
    finally:
        shutdown.set()
        if not getattr(app.state, "ready", False):
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Graphiti",
    lifespan=lifespan,
)


@app.middleware("http")
async def _require_bearer(
    request: Request,
    call_next: RequestResponseEndpoint,
) -> Response:
    """Require the configured bearer token for every HTTP endpoint."""
    started_at = perf_counter()
    statistics: dict[str, object] = {}
    bearer = getattr(request.app.state, "bearer", None)
    authorization = request.headers.get("authorization", "")
    if bearer and not secrets.compare_digest(authorization, f"Bearer {bearer}"):
        response = JSONResponse(
            {"detail": "Unauthorized"},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
        _log_endpoint(request, response.status_code, started_at, statistics)
        return response
    statistics = await _request_statistics(request)
    try:
        response = await call_next(request)
    except Exception:
        _log_endpoint(request, 500, started_at, statistics)
        raise
    _log_endpoint(request, response.status_code, started_at, statistics)
    return response


app.include_router(retrieve.router)
app.include_router(ingest.router)
app.mount("/mcp", mcp_app)
app.dependency_overrides[get_graphiti] = _get_graphiti_with_runtime


def _tool_request_model(name: str, function: Any) -> type[BaseModel]:
    """Derive a request model from the upstream tool function signature."""
    hints = get_type_hints(function)
    descriptions = _parameter_descriptions(function)
    fields: dict[str, tuple[Any, Any]] = {}
    for parameter in signature(function).parameters.values():
        annotation = hints.get(parameter.name, Any)
        default = ... if parameter.default is Parameter.empty else parameter.default
        fields[parameter.name] = (
            annotation,
            Field(default=default, description=descriptions.get(parameter.name)),
        )
    return create_model(f"{name}Request", **fields)


def _parameter_descriptions(function: Any) -> dict[str, str]:
    """Extract Google-style ``Args`` prose for OpenAPI request properties."""
    doc = getdoc(function) or ""
    lines = doc.splitlines()
    try:
        start = next(index for index, line in enumerate(lines) if line.strip() == "Args:") + 1
    except StopIteration:
        return {}
    descriptions: dict[str, list[str]] = {}
    current: str | None = None
    parameter_line = re.compile(r"^\s{4}([A-Za-z_]\w*)(?:\s*\([^)]*\))?:\s*(.*)$")
    for line in lines[start:]:
        if line and not line.startswith(" "):
            break
        match = parameter_line.match(line)
        if match:
            current = match.group(1)
            descriptions[current] = [match.group(2).strip()]
            continue
        if current and line.strip():
            descriptions[current].append(line.strip())
    return {name: " ".join(part for part in parts if part) for name, parts in descriptions.items()}


def _register_tool_route(name: str) -> None:
    """Publish one upstream Graphiti tool as a direct JSON endpoint."""
    function = (
        add_memory_sync
        if name == "add_memory_sync"
        else queue_status
        if name == "get_queue_status"
        else runtime_status
        if name == "get_status"
        else wait_for_memory_queue
        if name == "wait_for_memory_queue"
        else getattr(graphiti_mcp, name)
    )
    request_model = _tool_request_model(name, function)
    response_model = get_type_hints(function).get("return", Any)

    async def endpoint(request: BaseModel) -> Any:
        return await function(**request.model_dump())

    endpoint.__name__ = f"{name}_endpoint"
    endpoint.__annotations__ = {"request": request_model, "return": response_model}
    app.post(
        f"/tools/{name}",
        operation_id=name,
        summary=name.replace("_", " ").title(),
        description=function.__doc__,
        response_model=response_model,
    )(endpoint)


async def add_memory_sync(
    name: str,
    episode_body: str,
    group_id: str | None = None,
    source: str = "text",
    source_description: str = "",
    uuid: str | None = None,
    reference_time: str | None = None,
    excluded_entity_types: list[str] | None = None,
    custom_extraction_instructions: str | None = None,
    previous_episode_uuids: list[str] | None = None,
    update_communities: bool = False,
    saga: str | None = None,
    saga_previous_episode_uuid: str | None = None,
) -> graphiti_mcp.SuccessResponse | graphiti_mcp.ErrorResponse:
    """Add an episode to memory and return only after Graphiti persists it.

    Args:
        name (str): Name of the episode.
        episode_body (str): The content of the episode to persist to memory. When source='json', this must be a properly escaped JSON string.
        group_id (str, optional): A unique ID for this graph. Uses the configured default when omitted.
        source (str, optional): Source type: text, json, or message.
        source_description (str, optional): Description of the source.
        uuid (str, optional): Optional UUID for the episode.
        reference_time (str, optional): ISO-8601 timestamp for when the described events occurred.
        excluded_entity_types (list[str], optional): Entity type names to exclude from extraction.
        custom_extraction_instructions (str, optional): Additional extraction instructions.
        previous_episode_uuids (list[str], optional): Explicit prior episode UUIDs used as context.
        update_communities (bool, optional): Refresh affected community summaries.
        saga (str, optional): Saga name associated with the episode.
        saga_previous_episode_uuid (str, optional): UUID of the preceding episode in the saga.
    """
    runtime = getattr(app.state, "runtime", None)
    service = graphiti_mcp.graphiti_service
    if runtime is None or runtime.graphiti is None or service is None:
        return graphiti_mcp.ErrorResponse(error="Graphiti runtime is not ready")
    try:
        parsed_reference_time = graphiti_mcp.parse_reference_time(reference_time)
    except ValueError as error:
        return graphiti_mcp.ErrorResponse(error=f"Invalid reference_time: {error}")
    try:
        episode_type = graphiti_mcp.EpisodeType.text
        if source:
            try:
                episode_type = graphiti_mcp.EpisodeType[source.lower()]
            except (KeyError, AttributeError):
                logging.getLogger(__name__).warning(
                    "Unknown source type %r, using text as default", source
                )
        effective_group_id = group_id or graphiti_mcp.config.graphiti.group_id or None
        await runtime.graphiti.add_episode(
            name=name,
            episode_body=episode_body,
            source_description=source_description,
            source=episode_type,
            group_id=effective_group_id,
            reference_time=parsed_reference_time or datetime.now(timezone.utc),
            entity_types=service.entity_types,
            edge_types=service.edge_types,
            edge_type_map=service.edge_type_map,
            excluded_entity_types=excluded_entity_types,
            previous_episode_uuids=previous_episode_uuids,
            custom_extraction_instructions=custom_extraction_instructions,
            update_communities=update_communities,
            saga=saga,
            saga_previous_episode_uuid=saga_previous_episode_uuid,
            uuid=uuid,
        )
        return graphiti_mcp.SuccessResponse(
            message=f"Episode '{name}' persisted in group '{effective_group_id or ''}'"
        )
    except Exception as error:  # noqa: BLE001
        return graphiti_mcp.ErrorResponse(error=f"Error adding episode: {error}")


class QueueStatusResponse(BaseModel):
    """Current state of one Graphiti episode queue."""

    group_id: str = Field(description="Graphiti group whose queue is being inspected.")
    pending: int = Field(description="Number of queued episodes not yet claimed by the worker.")
    worker_running: bool = Field(description="Whether the group queue worker is active.")


async def queue_status(group_id: str | None = None) -> QueueStatusResponse:
    """Get queued episode count and worker state for one Graphiti group.

    Args:
        group_id (str, optional): Graph group to inspect. Uses the configured default when omitted.
    """
    queue = graphiti_mcp.queue_service
    effective_group_id = group_id or graphiti_mcp.config.graphiti.group_id or ""
    if queue is None:
        return QueueStatusResponse(
            group_id=effective_group_id,
            pending=0,
            worker_running=False,
        )
    return QueueStatusResponse(
        group_id=effective_group_id,
        pending=queue.get_queue_size(effective_group_id),
        worker_running=queue.is_worker_running(effective_group_id),
    )


async def wait_for_memory_queue(group_id: str | None = None) -> QueueStatusResponse:
    """Wait until queued and in-flight memory writes finish for one Graphiti group.

    Args:
        group_id (str, optional): Graph group to drain. Uses the configured default when omitted.
    """
    queue = graphiti_mcp.queue_service
    effective_group_id = group_id or graphiti_mcp.config.graphiti.group_id or ""
    if queue is not None:
        await queue.wait_until_idle(effective_group_id)
    return await queue_status(effective_group_id)


async def runtime_status() -> graphiti_mcp.StatusResponse:
    """Get the status of the composed Graphiti runtime and active database driver."""
    runtime = getattr(app.state, "runtime", None)
    if not getattr(app.state, "ready", False) or runtime is None or runtime.graphiti is None:
        return graphiti_mcp.StatusResponse(
            status="error",
            message="Graphiti runtime is not ready",
        )
    try:
        driver = runtime.graphiti.driver
        if getattr(driver, "provider", None) == "postgraph":
            await driver.client._fetch("SELECT 1 AS ok")
        else:
            async with driver.session() as session:
                result = await session.run("MATCH (n) RETURN count(n) as count")
                if result:
                    _ = [record async for record in result]
        provider = getattr(driver, "provider", "configured")
        return graphiti_mcp.StatusResponse(
            status="ok",
            message=f"Graphiti runtime is running and connected to {provider} database",
        )
    except Exception as error:  # noqa: BLE001
        return graphiti_mcp.StatusResponse(
            status="error",
            message=f"Graphiti runtime database connection failed: {error}",
        )


for _tool_name in _TOOL_NAMES:
    _register_tool_route(_tool_name)


@app.get("/healthcheck")
async def healthcheck() -> JSONResponse:
    """Return the Graphiti service health response."""
    ready = bool(getattr(app.state, "ready", False))
    return JSONResponse(
        content={"status": "healthy" if ready else "starting"},
        status_code=200 if ready else 503,
    )
