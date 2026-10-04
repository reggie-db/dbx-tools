from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .client import _access_token, credential_store_to_javascript, javascript_runtime
from .javascript import invoke
from .storage import FileCredentialStore
from .types import AccessToken, AuthOptions, CredentialStore


@dataclass(frozen=True, slots=True)
class DatabricksAuthStatus:
    profile: str
    host: str
    workspace_id: str | None
    storage: str


class DatabricksAuth:
    """Databricks authentication facade over the shared JavaScript lifecycle."""

    def __init__(
        self,
        client: Any,
    ) -> None:
        self._client = client

    async def challenge(self) -> None:
        await invoke(self._client, "challenge")

    async def token(self, login: bool | None = None) -> AccessToken:
        return _access_token(await invoke(self._client, "token", login))

    async def authenticate(self, login: bool | None = None) -> dict[str, str]:
        return dict(await invoke(self._client, "authenticate", login))

    async def authorization_header_for_url(
        self,
        request_url: str,
        login: bool | None = None,
    ) -> str | None:
        return (await self.request_headers_for_url(request_url, login)).get("authorization")

    async def request_headers_for_url(
        self,
        request_url: str,
        login: bool | None = None,
    ) -> dict[str, str]:
        return dict(
            await invoke(
                self._client,
                "requestHeadersForUrl",
                request_url,
                login,
            ),
        )

    async def force_refresh(self, login: bool = True) -> AccessToken:
        return _access_token(await invoke(self._client, "forceRefreshToken", login))

    async def refresh_rejected_token(
        self,
        stale_access_token: str,
        login: bool = True,
    ) -> AccessToken:
        return _access_token(
            await invoke(
                self._client,
                "refreshRejectedToken",
                stale_access_token,
                login,
            ),
        )

    async def logout(self) -> None:
        await invoke(self._client, "logout")

    def status(self) -> DatabricksAuthStatus:
        status = invoke(self._client, "status")
        workspace_id = invoke(self._client, "workspaceId")
        return DatabricksAuthStatus(
            str(status["profile"]),
            str(status["host"]),
            str(workspace_id) if workspace_id else None,
            str(status["storage"]),
        )

    def principal(self) -> str:
        return str(invoke(self._client, "principal"))

    def workspace_id(self) -> str | None:
        value = invoke(self._client, "workspaceId")
        return str(value) if value else None

    def auth_kind(self) -> str:
        return str(invoke(self._client, "authKind"))


async def create_databricks_cli_auth(
    *,
    profile: str | None = None,
    config_file: str | Path | None = None,
    cache_dir: str | Path | None = None,
    environment: Mapping[str, str] | None = None,
    prefer_user_to_machine: bool = True,
    executable: str | None = None,
    store: CredentialStore | None = None,
    options: AuthOptions | None = None,
) -> DatabricksAuth:
    """Create CLI-first Databricks auth using JavaScript profile selection."""
    selected_store = store or FileCredentialStore(cache_dir)
    runtime = javascript_runtime()
    auth_options = {
        **({"profile": profile} if profile else {}),
        **({"configFile": str(Path(config_file).expanduser())} if config_file else {}),
        "preferUserToMachine": prefer_user_to_machine,
        "auth": (options or AuthOptions()).to_javascript(),
    }
    dependencies = {
        **({"environment": dict(environment)} if environment is not None else {}),
    }
    if executable:

        async def resolve_cli(_options: object) -> str:
            return executable

        dependencies["resolveCli"] = resolve_cli
    client = await runtime["createPersistentAuthWithStorage"](
        auth_options,
        credential_store_to_javascript(selected_store),
        runtime["Storage"]["Auto"],
        dependencies,
    )
    return DatabricksAuth(client)
