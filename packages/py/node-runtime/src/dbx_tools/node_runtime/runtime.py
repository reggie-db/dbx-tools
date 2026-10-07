from __future__ import annotations

import asyncio
import inspect
from dataclasses import fields, is_dataclass
from pathlib import Path
from threading import RLock
from typing import Any

from .bootstrap import ensure_pythonmonkey

"""Process-wide PythonMonkey host for generated Node binding bundles."""

RUNTIME_ABI_VERSION = 1
MISSING = object()

_LOCK = RLock()
_PYTHONMONKEY: Any | None = None
_RUNTIME: Any | None = None
_BUNDLES: dict[str, RuntimeBundle] = {}


class RuntimeBundle:
    """One package-specific JavaScript bundle loaded into the shared runtime."""

    def __init__(self, bundle_id: str, path: Path, exports: Any) -> None:
        self.bundle_id = bundle_id
        self.path = path
        self._exports = exports

    @property
    def exports(self) -> Any:
        """Return the CommonJS exports object for compatibility and inspection."""

        return self._exports

    def module(self, name: str) -> Any:
        """Return one generated JavaScript module namespace."""

        return self._exports["__pythonModule"](name)

    async def invoke_positioned(
        self,
        module: str,
        name: str,
        arguments: list[tuple[int, Any]],
    ) -> Any:
        """Invoke one generated function and resolve its asynchronous result."""

        value = self._exports["__pythonInvokePositioned"](
            self.module(module)[name],
            [[index, _to_javascript(argument)] for index, argument in arguments],
        )
        return await _resolve(self, value)

    def invoke_positioned_sync(
        self,
        module: str,
        name: str,
        arguments: list[tuple[int, Any]],
    ) -> Any:
        """Invoke one generated synchronous function."""

        value = self._exports["__pythonInvokePositioned"](
            self.module(module)[name],
            [[index, _to_javascript(argument)] for index, argument in arguments],
        )
        return _from_javascript(self, value)


class NodeObject:
    """Python view over a JavaScript object from any registered bundle."""

    def __init__(self, bundle: RuntimeBundle, target: Any) -> None:
        self._bundle = bundle
        self._target = target

    def __getattr__(self, name: str) -> Any:
        javascript_name = _snake_to_camel(name)
        value = self._bundle._exports["__pythonGet"](self._target, javascript_name)
        if not callable(value):
            return _from_javascript(self._bundle, value)

        async def invoke(*args: Any) -> Any:
            result = await self._bundle._exports["__pythonInvokeMethod"](
                self._target,
                javascript_name,
                [_to_javascript(arg) for arg in args],
            )
            if result["ok"]:
                return _from_javascript(self._bundle, result["value"])
            error = result["error"]
            message = f"{error['name']}: {error['message']}"
            if error.get("stack"):
                message = f"{message}\n{error['stack']}"
            raise RuntimeError(message)

        return invoke


def _require(path: Path) -> Any:
    module = _load_pythonmonkey()
    try:
        asyncio.get_running_loop()
    except RuntimeError:

        async def load() -> Any:
            return module.require(str(path))

        return asyncio.run(load())
    return module.require(str(path))


def get_runtime() -> Any:
    """Return the process-wide shim runtime, loading it once."""

    global _RUNTIME
    if _RUNTIME is None:
        with _LOCK:
            if _RUNTIME is None:
                path = Path(__file__).with_name("runtime.js")
                runtime = _require(path)
                actual = int(runtime["__pythonRuntimeAbiVersion"])
                if actual != RUNTIME_ABI_VERSION:
                    raise RuntimeError(
                        f"Python Node runtime ABI {actual} is incompatible with "
                        f"{RUNTIME_ABI_VERSION}"
                    )
                _RUNTIME = runtime
    return _RUNTIME


def get_builtin(name: str) -> Any:
    """Return one compatibility module from the shared shim registry."""

    return get_runtime()["__pythonBuiltin"](name)


def load_bundle(
    path: str | Path,
    *,
    bundle_id: str | None = None,
    abi_version: int = RUNTIME_ABI_VERSION,
) -> RuntimeBundle:
    """Load and cache one package-specific CommonJS bundle."""

    if abi_version != RUNTIME_ABI_VERSION:
        raise RuntimeError(
            f"Generated bundle requires runtime ABI {abi_version}; installed runtime provides "
            f"{RUNTIME_ABI_VERSION}"
        )
    resolved = Path(path).expanduser().resolve()
    key = bundle_id or str(resolved)
    get_runtime()
    with _LOCK:
        existing = _BUNDLES.get(key)
        if existing is not None:
            if existing.path != resolved:
                raise RuntimeError(
                    f"Bundle id {key!r} is already registered for {existing.path}, not {resolved}"
                )
            return existing
        exports = _require(resolved)
        try:
            bundle_abi = int(exports["__pythonRuntimeAbiVersion"])
        except (KeyError, TypeError):
            bundle_abi = abi_version
        if bundle_abi != RUNTIME_ABI_VERSION:
            raise RuntimeError(
                f"Bundle {resolved} uses runtime ABI {bundle_abi}; installed runtime provides "
                f"{RUNTIME_ABI_VERSION}"
            )
        bundle = RuntimeBundle(key, resolved, exports)
        _BUNDLES[key] = bundle
        return bundle


def _load_pythonmonkey() -> Any:
    global _PYTHONMONKEY
    if _PYTHONMONKEY is None:
        with _LOCK:
            if _PYTHONMONKEY is None:
                _PYTHONMONKEY = ensure_pythonmonkey()
    return _PYTHONMONKEY


def _snake_to_camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def _to_javascript(value: Any) -> Any:
    if isinstance(value, NodeObject):
        return value._target
    if is_dataclass(value) and not isinstance(value, type):
        return {
            item.metadata.get("javascript_name", item.name): _to_javascript(field_value)
            for item in fields(value)
            if (field_value := getattr(value, item.name)) is not None
        }
    if isinstance(value, dict):
        return {key: _to_javascript(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_javascript(item) for item in value]
    return value


def _from_javascript(bundle: RuntimeBundle, value: Any) -> Any:
    if isinstance(value, str):
        return value.encode("utf-8").decode("utf-8")
    if value is None or isinstance(value, (int, float, bool)):
        return value
    kind = bundle._exports["__pythonKind"](value)
    if kind == "instance":
        return NodeObject(bundle, value)
    if kind == "array":
        return [_from_javascript(bundle, item) for item in value]
    if kind == "record":
        return {str(key): _from_javascript(bundle, item) for key, item in value.items()}
    return value


async def _resolve(bundle: RuntimeBundle, value: Any) -> Any:
    if inspect.isawaitable(value):
        value = await value
    return _from_javascript(bundle, value)
