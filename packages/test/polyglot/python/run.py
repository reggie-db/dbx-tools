from __future__ import annotations

import importlib
import json
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import yaml


def _read_document(path: Path) -> dict[str, Any]:
    source = path.read_text()
    if path.suffix == ".json":
        return json.loads(source)
    if path.suffix in {".yaml", ".yml"}:
        return yaml.safe_load(source) or {}
    raise ValueError(f"Unsupported fixture format: {path}")


def _fixture_root(path: Path) -> Path:
    for parent in path.parents:
        if parent.name == "fixtures":
            return parent
    return path.parent


def _read_default(directory: Path) -> dict[str, Any] | None:
    paths = [
        path
        for name in ("default.json", "default.yaml", "default.yml")
        if (path := directory / name).exists()
    ]
    if len(paths) > 1:
        raise ValueError(f"Multiple fixture defaults in {directory}")
    return _read_document(paths[0]) if paths else None


def _merge_suites(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    functions = dict(base.get("functions", {}))
    for name, definition in override.get("functions", {}).items():
        inherited = functions.get(name, {})
        functions[name] = {
            **inherited,
            **definition,
            "invoke": {**inherited.get("invoke", {}), **definition.get("invoke", {})},
            "result": {**inherited.get("result", {}), **definition.get("result", {})},
            "tests": [*inherited.get("tests", []), *definition.get("tests", [])],
        }
    return {
        **base,
        **override,
        "modules": {**base.get("modules", {}), **override.get("modules", {})},
        "functions": functions,
        "tests": [*base.get("tests", []), *override.get("tests", [])],
    }


def _read_fixture(path: Path) -> dict[str, Any]:
    root = _fixture_root(path)
    directories = list(
        reversed([parent for parent in path.parents if root == parent or root in parent.parents])
    )
    suite: dict[str, Any] = {}
    defaults = filter(None, (_read_default(directory) for directory in directories))
    for document in [*defaults, _read_document(path)]:
        suite = _merge_suites(suite, document)
    return suite


def _fixture_cases(suite: dict[str, Any]) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for name, definition in suite.get("functions", {}).items():
        cases.extend(
            {**test, "function": test.get("function", name)} for test in definition.get("tests", [])
        )
    return [*cases, *suite.get("tests", [])]


def _runtime_value(value: Any, runtime: str) -> str | None:
    return value if isinstance(value, str) else (value or {}).get(runtime)


def _resolve_cases(suite: dict[str, Any]) -> list[tuple[dict[str, Any], dict[str, str]]]:
    resolved = []
    for test in _fixture_cases(suite):
        definition = suite.get("functions", {}).get(test.get("function"), {})
        module = _runtime_value(test.get("module"), "python") or _runtime_value(
            definition.get("module"), "python"
        )
        module = module or suite.get("modules", {}).get("python")
        path = _runtime_value(test.get("path"), "python") or _runtime_value(
            definition.get("path"), "python"
        )
        path = path or test.get("function")
        if not module or not path:
            raise ValueError(f"Fixture '{test['name']}' needs a python module and function path")
        resolved.append(
            (
                test,
                {
                    "module": module,
                    "path": path,
                    "invoke": test.get("invoke", {}).get("python")
                    or definition.get("invoke", {}).get("python", "positional"),
                    "result": test.get("result", {}).get("python")
                    or definition.get("result", {}).get("python", "identity"),
                },
            )
        )
    return resolved


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


def _normalize(value: Any, mode: str) -> Any:
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
    fixture_path = Path(
        sys.argv[1] if len(sys.argv) > 1 else "fixtures/core/fixture.json"
    ).resolve()
    suite = _read_fixture(fixture_path)
    modules: dict[str, Any] = {}
    results = []
    for case, target in _resolve_cases(suite):
        module = modules.get(target["module"])
        if module is None:
            module = importlib.import_module(target["module"])
            modules[target["module"]] = module
        function = _resolve_function(module, target["path"])
        args = [_decode_value(item) for item in case.get("args", [])]
        try:
            if target["invoke"] == "keywordOptions":
                result = function(*args, **case.get("options", {}))
            elif target["invoke"] == "positional":
                result = function(*args)
            else:
                raise ValueError(f"Unsupported Python invoke mode: {target['invoke']}")
            results.append({"name": case["name"], "result": _normalize(result, target["result"])})
        except Exception as cause:
            results.append({"name": case["name"], "error": type(cause).__name__})
    print(json.dumps(results, separators=(",", ":")))


if __name__ == "__main__":
    main()
