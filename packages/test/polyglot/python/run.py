from __future__ import annotations

import importlib
import json
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any


def _decode_value(value: Any) -> Any:
    if isinstance(value, list):
        return [_decode_value(item) for item in value]
    if not isinstance(value, dict):
        return value

    descriptor_type = value.get("$type")
    if descriptor_type == "negativeZero":
        return -0.0
    if descriptor_type == "set":
        return {_decode_value(item) for item in value.get("values", [])}
    if descriptor_type == "cycle":
        cyclic: dict[str, Any] = {}
        cyclic["self"] = cyclic
        return cyclic
    if descriptor_type == "nan":
        return float("nan")
    return {key: _decode_value(item) for key, item in value.items()}


def _resolve_function(module: Any, path: str) -> Callable[..., Any]:
    value = module
    for key in path.split("."):
        value = getattr(value, key)
    if not callable(value):
        raise TypeError(f"Not a callable export: {path}")
    return value


def _camel_key(value: str) -> str:
    return re.sub(r"_([a-z])", lambda match: match.group(1).upper(), value)


def _normalize(value: Any, mode: str | None) -> Any:
    if hasattr(value, "as_dict") and callable(value.as_dict):
        value = value.as_dict()
    if isinstance(value, list):
        return [_normalize(item, mode) for item in value]
    if isinstance(value, dict):
        return {
            _camel_key(key) if mode == "camelKeys" else key: _normalize(item, mode)
            for key, item in value.items()
        }
    return value


def main() -> None:
    registry_path = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures/modules.json")
    fixture_path = Path(sys.argv[2] if len(sys.argv) > 2 else "fixtures/core-identity.json")
    registry = json.loads(registry_path.read_text())
    suite = json.loads(fixture_path.read_text())
    runtime = registry[suite["root"]]["python"]
    module = importlib.import_module(runtime["module"])
    results = []

    for case in suite["cases"]:
        definition = runtime["functions"][case["function"]]
        function = _resolve_function(module, definition["path"])
        args = [_decode_value(item) for item in case.get("args", [])]
        try:
            options = case.get("options", {}) if definition.get("options") == "keyword" else {}
            result = _normalize(function(*args, **options), definition.get("result"))
            results.append({"name": case["name"], "result": result})
        except Exception as cause:
            results.append({"name": case["name"], "error": type(cause).__name__})

    print(json.dumps(results, separators=(",", ":")))


if __name__ == "__main__":
    main()
