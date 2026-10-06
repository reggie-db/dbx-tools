"""Check parser-generated Python references without starting the Graphiti runtime."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def test_native_reference_contains_described_options_and_commands() -> None:
    """Keep forwarded options and all Python commands documented without help flags."""
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, str(root / "docs/scripts/python-cli-reference.py")],
        cwd=root,
        env={**os.environ, "PYTHONPATH": str(root / "packages/py/graphiti/src")},
        text=True,
        capture_output=True,
        check=True,
    )
    references = json.loads(result.stdout)
    for option in [
        "--profile",
        "--model",
        "--embedder-model",
        "--embedder-dimensions",
        "--model-gateway-url",
        "--model-gateway-host",
        "--model-gateway-port",
        "--model-gateway-command",
        "--manage-model-gateway",
        "--no-manage-model-gateway",
    ]:
        assert option in references["start"]
        assert option in references["full"]
    assert "Model used to extract and query graph memory" in references["start"]
    assert "MODEL_NAME" in references["start"]
    for command in ["start", "up", "down", "status", "env"]:
        assert f"python -m dbx_tools.graphiti {command}" in references["full"]
    assert "--help" not in references["start"]
    assert "--help" not in references["full"]
    assert "dbx graphiti [ARGS]" in references["start"]
