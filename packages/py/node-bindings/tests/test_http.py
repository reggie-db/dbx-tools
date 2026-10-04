from __future__ import annotations

import httpx
from dbx_tools.node_bindings import execute_http, executeHttp
from dbx_tools.node_bindings import http as http_binding


async def test_http_binding_executes_and_aliases(monkeypatch) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, headers={"x-method": request.method}, text="created")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    monkeypatch.setattr(http_binding.httpx, "AsyncClient", lambda **_: client)

    result = await execute_http("https://example.com/resource", method="POST")

    assert result["status"] == 201
    assert result["headers"]["x-method"] == "POST"
    assert result["body"] == "created"
    assert executeHttp is execute_http
