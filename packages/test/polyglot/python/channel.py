from __future__ import annotations

import json
import sys
from pathlib import Path

from dbx_tools.bus import channel_name


def main() -> None:
    fixture_path = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures/channel.json")
    cases = json.loads(fixture_path.read_text())
    results = [{"name": case["name"], "result": channel_name(case["input"])} for case in cases]
    print(json.dumps(results, separators=(",", ":")))


if __name__ == "__main__":
    main()
