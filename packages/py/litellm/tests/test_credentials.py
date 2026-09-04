from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from types import SimpleNamespace
from typing import Any

import dbx_tools.litellm.credentials as credentials_module
import pytest
from dbx_tools.litellm.credentials import Credentials, DatabricksCredentials

"""Tests for the Rust-backed LiteLLM credential adapter."""

HOST = "https://example.cloud.databricks.com"


class FakeAuth:
    """Record calls made through the generated persistent-auth surface."""

    def __init__(self) -> None:
        self.token_calls: list[bool | None] = []
        self.rejected_tokens: list[str] = []

    def status(self) -> SimpleNamespace:
        """Return the resolved host."""
        return SimpleNamespace(host=HOST)

    async def token(self, login: bool | None = None) -> SimpleNamespace:
        """Return one access token."""
        self.token_calls.append(login)
        return SimpleNamespace(access_token="current-token")

    async def refresh_rejected_token(self, stale: str) -> SimpleNamespace:
        """Return a token for a rejected credential."""
        self.rejected_tokens.append(stale)
        return SimpleNamespace(access_token="refreshed-token")


class FakeBridge:
    """Run generated async calls in the current test thread."""

    def run(self, coroutine: Coroutine[Any, Any, Any]) -> Any:
        """Complete one coroutine."""
        return asyncio.run(coroutine)


def build(auth: FakeAuth) -> DatabricksCredentials:
    """Construct the adapter around a fake generated auth object."""
    credentials = DatabricksCredentials.__new__(DatabricksCredentials)
    credentials.profile = "TEST"
    credentials._bridge = FakeBridge()
    credentials._auth = auth
    credentials._host = HOST
    credentials._api_base = f"{HOST}/serving-endpoints"
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

    assert credentials.profile == "TEST"
    assert captured[0].profile == "TEST"
    assert captured[0].prefer_user_to_machine is False


def test_current_uses_rust_token_cache() -> None:
    auth = FakeAuth()
    credentials = build(auth)

    current = credentials.current()

    assert current == Credentials(
        token="current-token",
        api_base=f"{HOST}/serving-endpoints",
    )
    assert auth.token_calls == [False]


def test_refresh_delegates_rejected_token_comparison_to_rust() -> None:
    auth = FakeAuth()
    credentials = build(auth)
    stale = Credentials(token="stale-token", api_base=f"{HOST}/serving-endpoints")

    current = credentials.refresh(stale)

    assert current.token == "refreshed-token"
    assert auth.rejected_tokens == ["stale-token"]


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
