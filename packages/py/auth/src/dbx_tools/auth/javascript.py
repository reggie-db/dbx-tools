from __future__ import annotations

from pathlib import Path
from typing import Any

import pythonmonkey as pm
import pythonmonkey.require

_CONSTRUCT = pm.eval("(constructor, args) => Reflect.construct(constructor, args)")
_INVOKE = pm.eval("(target, method, args) => Reflect.apply(target[method], target, args)")
_RUNTIME: Any | None = None


def runtime(module_file: str | Path) -> Any:
    global _RUNTIME
    if _RUNTIME is None:
        _RUNTIME = pm.require(str(Path(module_file).resolve().with_name("_runtime.js")))
    return _RUNTIME


def construct(constructor: Any, *args: object) -> Any:
    return _CONSTRUCT(constructor, list(args))


def invoke(target: Any, method: str, *args: object) -> Any:
    return _INVOKE(target, method, list(args))
