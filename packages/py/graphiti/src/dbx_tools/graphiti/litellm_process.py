from __future__ import annotations

import os

from dbx_tools.litellm.cli import main as litellm_main

from .server import _record_process_group

"""Managed LiteLLM entry point that records its process group for cleanup."""


def main() -> None:
    """Run LiteLLM while exposing its process group to `dbx-graphiti down`."""
    _record_process_group(os.getpgid(0), "litellm_process_group")
    try:
        litellm_main()
    finally:
        _record_process_group(None, "litellm_process_group")


if __name__ == "__main__":
    main()
