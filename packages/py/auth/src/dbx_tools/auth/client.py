from __future__ import annotations

from pathlib import Path
from typing import Any

import pythonmonkey as pm

from .types import AccessToken, AuthOptions, CredentialStore, Token, TokenProvider

_RUNTIME = pm.require(str(Path(__file__).with_name("_runtime.js")))


class AuthClient:
    def __init__(
        self,
        key: str,
        provider: TokenProvider,
        store: CredentialStore,
        options: AuthOptions | None = None,
    ) -> None:
        self._client = _RUNTIME["createAuthClient"](
            key,
            {
                "authenticate": provider.authenticate,
                "login": provider.login,
                "refresh": provider.refresh,
                "canAuthenticateSilently": provider.can_authenticate_silently,
            },
            {
                "load": store.load,
                "prepareWrite": store.prepare_write,
                "save": store.save,
                "remove": store.remove,
                "acquireLock": store.acquire_lock,
                "releaseLock": store.release_lock,
                "name": store.name,
            },
            (options or AuthOptions()).to_javascript(),
        )

    def store_name(self) -> str:
        return str(self._client["storeName"]())

    async def login(self) -> AccessToken:
        return _access_token(await self._client["login"]())

    async def token(self, login: bool | None = None) -> AccessToken:
        return _access_token(await self._client["token"](login))

    async def force_refresh(self, login: bool = True) -> AccessToken:
        return _access_token(await self._client["forceRefresh"](login))

    async def refresh_rejected_token(
        self,
        stale_access_token: str,
        login: bool = True,
    ) -> AccessToken:
        return _access_token(
            await self._client["refreshRejectedToken"](stale_access_token, login),
        )

    async def logout(self) -> None:
        await self._client["logout"]()


def _access_token(value: Any) -> AccessToken:
    token: AccessToken = {
        "accessToken": str(value["accessToken"]),
        "tokenType": str(value["tokenType"]),
        "scopes": [str(scope) for scope in value.get("scopes", [])],
    }
    expiry = value.get("expiry")
    if expiry is not None:
        token["expiry"] = str(expiry)
    return token


def token_to_javascript(token: Token) -> dict[str, object]:
    return {
        "accessToken": token["accessToken"],
        "tokenType": token.get("tokenType", "Bearer"),
        "scopes": list(token.get("scopes", [])),
        **({"refreshToken": token["refreshToken"]} if "refreshToken" in token else {}),
        **({"expiry": token["expiry"]} if "expiry" in token else {}),
    }
