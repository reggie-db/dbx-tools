import json

import pytest
from dbx_tools.graphiti import main

"""Validate the wrapper-owned composition without re-testing upstream Graphiti."""


def _resolved_options():
    return {
        "model": "chat-model",
        "temperature": 1,
        "embedderModel": "embedding-model",
        "embedderDimensions": 768,
        "structuredOutputMode": "json_object",
        "listen": {"scheme": "tcp", "host": "127.0.0.1", "port": 8100.0},
        "falkorListen": {"scheme": "tcp", "host": "127.0.0.1", "port": 6380.0},
        "falkorDatabase": "graphiti",
        "falkorSnapshotSeconds": 300,
        "falkorSnapshotMinChanges": 1,
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


def test_app_composes_rest_and_mcp_routes() -> None:
    paths = _route_paths(main.app.routes)

    assert {
        "/docs",
        "/healthcheck",
        "/mcp",
        "/openapi.json",
    }.issubset(paths)
    assert any(path.startswith("/search") for path in paths)
    assert "/" in _route_paths(main.mcp_app.routes)
    assert main.app.dependency_overrides[main.get_graphiti] is main._get_graphiti_with_runtime


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
    monkeypatch.setattr(main, "resolve_graphiti_options", resolve)

    assert main.load_graphiti_options({"MODEL_NAME": "chat-model"}) is resolved
    assert calls == [{"MODEL_NAME": "chat-model"}, {"model": "chat-model"}]


def test_upstream_openai_credentials_use_a_scoped_placeholder(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with main._upstream_openai_credentials():
        assert main.os.environ["OPENAI_API_KEY"] == "managed"

    assert "OPENAI_API_KEY" not in main.os.environ
    monkeypatch.setenv("OPENAI_API_KEY", "existing")
    with main._upstream_openai_credentials():
        assert main.os.environ["OPENAI_API_KEY"] == "existing"


def test_shared_options_map_to_both_upstream_settings() -> None:
    options = _resolved_options()

    mapped_rest = main.graph_service_settings(options)
    mapped_mcp = main.mcp_settings(options)

    assert mapped_rest.model_name == "chat-model"
    assert mapped_rest.embedding_model_name == "embedding-model"
    assert mapped_rest.openai_base_url is None
    assert mapped_rest.db_backend == "falkordb"
    assert mapped_rest.falkordb_host == "127.0.0.1"
    assert mapped_rest.falkordb_port == 6380
    assert mapped_rest.falkordb_database == "graphiti"
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
    assert mapped_mcp.database.provider == "falkordb"
    assert mapped_mcp.database.providers.falkordb is not None
    assert mapped_mcp.database.providers.falkordb.uri == "redis://127.0.0.1:6380"
    assert mapped_mcp.database.providers.falkordb.database == "graphiti"


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

    monkeypatch.setattr(main, "create_auth_client", create_auth)
    monkeypatch.setattr(main, "create_model_client", create_model)

    runtime = await main._create_runtime_clients(_resolved_options())
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
    route_auth = main._DatabricksRouteAuth(
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
            main.httpx.Request("POST", f"https://workspace.example{path}")
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

        async def initialize(self) -> None:
            initialized.append("service")

        async def get_client(self):
            return client

    class Queue:
        async def initialize(self, value) -> None:
            initialized.extend(["queue", value])

    config = object()
    monkeypatch.setattr(main.graphiti_mcp, "GraphitiService", Service)
    monkeypatch.setattr(main.graphiti_mcp, "SEMAPHORE_LIMIT", 7)
    monkeypatch.setattr(main, "QueueService", Queue)
    monkeypatch.setattr(
        main,
        "_configure_graphiti_client",
        lambda value, clients: configured.extend([value, clients]),
    )

    await main.initialize_mcp(config, runtime)

    assert initialized == [config, 7, "service", "queue", client]
    assert configured == [client, runtime]
    assert main.graphiti_mcp.config is config
    assert main.graphiti_mcp.graphiti_client is client
    assert main.graphiti_mcp.semaphore is semaphore
    assert isinstance(main.graphiti_mcp.queue_service, Queue)


@pytest.mark.asyncio
async def test_healthcheck() -> None:
    response = await main.healthcheck()

    assert response.status_code == 200
    assert json.loads(response.body) == {"status": "healthy"}
