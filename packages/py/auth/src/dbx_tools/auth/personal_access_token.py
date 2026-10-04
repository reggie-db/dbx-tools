from __future__ import annotations

from .types import Token


class DatabricksPersonalAccessTokenProvider:
    """Non-refreshing provider for a configured Databricks personal access token."""

    def __init__(self, access_token: str) -> None:
        self._access_token = access_token

    async def authenticate(self, timeout_ms: int) -> Token:
        del timeout_ms
        return self._token()

    async def login(self, timeout_ms: int) -> Token:
        del timeout_ms
        return self._token()

    async def refresh(self, token: Token) -> Token:
        del token
        return self._token()

    def can_authenticate_silently(self) -> bool:
        return True

    def _token(self) -> Token:
        return {
            "accessToken": self._access_token,
            "tokenType": "Bearer",
            "scopes": [],
        }
