import asyncio
import base64
import importlib
import json
import logging
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
from dbx_tools.graphiti.options import normalize_graphiti_options
from dbx_tools.graphiti.postgraph.driver import PostGraphDriver
from dbx_tools.graphiti.postgraph.operations.graph_ops import (
    PGGraphMaintenanceOperations,
)
from dbx_tools.graphiti.postgraph.operations.search_ops import (
    PGSearchOperations,
)
from fastapi import Request
from fastapi.responses import JSONResponse
from graphiti_core.search.search_filters import SearchFilters

"""Validate the wrapper-owned composition without re-testing upstream Graphiti."""


def _resolved_options():
    return {
        "modelClass": "chat-fast",
        "temperature": 1,
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


def _request(
    path: str,
    authorization: str | None = None,
    *,
    method: str = "GET",
    payload: dict[str, object] | None = None,
) -> Request:
    """Build one HTTP request for direct middleware tests."""
    headers = [] if authorization is None else [(b"authorization", authorization.encode())]
    body = json.dumps(payload).encode() if payload is not None else b""

    async def receive() -> dict[str, object]:
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8100),
            "root_path": "",
            "app": main.app,
        },
        receive,
    )


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


@pytest.mark.asyncio
async def test_optional_bearer_secures_every_http_path() -> None:
    calls: list[str] = []

    async def call_next(request: Request):
        calls.append(request.url.path)
        return JSONResponse({"ok": True})

    main.app.state.bearer = "secret"
    try:
        unauthorized = await main._require_bearer(_request("/openapi.json"), call_next)
        wrong = await main._require_bearer(
            _request("/healthcheck", "Bearer wrong"),
            call_next,
        )
        authorized = await main._require_bearer(
            _request("/tools/get_status", "Bearer secret"),
            call_next,
        )
        main.app.state.bearer = None
        unsecured = await main._require_bearer(_request("/mcp"), call_next)
    finally:
        main.app.state.bearer = None

    assert unauthorized.status_code == 401
    assert unauthorized.headers["www-authenticate"] == "Bearer"
    assert wrong.status_code == 401
    assert authorized.status_code == 200
    assert unsecured.status_code == 200
    assert calls == ["/tools/get_status", "/mcp"]


def test_load_graphiti_options_uses_generated_environment_parser(monkeypatch) -> None:
    calls: list[object] = []
    resolved = _resolved_options()

    def parse(environment):
        calls.append(environment)
        return {"modelClass": "chat-thinking"}

    def resolve(options):
        calls.append(options)
        return resolved

    monkeypatch.setattr(main, "graphiti_options_from_environment", parse)
    monkeypatch.setattr(main, "normalize_graphiti_options", resolve)

    assert main.load_graphiti_options({"MODEL_CLASS": "chat-thinking"}) is resolved
    assert calls == [{"MODEL_CLASS": "chat-thinking"}, {"modelClass": "chat-thinking"}]


def test_normalize_graphiti_options_accepts_input_and_resolved_values() -> None:
    resolved = normalize_graphiti_options(
        GraphitiOptions(model_class="chat-thinking", bearer="secret")
    )

    assert resolved["modelClass"] == "chat-thinking"
    assert resolved["bearer"] == "secret"
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


@pytest.mark.asyncio
async def test_postgraph_fulltext_search_parses_natural_language_as_plain_text() -> None:
    calls: list[tuple[str, tuple[object, ...]]] = []

    class Client:
        async def _fetch(self, query: str, *args: object) -> list[object]:
            calls.append((query, args))
            return []

    class Executor:
        client = Client()

    query = 'user(user): http://127.0.0.1:7272/get-memory & "quoted history"'
    await PGSearchOperations().edge_fulltext_search(Executor(), query, SearchFilters())

    assert len(calls) == 1
    sql, args = calls[0]
    assert sql.count("plainto_tsquery('simple'") == 2
    assert args[-1] == query


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

    assert calls == [
        {
            "host": "127.0.0.1",
            "port": 8100,
            "loop": "asyncio",
            "access_log": False,
        }
    ]


def test_command_exits_nonzero_after_runtime_failure(monkeypatch) -> None:
    monkeypatch.setattr(
        graphiti_command,
        "load_graphiti_options",
        lambda: {"listen": {"scheme": "tcp", "host": "127.0.0.1", "port": 8100}},
    )

    def run(_app, **_options) -> None:
        graphiti_command.app.state.failure = RuntimeError("runtime failed")

    monkeypatch.setattr(graphiti_command.uvicorn, "run", run)

    with pytest.raises(SystemExit) as raised:
        graphiti_command.main([])

    assert raised.value.code == 1


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

    mapped_mcp = main.mcp_settings(options, "chat-model", "embedding-model", 768)
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


def test_embedding_dimensions_require_discovered_metadata() -> None:
    assert (
        graphiti_runtime._required_embedding_dimensions(
            {"name": "embedding-model", "dimension": 768}
        )
        == 768
    )
    with pytest.raises(RuntimeError, match="has no dimension metadata"):
        graphiti_runtime._required_embedding_dimensions({"name": "embedding-model"})


@pytest.mark.asyncio
async def test_runtime_logs_startup_and_shutdown_timing(monkeypatch, caplog) -> None:
    closed: list[str] = []

    class Http:
        async def aclose(self) -> None:
            closed.append("http")

    class Clients:
        llm = object()
        embedder = object()
        cross_encoder = object()
        llm_model = "chat-model"
        embedder_model = "embedding-model"
        embedder_dimensions = 768
        http = Http()

    class Database:
        dsn = "postgresql://localhost/graphiti"

        def __init__(self) -> None:
            self.connection_options: dict[str, object] = {}

        async def close(self) -> None:
            closed.append("database")

    class Graphiti:
        async def build_indices_and_constraints(self) -> None:
            pass

        async def close(self) -> None:
            closed.append("graphiti")

    async def create_clients(_options):
        return Clients()

    async def start_database(_options):
        return Database()

    times = iter([1.0, 1.125, 2.0, 2.025])
    monkeypatch.setattr(graphiti_runtime, "perf_counter", lambda: next(times))
    monkeypatch.setattr(graphiti_runtime, "create_runtime_clients", create_clients)
    monkeypatch.setattr(graphiti_runtime, "_start_database", start_database)
    monkeypatch.setattr(graphiti_runtime, "PostGraphDriver", lambda **_kwargs: object())
    monkeypatch.setattr(graphiti_runtime, "Graphiti", lambda **_kwargs: Graphiti())

    runtime = graphiti_runtime.GraphitiRuntime(_resolved_options())
    with caplog.at_level(logging.INFO, logger=graphiti_runtime.__name__):
        await runtime.start()
        await runtime.close()

    assert any(
        "Graphiti runtime started" in message and "duration_ms=125.0" in message
        for message in caplog.messages
    )
    assert any(
        "Graphiti runtime stopped duration_ms=25.0" in message for message in caplog.messages
    )
    assert closed == ["graphiti", "database", "http"]


def test_llm_client_normalizes_structured_content_before_json_parsing() -> None:
    content = [{"type": "text", "text": '```json\n{"status":"ok"}\n```'}]

    assert (
        graphiti_runtime._GraphitiOpenAIGenericClient._strip_code_fences(content)
        == '{"status":"ok"}'
    )
    assert graphiti_runtime._GraphitiOpenAIGenericClient._strip_code_fences('{"status":"ok"}') == (
        '{"status":"ok"}'
    )


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
    class_runtime = None
    try:
        assert runtime.auth is auth
        assert runtime.model is model
        assert runtime.llm_model == "chat-best"
        assert runtime.embedder_model == "embedding-best"
        assert runtime.embedder_dimensions == 768
        assert runtime.embedder.config.embedding_model == "embedding-best"
        assert model.searches == [
            {
                "modelClass": "embedding",
                "limit": 1,
            }
        ]
        assert model.routes == [
            {
                "modelClass": "chat-fast",
                "protocol": "chat",
            },
            {
                "explicit": "embedding-best",
                "fuzzy": False,
                "modelClass": "embedding",
                "protocol": "embeddings",
            },
        ]
        model.routes.clear()
        class_runtime = await graphiti_runtime.create_runtime_clients(
            {**_resolved_options(), "modelClass": "chat-thinking"}
        )
        assert model.routes[0] == {
            "modelClass": "chat-thinking",
            "protocol": "chat",
        }
    finally:
        await runtime.http.aclose()
        if class_runtime is not None:
            await class_runtime.http.aclose()


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


def test_uvicorn_access_log_is_restricted_to_warnings() -> None:
    main._configure_dependency_logging()

    assert logging.getLogger("uvicorn.access").level == logging.WARNING


@pytest.mark.parametrize(
    ("path", "method", "payload", "status", "expected"),
    [
        (
            "/get-memory",
            "POST",
            {"group_id": "codex-user", "messages": [{}, {}], "max_facts": 12},
            200,
            "group_id='codex-user' message_count=2 max_facts=12",
        ),
        (
            "/messages",
            "POST",
            {"group_id": "codex-user", "messages": [{}]},
            202,
            "group_id='codex-user' message_count=1",
        ),
        ("/openapi.json", "GET", None, 200, "path='/openapi.json' status=200"),
    ],
)
@pytest.mark.asyncio
async def test_endpoint_log_has_timing_and_content_free_statistics(
    monkeypatch,
    caplog,
    path: str,
    method: str,
    payload: dict[str, object] | None,
    status: int,
    expected: str,
) -> None:
    times = iter([1.0, 1.025])
    monkeypatch.setattr(main, "perf_counter", lambda: next(times))

    async def call_next(_: Request) -> JSONResponse:
        return JSONResponse({"content": "not logged"}, status_code=status)

    main.app.state.bearer = None
    with caplog.at_level(logging.INFO, logger=main.__name__):
        await main._require_bearer(
            _request(path, method=method, payload=payload),
            call_next,
        )

    message = caplog.messages[-1]
    assert "duration_ms=25.0" in message
    assert expected in message
    assert "not logged" not in message


@pytest.mark.parametrize(
    ("path", "method", "status"),
    [
        ("/healthcheck", "GET", 200),
        ("/mcp/", "OPTIONS", 405),
        ("/mcp", "POST", 307),
    ],
)
@pytest.mark.asyncio
async def test_noisy_protocol_requests_are_not_logged(
    caplog,
    path: str,
    method: str,
    status: int,
) -> None:
    async def call_next(_: Request) -> JSONResponse:
        return JSONResponse({}, status_code=status)

    main.app.state.bearer = None
    with caplog.at_level(logging.INFO, logger=main.__name__):
        await main._require_bearer(_request(path, method=method), call_next)

    assert caplog.messages == []


def test_uvicorn_shutdown_log_is_filtered() -> None:
    filter = main._UvicornShutdownFilter()
    dropped = logging.LogRecord(
        "uvicorn.error",
        logging.INFO,
        __file__,
        0,
        "Shutting down",
        (),
        None,
    )
    kept = logging.LogRecord(
        "uvicorn.error",
        logging.INFO,
        __file__,
        0,
        "Uvicorn running on http://127.0.0.1:7272 (Press CTRL+C to quit)",
        (),
        None,
    )

    assert filter.filter(dropped) is False
    assert filter.filter(kept) is True


@pytest.mark.asyncio
async def test_docs_are_served_before_runtime_ready(monkeypatch) -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    class Clients:
        llm_model = "chat"
        embedder_model = "embed"
        embedder_dimensions = 8

    class Runtime:
        clients = Clients()
        graphiti = object()

        def __init__(self, options) -> None:
            pass

        async def start(self):
            started.set()
            await release.wait()
            return self.graphiti

        async def close(self) -> None:
            pass

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

    monkeypatch.setattr(main, "load_graphiti_options", lambda: _resolved_options())
    monkeypatch.setattr(main, "GraphitiRuntime", Runtime)
    monkeypatch.setattr(main, "initialize_mcp", lambda *_args, **_kwargs: asyncio.sleep(0))
    monkeypatch.setattr(main.graphiti_mcp.mcp.session_manager, "run", lambda: Session())
    monkeypatch.setattr(main.graphiti_mcp, "queue_service", None)

    async with main.lifespan(main.app):
        await started.wait()
        health = await main.healthcheck()
        assert health.status_code == 503
        assert json.loads(health.body) == {"status": "starting"}
        assert {getattr(route, "path", None) for route in main.app.routes}.issuperset(
            {"/docs", "/openapi.json"}
        )
        assert "/healthcheck" in main.app.openapi()["paths"]
        release.set()
        for _ in range(50):
            if getattr(main.app.state, "ready", False):
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("runtime never became healthy")
        healthy = await main.healthcheck()
        assert healthy.status_code == 200
        assert json.loads(healthy.body) == {"status": "healthy"}


@pytest.mark.parametrize(
    ("failure_stage", "message"),
    [
        ("runtime", "database failed"),
        ("mcp", "MCP failed"),
    ],
)
@pytest.mark.asyncio
async def test_runtime_or_mcp_failure_requests_process_shutdown(
    monkeypatch,
    failure_stage: str,
    message: str,
) -> None:
    shutdown_requested = asyncio.Event()
    closed: list[str] = []

    class Clients:
        llm_model = "chat"
        embedder_model = "embed"
        embedder_dimensions = 8

    class Runtime:
        clients = Clients()
        graphiti = object()

        def __init__(self, _options) -> None:
            pass

        async def start(self) -> None:
            if failure_stage == "runtime":
                raise RuntimeError(message)

        async def close(self) -> None:
            closed.append("runtime")

    async def initialize_mcp(*_args, **_kwargs) -> None:
        if failure_stage == "mcp":
            raise RuntimeError(message)

    monkeypatch.setattr(main, "load_graphiti_options", lambda: _resolved_options())
    monkeypatch.setattr(main, "GraphitiRuntime", Runtime)
    monkeypatch.setattr(main, "initialize_mcp", initialize_mcp)
    monkeypatch.setattr(main, "_request_process_shutdown", shutdown_requested.set)
    monkeypatch.setattr(main.graphiti_mcp, "queue_service", None)

    async with main.lifespan(main.app):
        await asyncio.wait_for(shutdown_requested.wait(), timeout=1)

    assert isinstance(main.app.state.failure, RuntimeError)
    assert str(main.app.state.failure) == message
    assert closed == ["runtime"]


@pytest.mark.asyncio
async def test_runtime_cleanup_closes_database_after_async_queue_failure(monkeypatch) -> None:
    closed: list[str] = []

    class Queue:
        async def close(self) -> None:
            raise RuntimeError("queued write failed")

    class Runtime:
        async def close(self) -> None:
            closed.append("runtime")

    monkeypatch.setattr(main.graphiti_mcp, "queue_service", Queue())
    main.app.state.runtime = Runtime()

    with pytest.raises(RuntimeError, match="queued write failed"):
        await main._close_runtime(main.app)

    assert closed == ["runtime"]
    assert main.app.state.runtime is None


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
async def test_queue_monitoring_surfaces_processing_errors(caplog) -> None:
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

    with (
        caplog.at_level(logging.ERROR),
        pytest.raises(RuntimeError, match="cannot persist broken memory"),
    ):
        await queue.wait_until_idle("notebook-validation")

    await queue.close()
    failures = [
        record
        for record in caplog.records
        if record.getMessage().startswith("Error processing queued episode")
    ]
    assert len(failures) == 1
    assert failures[0].exc_info is not None


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
