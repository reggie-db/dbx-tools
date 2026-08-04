from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from dbx_tools.core import fnv_hash, to_identifier, to_stable_key


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


def main() -> None:
    fixture_path = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures/core-identity.json")
    cases = json.loads(fixture_path.read_text())
    results = []
    for case in cases:
        try:
            if case["operation"] == "fnvHash":
                options = {"length": case["length"]} if "length" in case else {}
                result = fnv_hash(case["value"], **options)
            elif case["operation"] == "toStableKey":
                result = to_stable_key(_decode_value(case["value"]))
            else:
                result = to_identifier(*case["values"])
            results.append({"name": case["name"], "result": result})
        except TypeError as cause:
            results.append({"name": case["name"], "error": type(cause).__name__})
    print(json.dumps(results, separators=(",", ":")))


if __name__ == "__main__":
    main()
