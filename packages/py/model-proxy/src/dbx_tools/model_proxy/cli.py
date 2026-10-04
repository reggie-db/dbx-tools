"""Command-line entry point for the LiteLLM model proxy."""

from __future__ import annotations

import argparse
import os
from collections.abc import Sequence
from importlib.resources import files


def main(arguments: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="dbx-model-proxy", add_help=False)
    parser.add_argument("--profile")
    known, forwarded = parser.parse_known_args(arguments)
    if known.profile:
        os.environ["DATABRICKS_CONFIG_PROFILE"] = known.profile

    from litellm.proxy.proxy_cli import run_server

    from .models_api import install_models_api

    install_models_api()
    config = files("dbx_tools.model_proxy").joinpath("config.yaml")
    host = [] if "--host" in forwarded else ["--host", "127.0.0.1"]
    run_server.main(
        args=["--config", str(config), *host, *forwarded],
        prog_name="dbx-model-proxy",
    )
