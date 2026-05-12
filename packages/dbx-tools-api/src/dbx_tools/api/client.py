import asyncio
from enum import StrEnum
from typing import Any, AsyncGenerator, Literal

import httpx
from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config
from dbx_tools.core import net

try:
    import h2  # type: ignore[reportMissingImports]  # noqa: F401

    _HTTP2_AVAILABLE = True
except ImportError:  # pragma: no cover
    _HTTP2_AVAILABLE = False

_AUTHORIZATION_HEADER = "Authorization"
_HTTP_METHODS = Literal["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]


class ApiAuthHostnameMatch(StrEnum):
    EXACT = "exact"
    SUBDOMAIN = "subdomain"

    @classmethod
    def default(cls) -> "ApiAuthHostnameMatch":
        return cls.SUBDOMAIN


class ApiAuth(httpx.Auth):
    def __init__(
        self,
        config: Config,
        hostname_match: ApiAuthHostnameMatch | None = ApiAuthHostnameMatch.default(),
    ) -> None:
        self.config = config
        self.hostname_match = hostname_match
        config_host = self.config.host
        self._config_hostname = net.hostname_parse(config_host)
        if not self._config_hostname:
            raise RuntimeError(f"Config hostname parse failed - host:{config_host}")

    async def async_auth_flow(
        self, request: httpx.Request
    ) -> AsyncGenerator[httpx.Request, httpx.Response]:
        if self._apply_authentication(request):
            if headers := await asyncio.to_thread(self.config.authenticate):
                request.headers.update(headers)
        yield request

    def _apply_authentication(self, request: httpx.Request) -> bool:
        if _AUTHORIZATION_HEADER in request.headers:
            return False
        elif not self.hostname_match:
            return True
        elif self._config_hostname:
            request_host = request.url.host
            if request_host == self._config_hostname:
                return True
            elif self.hostname_match == ApiAuthHostnameMatch.SUBDOMAIN:
                return request_host.endswith("." + self._config_hostname)
        return False


class WorkspaceHttpClient(httpx.AsyncClient):
    def __init__(
        self,
        *args,
        config: Config | None = None,
        base_path: str | None = None,
        auth_hostname_match: ApiAuthHostnameMatch
        | None = ApiAuthHostnameMatch.default(),
        **kwargs,
    ) -> None:
        self.config = config or WorkspaceClient().config
        base_url_replace: dict[str, Any] | None = None
        if base_path:
            if base_path.startswith("/"):
                base_path = base_path[1:]
            if base_path:
                base_url_replace = {"path": base_path}
        base_url = net.url_parse(self.config.host, replace=base_url_replace)
        if not base_url:
            raise RuntimeError(
                "Base URL parse failed - host:{self.config.host} path:{base_path}"
            )
        auth = ApiAuth(self.config, auth_hostname_match)
        kwargs.setdefault("http2", _HTTP2_AVAILABLE)
        super().__init__(
            *args,
            base_url=base_url.geturl(),
            auth=auth,
            **kwargs,
        )


class WorkspaceApiClient(WorkspaceHttpClient):
    def __init__(self, *args, config: Config, **kwargs) -> None:
        super().__init__(*args, config=config, base_path="/api/2.0", **kwargs)

    async def api_request(
        self,
        *args,
        method: _HTTP_METHODS | Literal["auto"] = "auto",
        json: Any | None = None,
        **kwargs,
    ) -> httpx.Response:
        if method == "auto":
            method = "GET" if json is None else "POST"
        return await self.request(method, *args, json=json, **kwargs)


async def main():
    cfg = Config()
    async with WorkspaceApiClient(config=cfg) as client:
        response = await client.get("services/mlflow/invocations/runs/list")
        response.raise_for_status()
        print(response.content.decode("utf-8"))


if __name__ == "__main__":
    asyncio.run(main())
