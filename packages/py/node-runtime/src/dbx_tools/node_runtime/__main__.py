from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .bootstrap import ensure_pythonmonkey


def _run_javascript(runtime: Any, path: Path) -> Any:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"JavaScript file does not exist: {resolved}")
    return runtime.require(str(resolved))


def main() -> None:
    """Install or verify PythonMonkey and optionally execute JavaScript."""

    parser = argparse.ArgumentParser(
        description="Install the locked PythonMonkey runtime and optionally run JavaScript."
    )
    parser.add_argument(
        "javascript",
        nargs="?",
        type=Path,
        help="CommonJS JavaScript file to execute with PythonMonkey require.",
    )
    parser.add_argument(
        "--lock-directory",
        type=Path,
        help="Override the directory used for cross-process installation locks.",
    )
    arguments = parser.parse_args()
    runtime = ensure_pythonmonkey(arguments.lock_directory)
    if arguments.javascript is None:
        print(Path(runtime.__file__).resolve())
        return
    result = _run_javascript(runtime, arguments.javascript)
    if result is not None:
        print(result)


if __name__ == "__main__":
    main()
