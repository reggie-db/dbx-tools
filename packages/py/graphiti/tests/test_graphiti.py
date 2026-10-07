import asyncio
import base64
import importlib
import json
import time
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
import pythonmonkey
from dbx_tools.graphiti import __main__ as graphiti_command
from dbx_tools.graphiti import main
from dbx_tools.graphiti import runtime as graphiti_runtime
from dbx_tools.graphiti._generated.node import _runtime as node_runtime
from dbx_tools.graphiti._generated.node.auth.bindings import create_auth_client
from dbx_tools.graphiti._generated.node.shared_graphiti.options import GraphitiOptions
from dbx_tools.graphiti._generated.sync.postgraph.postgraph.operations.graph_ops import (
    PGGraphMaintenanceOperations,
)
from dbx_tools.graphiti._generated.sync.postgraph.postgraph_driver import PostGraphDriver
from dbx_tools.graphiti.options import normalize_graphiti_options

"""Validate the wrapper-owned composition without re-testing upstream Graphiti."""


def _resolved_options():
    return {
        "model": "chat-model",
        "temperature": 1,
        "embedderModel": "embedding-model",
        "embedderDimensions": 768,
        "structuredOutputMode": "json_object",
        "listen": {"scheme": "tcp", "host": "127.0.0.1", "port": 8100.0},
        "databaseUrl": "postgresql://localhost:5433/graphiti",
        "databaseSchema": "dbx_tools_graphiti",
    }


def _route_paths(routes) -> set[str]:
    paths: set[str] = set()
    for route in routes:
        path = getattr(route, "path", None)
        if isinstance(path, str):
            paths.add(path)
        nested = getattr(route, "routes", None)
        if nested is None:
            nested = getattr(getattr(route, "original_router", None), "routes", ())
        paths.update(_route_paths(nested))
    return paths


@contextmanager
def _node_environment(**values: str | None) -> Iterator[None]:
    read = pythonmonkey.eval("(name) => process.env[name]")
    update = pythonmonkey.eval(
        "(name, value) => value === null ? delete process.env[name] : process.env[name] = value"
    )
    previous = {name: read(name) for name in values}
    try:
        for name, value in values.items():
            update(name, value)
        yield
    finally:
        for name, value in previous.items():
            update(name, value)


def test_app_composes_rest_mcp_and_direct_tool_routes() -> None:
    paths = _route_paths(main.app.routes)

    assert {
        "/docs",
        "/healthcheck",
        "/mcp",
        "/openapi.json",
    }.issubset(paths)
    assert any(path.startswith("/search") for path in paths)
    assert {f"/tools/{name}" for name in main._TOOL_NAMES}.issubset(paths)
    assert "/" in _route_paths(main.mcp_app.routes)
    assert main.app.dependency_overrides[main.get_graphiti] is main._get_graphiti_with_runtime

    openapi = main.app.openapi()
    assert {
        openapi["paths"][f"/tools/{name}"]["post"]["operationId"] for name in main._TOOL_NAMES
    } == set(main._TOOL_NAMES)
    add_memory_schema = openapi["components"]["schemas"]["add_memoryRequest"]
    assert add_memory_schema["properties"]["episode_body"]["description"].startswith(
        "The content of the episode"
    )
    assert add_memory_schema["properties"]["source"]["default"] == "text"
    assert "existing episode" in add_memory_schema["properties"]["uuid"]["description"]
    assert {"name", "episode_body"}.issubset(add_memory_schema["required"])


def test_load_graphiti_options_uses_generated_environment_parser(monkeypatch) -> None:
    calls: list[object] = []
    resolved = _resolved_options()

    def parse(environment):
        calls.append(environment)
        return {"model": "chat-model"}

    def resolve(options):
        calls.append(options)
        return resolved

    monkeypatch.setattr(main, "graphiti_options_from_environment", parse)
    monkeypatch.setattr(main, "normalize_graphiti_options", resolve)

    assert main.load_graphiti_options({"MODEL_NAME": "chat-model"}) is resolved
    assert calls == [{"MODEL_NAME": "chat-model"}, {"model": "chat-model"}]


def test_normalize_graphiti_options_accepts_input_and_resolved_values() -> None:
    resolved = normalize_graphiti_options(GraphitiOptions(model="chat-model"))

    assert resolved["model"] == "chat-model"
    assert "databaseUrl" not in resolved
    assert normalize_graphiti_options(resolved) == resolved


def test_generated_runtime_uses_shared_node_runtime() -> None:
    runtime = node_runtime.get_runtime()

    assert runtime.module("shared_core__bindings") is not None


def test_postgraph_driver_defers_schema_initialization_to_graphiti_runtime() -> None:
    driver = PostGraphDriver(dsn="postgresql://localhost/graphiti")

    assert not hasattr(driver, "_init_task")
    assert driver._client is None


@pytest.mark.asyncio
async def test_postgraph_schema_initialization_surfaces_creation_failures() -> None:
    class Client:
        async def create_vertex_table(self, *_args, **_kwargs) -> None:
            raise RuntimeError("schema is not writable")

    operations = PGGraphMaintenanceOperations(768)
    with pytest.raises(RuntimeError, match="schema is not writable"):
        await operations.build_indices_and_constraints_pg(Client(), 768)


def test_command_uses_standard_asyncio_loop(monkeypatch) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        graphiti_command,
        "load_graphiti_options",
        lambda: {"listen": {"scheme": "tcp", "host": "127.0.0.1", "port": 8100}},
    )
    monkeypatch.setattr(
        graphiti_command.uvicorn,
        "run",
        lambda _app, **options: calls.append(options),
    )

    graphiti_command.main([])

    assert calls == [{"host": "127.0.0.1", "port": 8100, "loop": "asyncio"}]


@pytest.mark.asyncio
async def test_generated_auth_uses_workspace_client_in_databricks_runtime(monkeypatch) -> None:
    def encode(value: dict[str, object]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    access_token = (
        f"{encode({'alg': 'none'})}."
        f"{encode({'exp': int(time.time()) + 3600, 'scope': 'all-apis sql'})}.signature"
    )
    authentications: list[str] = []
    clients: list[object] = []

    class Config:
        auth_type = "runtime"
        client_id = None
        host = "https://workspace.example.com"
        token = None
        username = "runtime-user"

        def authenticate(self) -> dict[str, str]:
            authentications.append("authenticate")
            return {
                "Authorization": f"Bearer {access_token}",
                "X-Runtime-Header": "runtime-value",
            }

    class WorkspaceClient:
        config = Config()

        def __init__(self) -> None:
            clients.append(self)

    monkeypatch.setenv("DATABRICKS_RUNTIME_VERSION", "serverless")
    databricks_sdk = importlib.import_module("databricks.sdk")
    monkeypatch.setattr(databricks_sdk, "WorkspaceClient", WorkspaceClient)

    with _node_environment(
        DBX_TOOLS_DATABRICKS_APP_ENV="false",
        DATABRICKS_APP_PORT=None,
        DATABRICKS_RUNTIME_VERSION="serverless",
    ):
        auth = await create_auth_client()
        assert auth.host == "https://workspace.example.com"
        assert auth.auth_type == "runtime"
        assert auth.principal == "runtime-user"
        assert auth.workspace_id is None
        assert (await auth.token())["accessToken"] == access_token
        assert await auth.headers() == {
            "authorization": f"Bearer {access_token}",
            "x-runtime-header": "runtime-value",
        }
        assert authentications == ["authenticate"]

        assert (await auth.token({"refresh": True}))["accessToken"] == access_token
        assert authentications == ["authenticate", "authenticate"]
        assert len(clients) == 1


def test_upstream_openai_credentials_use_a_scoped_placeholder(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with main._upstream_openai_credentials():
        assert main.os.environ["OPENAI_API_KEY"] == "managed"

    assert "OPENAI_API_KEY" not in main.os.environ
    monkeypatch.setenv("OPENAI_API_KEY", "existing")
    with main._upstream_openai_credentials():
        assert main.os.environ["OPENAI_API_KEY"] == "existing"


def test_shared_options_map_to_mcp_settings() -> None:
    options = _resolved_options()

    mapped_mcp = main.mcp_settings(options)
    assert mapped_mcp.server.host == "127.0.0.1"
    assert mapped_mcp.server.port == 8100
    assert mapped_mcp.llm.model == "chat-model"
    assert mapped_mcp.llm.temperature == 1
    assert mapped_mcp.llm.providers.openai is not None
    assert mapped_mcp.llm.providers.openai.api_url == "https://api.openai.com/v1"
    assert mapped_mcp.llm.structured_output_mode == "json_object"
    assert mapped_mcp.embedder.model == "embedding-model"
    assert mapped_mcp.embedder.providers.openai is not None
    assert mapped_mcp.embedder.providers.openai.api_url == "https://api.openai.com/v1"
    assert mapped_mcp.embedder.dimensions == 768


@pytest.mark.asyncio
async def test_runtime_clients_resolve_ranked_embedding_route(monkeypatch) -> None:
    auth = object()

    class Model:
        def __init__(self) -> None:
            self.searches: list[object] = []
            self.routes: list[object] = []

        async def search_models(self, query):
            self.searches.append(query)
            return [{"endpoint": {"name": "embedding-best", "dimension": 768}}]

        async def route(self, route):
            self.routes.append(route)
            if route["protocol"] == "chat":
                return {
                    "modelId": "chat-best",
                    "host": "https://workspace.example",
                    "url": "https://workspace.example/serving-endpoints/chat/completions",
                }
            return {
                "modelId": "embedding-best",
                "host": "https://workspace.example",
                "url": ("https://workspace.example/serving-endpoints/embedding-best/invocations"),
            }

    model = Model()

    async def create_auth(options=None):
        assert options is None
        return auth

    async def create_model(options=None):
        assert options is None
        return model

    monkeypatch.setattr(graphiti_runtime, "create_auth_client", create_auth)
    monkeypatch.setattr(graphiti_runtime, "create_model_client", create_model)

    runtime = await graphiti_runtime.create_runtime_clients(_resolved_options())
    try:
        assert runtime.auth is auth
        assert runtime.model is model
        assert runtime.llm_model == "chat-best"
        assert runtime.embedder_model == "embedding-best"
        assert runtime.embedder_dimensions == 768
        assert runtime.embedder.config.embedding_model == "embedding-best"
        assert model.searches == [
            {
                "search": "embedding-model",
                "modelClass": "embedding",
                "limit": 1,
            }
        ]
        assert model.routes == [
            {
                "explicit": "chat-model",
                "fuzzy": True,
                "protocol": "chat",
            },
            {
                "explicit": "embedding-best",
                "fuzzy": False,
                "modelClass": "embedding",
                "protocol": "embeddings",
            },
        ]
    finally:
        await runtime.http.aclose()


@pytest.mark.asyncio
async def test_route_auth_refreshes_headers_for_each_request() -> None:
    class Auth:
        def __init__(self) -> None:
            self.calls = 0

        async def headers(self):
            self.calls += 1
            return {"authorization": f"Bearer token-{self.calls}"}

    auth = Auth()
    route_auth = graphiti_runtime._DatabricksRouteAuth(
        auth,
        {
            "/chat/completions": "https://workspace.example/serving-endpoints/chat/completions",
            "/embeddings": ("https://workspace.example/serving-endpoints/embedding/invocations"),
        },
    )

    for path, routed_path, expected in (
        (
            "/chat/completions",
            "/serving-endpoints/chat/completions",
            "Bearer token-1",
        ),
        (
            "/embeddings",
            "/serving-endpoints/embedding/invocations",
            "Bearer token-2",
        ),
    ):
        flow = route_auth.async_auth_flow(
            graphiti_runtime.httpx.Request("POST", f"https://workspace.example{path}")
        )
        request = await anext(flow)
        assert request.url.path == routed_path
        assert request.headers["authorization"] == expected
        await flow.aclose()


@pytest.mark.asyncio
async def test_initialize_mcp_populates_upstream_services(monkeypatch) -> None:
    client = object()
    semaphore = object()
    runtime = object()
    initialized: list[object] = []
    configured: list[object] = []

    class Service:
        def __init__(self, config, semaphore_limit) -> None:
            initialized.extend([config, semaphore_limit])
            self.semaphore = semaphore

    class Queue:
        async def initialize(self, value) -> None:
            initialized.extend(["queue", value])

    config = main.GraphitiConfig()
    monkeypatch.setattr(main.graphiti_mcp, "GraphitiService", Service)
    monkeypatch.setattr(main.graphiti_mcp, "SEMAPHORE_LIMIT", 7)
    monkeypatch.setattr(main, "QueueService", Queue)
    monkeypatch.setattr(
        main,
        "configure_graphiti_client",
        lambda value, clients: configured.extend([value, clients]),
    )

    await main.initialize_mcp(config, client, runtime)

    assert initialized == [config, 7, "queue", client]
    assert configured == [client, runtime]
    assert main.graphiti_mcp.config is config
    assert main.graphiti_mcp.graphiti_client is client
    assert main.graphiti_mcp.semaphore is semaphore
    assert isinstance(main.graphiti_mcp.queue_service, Queue)


@pytest.mark.asyncio
async def test_healthcheck() -> None:
    main.app.state.ready = True
    response = await main.healthcheck()

    assert response.status_code == 200
    assert json.loads(response.body) == {"status": "healthy"}


@pytest.mark.asyncio
async def test_synchronous_add_memory_waits_for_persistence() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    calls: list[dict[str, object]] = []

    class Graphiti:
        async def add_episode(self, **kwargs) -> None:
            calls.append(kwargs)
            started.set()
            await release.wait()

    class Runtime:
        graphiti = Graphiti()

    class Service:
        def __init__(self) -> None:
            self.entity_types = {"entity": object}
            self.edge_types = {"edge": object}
            self.edge_type_map = {("entity", "entity"): ["edge"]}

    main.app.state.runtime = Runtime()
    main.graphiti_mcp.graphiti_service = Service()
    main.graphiti_mcp.config = main.GraphitiConfig()

    pending = asyncio.create_task(
        main.add_memory_sync(
            name="durable memory",
            episode_body="The memory survives a fresh runtime.",
            group_id="notebook-validation",
        )
    )
    await started.wait()
    assert not pending.done()

    release.set()
    response = await pending

    assert response["message"].startswith("Episode 'durable memory' persisted")
    assert calls[0]["group_id"] == "notebook-validation"
    assert calls[0]["episode_body"] == "The memory survives a fresh runtime."


@pytest.mark.asyncio
async def test_queue_monitoring_waits_for_in_flight_work() -> None:
    released = asyncio.Event()

    class Queue:
        async def wait_until_idle(self, group_id) -> None:
            assert group_id == "notebook-validation"
            await released.wait()

        def get_queue_size(self, group_id) -> int:
            assert group_id == "notebook-validation"
            return 0

        def is_worker_running(self, group_id) -> bool:
            assert group_id == "notebook-validation"
            return True

    main.graphiti_mcp.queue_service = Queue()
    main.graphiti_mcp.config = main.GraphitiConfig()

    pending = asyncio.create_task(main.wait_for_memory_queue("notebook-validation"))
    await asyncio.sleep(0)
    assert not pending.done()
    released.set()

    response = await pending
    assert response.group_id == "notebook-validation"
    assert response.pending == 0
    assert response.worker_running is True


@pytest.mark.asyncio
async def test_queue_monitoring_surfaces_processing_errors() -> None:
    class Graphiti:
        async def add_episode(self, **kwargs) -> None:
            raise ValueError(f"cannot persist {kwargs['name']}")

    queue = main.QueueService()
    await queue.initialize(Graphiti())
    await queue.add_episode(
        group_id="notebook-validation",
        name="broken memory",
        content="This write must fail visibly.",
        source_description="test",
        episode_type=main.graphiti_mcp.EpisodeType.text,
        entity_types=None,
        uuid=None,
    )

    with pytest.raises(RuntimeError, match="cannot persist broken memory"):
        await queue.wait_until_idle("notebook-validation")

    await queue.close()


@pytest.mark.asyncio
async def test_runtime_status_uses_postgraph_native_probe() -> None:
    queries: list[str] = []

    class Client:
        async def _fetch(self, query):
            queries.append(query)
            return [{"ok": 1}]

    class Driver:
        provider = "postgraph"
        client = Client()

    class Graphiti:
        driver = Driver()

    class Runtime:
        graphiti = Graphiti()

    main.app.state.ready = True
    main.app.state.runtime = Runtime()

    response = await main.runtime_status()

    assert response["status"] == "ok"
    assert "postgraph" in response["message"]
    assert queries == ["SELECT 1 AS ok"]


@pytest.mark.asyncio
async def test_runtime_status_reports_unready_runtime() -> None:
    main.app.state.ready = False
    main.app.state.runtime = None

    response = await main.runtime_status()

    assert response["status"] == "error"
    assert response["message"] == "Graphiti runtime is not ready"
