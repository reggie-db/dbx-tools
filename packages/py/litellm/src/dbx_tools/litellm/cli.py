"""Profile-pinned launcher for the LiteLLM proxy."""

from __future__ import annotations

import argparse
import os
from collections.abc import Sequence
from importlib import resources

from .backend import DATABRICKS_PROFILE_ENV, PROFILE_ENV, require_profile


def main(argv: Sequence[str] | None = None) -> None:
    """Start LiteLLM with an explicit Databricks profile and default config."""
    parser = argparse.ArgumentParser(
        prog="dbx-litellm",
        description=(
            "Run LiteLLM with live Databricks endpoint resolution. "
            "Additional options are forwarded to the LiteLLM proxy."
        ),
    )
    parser.add_argument(
        "--profile",
        required=True,
        help="Databricks CLI profile used for endpoint discovery and model requests",
    )
    parsed, proxy_args = parser.parse_known_args(argv)

    profile = require_profile(parsed.profile)
    os.environ[PROFILE_ENV] = profile
    os.environ[DATABRICKS_PROFILE_ENV] = profile

    if _has_config_argument(proxy_args):
        _run_proxy(proxy_args)
        return

    config = resources.files("dbx_tools.litellm").joinpath("config.yaml")
    with resources.as_file(config) as config_path:
        _run_proxy([*proxy_args, "--config", str(config_path)])


def _has_config_argument(arguments: Sequence[str]) -> bool:
    return any(
        argument in {"--config", "-c"} or argument.startswith("--config=") for argument in arguments
    )


def _run_proxy(arguments: Sequence[str]) -> None:
    from litellm.proxy.proxy_cli import run_server

    run_server.main(args=list(arguments), prog_name="dbx-litellm")
