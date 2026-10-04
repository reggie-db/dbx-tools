from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from dbx_tools.node_bindings import read_text

from .client import _RUNTIME, AuthClient
from .databricks_cli import DatabricksCliProvider
from .storage import FileCredentialStore
from .types import AccessToken, AuthOptions, CredentialStore


@dataclass(frozen=True, slots=True)
class DatabricksAuthStatus:
    profile: str
    host: str | None
    workspace_id: str | None
    storage: str


class DatabricksAuth:
    """Databricks authentication facade over the shared JavaScript lifecycle."""

    def __init__(
        self,
        client: AuthClient,
        *,
        profile: str,
        host: str | None,
        workspace_id: str | None,
        auth_kind: str,
    ) -> None:
        self._client = client
        self._status = DatabricksAuthStatus(
            profile,
            host,
            workspace_id,
            client.store_name(),
        )
        self._auth_kind = auth_kind

    async def challenge(self) -> None:
        await self._client.login()

    async def token(self, login: bool | None = None) -> AccessToken:
        return await self._client.token(login)

    async def authenticate(self, login: bool | None = None) -> dict[str, str]:
        token = await self.token(login)
        return {
            "authorization": f"{token['tokenType']} {token['accessToken']}",
            **(
                {"x-databricks-workspace-id": self._status.workspace_id}
                if self._status.workspace_id
                else {}
            ),
        }

    async def authorization_header_for_url(
        self,
        request_url: str,
        login: bool | None = None,
    ) -> str | None:
        return (await self.request_headers_for_url(request_url, login)).get(
            "authorization",
        )

    async def request_headers_for_url(
        self,
        request_url: str,
        login: bool | None = None,
    ) -> dict[str, str]:
        if not self._status.host or _origin(request_url) != _origin(self._status.host):
            return {}
        return await self.authenticate(login)

    async def force_refresh(self, login: bool = True) -> AccessToken:
        return await self._client.force_refresh(login)

    async def refresh_rejected_token(
        self,
        stale_access_token: str,
        login: bool = True,
    ) -> AccessToken:
        return await self._client.refresh_rejected_token(stale_access_token, login)

    async def logout(self) -> None:
        await self._client.logout()

    def status(self) -> DatabricksAuthStatus:
        return self._status

    def principal(self) -> str:
        return self._status.profile

    def workspace_id(self) -> str | None:
        return self._status.workspace_id

    def auth_kind(self) -> str:
        return self._auth_kind


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
    environ = dict(os.environ if environment is None else environment)
    selected_file = Path(
        config_file or environ.get("DATABRICKS_CONFIG_FILE") or "~/.databrickscfg",
    ).expanduser()
    source = await read_text(selected_file.resolve(), default="")
    requested = profile or environ.get("DATABRICKS_CONFIG_PROFILE")
    resolved = _RUNTIME["resolveDatabricksCliProfile"](
        source or "",
        requested,
        prefer_user_to_machine,
    )
    name = str(resolved["name"])
    host = str(resolved["host"]) if resolved.get("host") else None
    workspace_id = str(resolved["workspaceId"]) if resolved.get("workspaceId") else None
    auth_kind = str(resolved["authKind"])
    client = AuthClient(
        name,
        DatabricksCliProvider(name, executable, auth_kind, str(selected_file.resolve())),
        store or FileCredentialStore(cache_dir),
        options,
    )
    return DatabricksAuth(
        client,
        profile=name,
        host=host,
        workspace_id=workspace_id,
        auth_kind=auth_kind,
    )


def _origin(value: str) -> tuple[str, str, int | None]:
    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    port = parsed.port
    if port is None:
        port = 443 if scheme == "https" else 80 if scheme == "http" else None
    return scheme, (parsed.hostname or "").lower(), port
