from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from dbx_tools.postgres import parse_address, parse_resource_path

_KEYS = {
    "ssl_mode": "sslMode",
    "endpoint_id": "endpointId",
    "database_resource_id": "databaseResourceId",
}


def _result(value: Any) -> dict[str, object]:
    return {_KEYS.get(key, key): item for key, item in value.as_dict().items()}


def main() -> None:
    fixture_path = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures/pgaddress.json")
    cases = json.loads(fixture_path.read_text())
    results = []
    for case in cases:
        parser = parse_address if case["operation"] == "parseAddress" else parse_resource_path
        results.append({"name": case["name"], "result": _result(parser(case["input"]))})
    print(json.dumps(results, separators=(",", ":")))


if __name__ == "__main__":
    main()
