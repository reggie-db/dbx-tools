from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from dbx_tools.graphiti._generated.node.shared_graphiti.options import (
    resolve_graphiti_options,
)
from dbx_tools.graphiti.constants import FALKORDB_SOCKET_PATH_ENV
from dbx_tools.graphiti.server import (
    UPSTREAM_SOURCE_DIR,
    _install_socket_driver,
    _load_upstream,
    _upstream_config,
)
from dbx_tools.graphiti.settings import (
    GRAPHITI_OPTIONS_ENV,
    load_graphiti_options,
    resolve_graphiti_models,
)


def options(**overrides):
    return resolve_graphiti_options(overrides)


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


def test_load_upstream_uses_bundled_source() -> None:
    sys.modules.pop("graphiti_mcp_server", None)
    module = _load_upstream()

    assert Path(module.__file__).resolve().is_relative_to(UPSTREAM_SOURCE_DIR.resolve())


def test_bundled_upstream_matches_pinned_manifest() -> None:
    manifest = json.loads(UPSTREAM_SOURCE_DIR.joinpath("SOURCE.json").read_text())
    bundled_files = {
        str(path.relative_to(UPSTREAM_SOURCE_DIR))
        for path in UPSTREAM_SOURCE_DIR.rglob("*")
        if path.is_file() and path.name != "SOURCE.json" and "__pycache__" not in path.parts
    }

    assert manifest["repository"] == "https://github.com/getzep/graphiti"
    assert manifest["tag"] == "v0.29.3"
    assert manifest["sourcePath"] == "mcp_server/src"
    assert bundled_files == set(manifest["sha256"])
    for relative_path, expected_hash in manifest["sha256"].items():
        contents = UPSTREAM_SOURCE_DIR.joinpath(relative_path).read_bytes()
        assert hashlib.sha256(contents).hexdigest() == expected_hash


def test_upstream_config_injects_temporary_yaml() -> None:
    original = list(sys.argv)
    try:
        sys.argv[:] = ["graphiti", "--transport", "http"]
        with _upstream_config():
            index = sys.argv.index("--config")
            assert Path(sys.argv[index + 1]).read_text() == "{}\n"
        assert sys.argv == ["graphiti", "--transport", "http"]
    finally:
        sys.argv[:] = original


def test_socket_driver_requires_node_owned_socket(monkeypatch) -> None:
    monkeypatch.delenv(FALKORDB_SOCKET_PATH_ENV, raising=False)

    with pytest.raises(RuntimeError, match=FALKORDB_SOCKET_PATH_ENV):
        _install_socket_driver()


def test_socket_driver_uses_private_unix_socket(monkeypatch, tmp_path: Path) -> None:
    from graphiti_core.driver import falkordb_driver

    created: dict[str, object] = {}

    class FakeFalkorDB:
        def __init__(self, **kwargs) -> None:
            created.update(kwargs)

    original = falkordb_driver.FalkorDriver
    monkeypatch.setenv(FALKORDB_SOCKET_PATH_ENV, str(tmp_path / "falkor.sock"))
    monkeypatch.setattr("falkordb.asyncio.FalkorDB", FakeFalkorDB)
    try:
        _install_socket_driver()
        driver = falkordb_driver.FalkorDriver(database="graphiti")
        assert isinstance(driver.client, FakeFalkorDB)
        assert created == {"unix_socket_path": str(tmp_path / "falkor.sock")}
    finally:
        falkordb_driver.FalkorDriver = original


def test_socket_environment_name_is_stable() -> None:
    assert os.environ.get(FALKORDB_SOCKET_PATH_ENV) is None or isinstance(
        os.environ[FALKORDB_SOCKET_PATH_ENV], str
    )
