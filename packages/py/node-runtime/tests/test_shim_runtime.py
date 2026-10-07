from __future__ import annotations

from pathlib import Path

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
