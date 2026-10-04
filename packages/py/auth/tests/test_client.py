from __future__ import annotations

import asyncio

from dbx_tools.auth import AuthClient, AuthOptions, MemoryCredentialStore, Token


def _token(value: str) -> Token:
    return {
        "accessToken": value,
        "tokenType": "Bearer",
        "expiry": "2099-01-01T00:00:00Z",
        "scopes": [],
    }


class Provider:
    def __init__(self) -> None:
        self.authentications = 0
        self.refreshes = 0

    async def authenticate(self, timeout_ms: int) -> Token:
        assert timeout_ms == 900_000
        self.authentications += 1
        await asyncio.sleep(0.01)
        return _token("authenticated")

    async def login(self, timeout_ms: int) -> Token:
        assert timeout_ms == 900_000
        return _token("login")

    async def refresh(self, token: Token) -> Token:
        self.refreshes += 1
        return _token(f"refreshed-{token['accessToken']}")

    def can_authenticate_silently(self) -> bool:
        return True


async def test_python_adapters_reuse_javascript_check_lock_recheck() -> None:
    provider = Provider()
    client = AuthClient(
        "profile",
        provider,
        MemoryCredentialStore(),
        AuthOptions(refresh_buffer_seconds=0),
    )

    left, right = await asyncio.gather(client.token(False), client.token(False))

    assert left["accessToken"] == "authenticated"
    assert right["accessToken"] == "authenticated"
    assert provider.authentications == 1
    assert client.store_name() == "memory"


async def test_rejected_token_refreshes_through_javascript_lifecycle() -> None:
    provider = Provider()
    store = MemoryCredentialStore()
    await store.save("profile", _token("stale"))
    client = AuthClient("profile", provider, store, AuthOptions(refresh_buffer_seconds=0))

    refreshed = await client.refresh_rejected_token("stale", False)

    assert refreshed["accessToken"] == "refreshed-stale"
    assert provider.refreshes == 1
