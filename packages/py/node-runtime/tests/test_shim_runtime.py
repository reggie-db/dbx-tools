from __future__ import annotations

import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest
from dbx_tools.node_runtime.runtime import (
    RUNTIME_ABI_VERSION,
    get_builtin,
    get_runtime,
    load_bundle,
)

FIXTURES = Path(__file__).with_name("fixtures")


def test_shared_runtime_and_bundle_registry() -> None:
    runtime = get_runtime()
    assert get_runtime() is runtime
    assert runtime["__pythonRuntimeAbiVersion"] == RUNTIME_ABI_VERSION
    assert get_builtin("fs") is not None
    assert get_builtin("node:crypto") is not None

    first = load_bundle(FIXTURES / "first.js", bundle_id="first")
    second = load_bundle(FIXTURES / "second.js", bundle_id="second")

    assert load_bundle(FIXTURES / "first.js", bundle_id="first") is first
    assert first._exports["runtimeAbi"]() == RUNTIME_ABI_VERSION
    assert second._exports["runtimeAbi"]() == RUNTIME_ABI_VERSION
    assert first._exports["abortGlobalsMatch"]() is True
    assert second._exports["abortGlobalsMatch"]() is True
    assert first._exports["headersBehave"]() == {
        "accept": "application/json",
        "authorization": False,
        "cookies": ["first=1", "second=2"],
        "keys": ["set-cookie", "accept"],
    }
    assert first.invoke_positioned_sync("fixture", "add", [(0, 2), (1, 3)]) == 5
    assert second.invoke_positioned_sync("fixture", "multiply", [(0, 4), (1, 5)]) == 20


def test_python_environment_is_available_at_runtime_start() -> None:
    script = (
        "import os; from pathlib import Path; "
        "from dbx_tools.node_runtime.runtime import load_bundle; "
        "bundle = load_bundle(Path(os.environ['DBX_TOOLS_NODE_RUNTIME_FIXTURE'])); "
        "assert bundle.exports['environmentValue']"
        "('DBX_TOOLS_NODE_RUNTIME_ENV_TEST') == 'python-value'"
    )
    subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        env={
            **os.environ,
            "DBX_TOOLS_NODE_RUNTIME_ENV_TEST": "python-value",
            "DBX_TOOLS_NODE_RUNTIME_FIXTURE": str(FIXTURES / "first.js"),
        },
    )


def test_bundle_ids_and_abi_are_fail_closed() -> None:
    load_bundle(FIXTURES / "first.js", bundle_id="stable")
    with pytest.raises(RuntimeError, match="already registered"):
        load_bundle(FIXTURES / "second.js", bundle_id="stable")
    with pytest.raises(RuntimeError, match="requires runtime ABI 2"):
        load_bundle(FIXTURES / "second.js", bundle_id="future", abi_version=2)


@pytest.mark.asyncio
async def test_runtime_auth_is_absent_outside_databricks(monkeypatch) -> None:
    monkeypatch.delenv("DATABRICKS_RUNTIME_VERSION", raising=False)

    runtime = get_runtime()["__pythonRuntime"]

    assert await runtime["databricksRuntimeAuthClient"]() is None


@pytest.mark.asyncio
async def test_runtime_auth_is_disabled_in_databricks_apps(monkeypatch) -> None:
    monkeypatch.setenv("DATABRICKS_RUNTIME_VERSION", "apps")
    monkeypatch.setenv("DATABRICKS_APP_NAME", "graphiti-demo")
    monkeypatch.setenv("DATABRICKS_HOST", "https://workspace.example.com")
    monkeypatch.setenv("DATABRICKS_APP_PORT", "8000")

    runtime = get_runtime()["__pythonRuntime"]
    fixture = load_bundle(FIXTURES / "first.js", bundle_id="first")
    for name in (
        "DATABRICKS_RUNTIME_VERSION",
        "DATABRICKS_APP_NAME",
        "DATABRICKS_HOST",
        "DATABRICKS_APP_PORT",
    ):
        fixture._exports["setEnvironmentValue"](name, os.environ[name])

    assert await runtime["databricksRuntimeAuthClient"]() is None


@pytest.mark.asyncio
async def test_fetch_serializes_url_search_params() -> None:
    received: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["content-length"])
            received.append(self.rfile.read(length).decode())
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        fixture = load_bundle(FIXTURES / "first.js", bundle_id="form")
        response = await fixture._exports["postForm"](
            f"http://127.0.0.1:{server.server_port}/token"
        )
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    assert response == "ok"
    assert received == ["grant_type=client_credentials&scope=all-apis"]
