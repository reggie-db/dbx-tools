from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from types import SimpleNamespace
from typing import Any

import dbx_tools.litellm.credentials as credentials_module
import pytest
from dbx_tools.litellm.credentials import (
    CODEX_API_PATH,
    MLFLOW_API_PATH,
    Credentials,
    DatabricksCredentials,
)
from litellm.llms.databricks.responses.transformation import DatabricksResponsesAPIConfig

"""Tests for the Rust-backed LiteLLM credential adapter."""

HOST = "https://example.cloud.databricks.com"


class FakeAuth:
    """Record calls made through the generated persistent-auth surface."""

    def __init__(self) -> None:
        self.token_calls: list[bool | None] = []

    def status(self) -> SimpleNamespace:
        """Return the resolved host."""
        return SimpleNamespace(profile="RESOLVED", host=HOST)

    async def token(self, login: bool | None = None) -> SimpleNamespace:
        """Return one access token."""
        self.token_calls.append(login)
        return SimpleNamespace(access_token="current-token")


class FakeBridge:
    """Run generated async calls in the current test thread."""

    def run(self, coroutine: Coroutine[Any, Any, Any]) -> Any:
        """Complete one coroutine."""
        return asyncio.run(coroutine)


def build(auth: FakeAuth) -> DatabricksCredentials:
    """Construct the adapter around a fake generated auth object."""
    credentials = DatabricksCredentials.__new__(DatabricksCredentials)
    credentials.profile = "RESOLVED"
    credentials._bridge = FakeBridge()
    credentials._auth = auth
    credentials._host = HOST
    credentials._api_base = f"{HOST}/serving-endpoints"
    credentials._codex_api_base = f"{HOST}{CODEX_API_PATH}"
    credentials._mlflow_api_base = f"{HOST}{MLFLOW_API_PATH}"
    return credentials


def test_constructor_disables_u2m_preference(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = FakeAuth()
    captured = []

    async def create(options):
        captured.append(options)
        return auth

    monkeypatch.setattr(credentials_module, "_AsyncBridge", FakeBridge)
    monkeypatch.setattr(credentials_module, "create_persistent_auth", create)

    credentials = DatabricksCredentials(profile="TEST")

    assert credentials.profile == "RESOLVED"
    assert credentials.api_base == f"{HOST}/serving-endpoints"
    assert credentials._codex_api_base == f"{HOST}/ai-gateway/codex/v1"
    assert credentials._mlflow_api_base == f"{HOST}/ai-gateway/mlflow/v1"
    assert captured[0].profile == "TEST"
    assert captured[0].prefer_user_to_machine is False


def test_current_uses_rust_token_cache() -> None:
    auth = FakeAuth()
    credentials = build(auth)

    current = credentials.current()

    assert current == Credentials(
        token="current-token",
        api_base=f"{HOST}/serving-endpoints",
        codex_api_base=f"{HOST}/ai-gateway/codex/v1",
        mlflow_api_base=f"{HOST}/ai-gateway/mlflow/v1",
    )
    assert auth.token_calls == [False]


def test_codex_base_builds_the_gateway_responses_url() -> None:
    config = DatabricksResponsesAPIConfig()

    assert (
        config.get_complete_url(f"{HOST}{CODEX_API_PATH}", {})
        == f"{HOST}/ai-gateway/codex/v1/responses"
    )


def test_workspace_client_uses_rust_managed_token(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = FakeAuth()
    credentials = build(auth)
    captured = []

    def client(**options):
        captured.append(options)
        return SimpleNamespace()

    monkeypatch.setattr(credentials_module, "WorkspaceClient", client)

    credentials.client()

    assert captured == [{"host": HOST, "token": "current-token"}]
