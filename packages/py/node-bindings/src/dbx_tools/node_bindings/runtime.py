from __future__ import annotations

from pathlib import Path
from typing import Any

import pythonmonkey as pm


def require_runtime(module_file: str | Path, name: str = "_runtime.js") -> Any:
    """Load a committed CommonJS bundle beside a Python module."""
    return pm.require(str(Path(module_file).resolve().with_name(name)))
