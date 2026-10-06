from __future__ import annotations

import asyncio
import json
import sys
import sysconfig
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from dbx_tools.graphiti._generated.node.shared_graphiti.options import (
    resolve_graphiti_options,
)
from dbx_tools.graphiti.constants import UPSTREAM_MCP_PATH_ENV
from dbx_tools.graphiti.proxy import caddy_config
from dbx_tools.graphiti.runtime import (
    GRAPHITI_VERSION,
    JAVA_MISE_TOOL,
    UV_MISE_TOOL,
    Runtime,
    RuntimePaths,
    _ArgvPopen,
    _child_python_paths,
    _link_tool,
    _uv_python,
)
from dbx_tools.graphiti.settings import (
    GRAPHITI_OPTIONS_ENV,
    load_graphiti_options,
    resolve_graphiti_models,
)


def options(**overrides):
    return resolve_graphiti_options(overrides)


def test_runtime_paths_are_versioned(tmp_path: Path) -> None:
    paths = RuntimePaths(tmp_path)

    assert paths.graphiti == tmp_path / "tools" / "graphiti" / GRAPHITI_VERSION
    assert paths.neo4j_data == tmp_path / "data" / "neo4j"
    assert RuntimePaths.from_options(options(home=str(tmp_path))).root == tmp_path


def test_serialized_options_use_generated_zod_contract() -> None:
    resolved = load_graphiti_options(
        {
            GRAPHITI_OPTIONS_ENV: json.dumps(
                {
                    "profile": "PROFILE",
                    "model": "gpt 5",
                    "modelGatewayPort": 4500,
                }
            )
        }
    )

    assert resolved["profile"] == "PROFILE"
    assert resolved["model"] == "gpt 5"
    assert resolved["modelGatewayUrl"] == "http://127.0.0.1:4500/v1"


def test_generated_model_binding_resolves_fuzzy_routes(monkeypatch) -> None:
    route = AsyncMock(
        side_effect=[
            {
                "modelId": "databricks-gpt-5",
                "endpointName": "databricks-gpt-5",
                "source": "fuzzy-match",
                "protocol": "chat",
                "host": "https://workspace",
                "apiBase": "https://workspace/serving-endpoints",
                "url": "https://workspace/serving-endpoints/chat/completions",
                "headers": {"authorization": "Bearer token"},
            },
            {
                "modelId": "databricks-gte-large-en",
                "endpointName": "databricks-gte-large-en",
                "endpointDimension": 1024,
                "source": "fuzzy-match",
                "protocol": "embeddings",
                "host": "https://workspace",
                "apiBase": "https://workspace/serving-endpoints",
                "url": "https://workspace/serving-endpoints/gte/invocations",
                "headers": {"authorization": "Bearer token"},
            },
        ]
    )
    monkeypatch.setattr("dbx_tools.graphiti.settings.resolve_model_route", route)

    resolved, model_route, embedder_route = asyncio.run(
        resolve_graphiti_models(options(profile="PROFILE", model="gpt", embedderModel="gte"))
    )

    assert resolved["model"] == "databricks-gpt-5"
    assert resolved["embedderModel"] == "databricks-gte-large-en"
    assert model_route is not None and model_route["headers"]["authorization"] == "Bearer token"
    assert embedder_route is not None and embedder_route["endpointDimension"] == 1024
    assert route.await_args_list[0].args[0]["profile"] == "PROFILE"
    assert route.await_args_list[1].args[0]["modelClass"] == "embedding"


def test_external_gateway_skips_databricks_model_resolution(monkeypatch) -> None:
    route = AsyncMock()
    monkeypatch.setattr("dbx_tools.graphiti.settings.resolve_model_route", route)
    configured = options(
        manageModelGateway=False,
        modelGatewayUrl="https://models.example/v1",
    )

    resolved, model_route, embedder_route = asyncio.run(resolve_graphiti_models(configured))

    assert resolved == configured
    assert model_route is None
    assert embedder_route is None
    route.assert_not_awaited()


def test_environment_preserves_explicit_neo4j_values(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("NEO4J_URI", "bolt://example:7687")
    runtime = Runtime(RuntimePaths(tmp_path))

    environment = runtime.environment("generated", options())

    assert environment["NEO4J_URI"] == "bolt://example:7687"
    assert environment["NEO4J_PASSWORD"] == "generated"
    assert environment["UV_PYTHON"] == _uv_python()
    assert environment["BROWSER"] == "0"
    assert environment["LLM__PROVIDERS__OPENAI__API_URL"] == "http://127.0.0.1:4400/v1"
    assert environment["EMBEDDER__PROVIDERS__OPENAI__API_KEY"] == "not-required"
    assert environment[UPSTREAM_MCP_PATH_ENV] == str(runtime.paths.graphiti / "mcp_server")
    assert str(Path(__file__).parents[1] / "src") in environment["PYTHONPATH"]


def test_connection_settings_do_not_expose_api_keys(tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))

    settings = runtime.connection_settings("generated", options(openAiApiKey="secret"))

    assert "OPENAI_API_KEY" not in settings
    assert settings["NEO4J_PASSWORD"] == "generated"


def test_child_python_paths_exclude_standard_library() -> None:
    paths = _child_python_paths()

    assert str(Path(sysconfig.get_path("purelib")).resolve()) in paths
    assert str(Path(sysconfig.get_path("stdlib")).resolve()) not in paths
    assert any((Path(entry) / "dbx_tools" / "postgres").exists() for entry in paths)
    assert any((Path(entry) / "dbx_tools" / "core").exists() for entry in paths)


def test_state_is_private(tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))

    runtime._write_state({"neo4j_password": "secret"})

    assert json.loads(runtime.paths.state.read_text()) == {"neo4j_password": "secret"}
    assert runtime.paths.state.stat().st_mode & 0o777 == 0o600


def test_startup_resolves_prerequisites_through_core_bin(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    ensure_tool = Mock()
    resolve = Mock(return_value="/bin/uv")
    monkeypatch.setattr("dbx_tools.graphiti.runtime.bin.ensure_tool", ensure_tool)
    monkeypatch.setattr("dbx_tools.graphiti.runtime.bin.resolve", resolve)
    monkeypatch.setattr(runtime, "_install_neo4j", Mock())
    monkeypatch.setattr(runtime, "_install_graphiti", Mock())
    monkeypatch.setattr(runtime, "_ensure_state", Mock())

    runtime._ensure_runtime()

    ensure_tool.assert_called_once_with(JAVA_MISE_TOOL)
    resolve.assert_called_once_with("uv", mise_tool=UV_MISE_TOOL)


def test_tool_link_targets_mise_install_path(tmp_path: Path) -> None:
    source = tmp_path / "mise" / "installs" / "tool" / "1.0"
    source.mkdir(parents=True)
    destination = tmp_path / "runtime" / "tool"

    _link_tool(source, destination)
    _link_tool(source, destination)

    assert destination.readlink() == source


def test_honcho_child_preserves_argv_without_a_shell() -> None:
    argument = "value with spaces; exit 99"
    process = _ArgvPopen(
        [sys.executable, "-c", "import sys; sys.stdout.write(sys.argv[1])", argument]
    )

    output, _ = process.communicate(timeout=5)

    assert process.returncode == 0
    assert output.decode() == argument


def test_graphiti_command_uses_generated_options(tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))

    command = runtime.graphiti_command(
        options(
            profile="PROFILE",
            graphitiHost="0.0.0.0",
            graphitiPort=9001,
            model="databricks-gpt-5",
            embedderModel="databricks-gte-large-en",
            graphitiArgs=["--transport", "sse"],
        )
    )

    assert command[command.index("--profile") + 1] == "PROFILE"
    assert command[command.index("--host") + 1] == "0.0.0.0"
    assert command[command.index("--port") + 1] == "9001"
    assert command[-2:] == ["--transport", "sse"]


def test_caddy_config_routes_to_graphiti() -> None:
    config = caddy_config(proxy_port=8000, graphiti_port=8002)

    assert "127.0.0.1:8000" in config
    assert "reverse_proxy 127.0.0.1:8002" in config


def test_managed_model_gateway_uses_configured_argv_and_profile(
    monkeypatch, tmp_path: Path
) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime._write_state({"neo4j_password": "secret"})
    settings = options(profile="DEV", modelGatewayCommand="/opt/dbx-model-gateway")
    monkeypatch.setenv("DATABRICKS_CONFIG_PROFILE", "DEFAULT")
    manager = Mock()
    manager.returncode = 0
    monkeypatch.setattr("dbx_tools.graphiti.runtime.Manager", Mock(return_value=manager))
    monkeypatch.setattr("dbx_tools.graphiti.runtime._url_ready", lambda _: False)

    result = runtime.supervise(settings)

    assert result == 0
    model_gateway = manager.add_process.call_args_list[0]
    assert model_gateway.args[1] == [
        "/opt/dbx-model-gateway",
        "--profile",
        "DEV",
        "--host",
        "127.0.0.1",
        "--port",
        "4400",
    ]
    assert manager.add_process.call_args_list[1].args[0] == "graphiti"
    manager.loop.assert_called_once_with()


def test_model_gateway_command_prefers_installed_binary(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    monkeypatch.setattr(
        "dbx_tools.graphiti.runtime.shutil.which",
        lambda name: "/usr/local/bin/dbx-model-gateway" if name == "dbx-model-gateway" else None,
    )

    assert runtime._model_gateway_command(options())[:1] == ["/usr/local/bin/dbx-model-gateway"]


def test_managed_model_gateway_rejects_an_occupied_port(monkeypatch, tmp_path: Path) -> None:
    runtime = Runtime(RuntimePaths(tmp_path))
    runtime._write_state({"neo4j_password": "secret"})
    manager = Mock()
    monkeypatch.setattr("dbx_tools.graphiti.runtime.Manager", Mock(return_value=manager))
    monkeypatch.setattr("dbx_tools.graphiti.runtime._url_ready", lambda _: True)

    with pytest.raises(RuntimeError, match="already in use"):
        runtime.supervise(options())

    manager.add_process.assert_not_called()
