"""Command-line entry point for the LiteLLM model proxy."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from importlib.metadata import PackageNotFoundError, version
from importlib.resources import files

_DISTRIBUTION = "dbx-tools-model-proxy"


def main(arguments: Sequence[str] | None = None) -> None:
    args = list(arguments) if arguments is not None else sys.argv[1:]
    if args[:1] == ["service"]:
        from .service import main as service_main

        service_main(args[1:])
        return
    if args[:1] == ["tray"]:
        from .tray import main as tray_main

        tray_main(args[1:])
        return
    if args == ["--runtime-info"]:
        print(json.dumps({"implementation": "python-litellm", "version": _version()}))
        return
    if args in (["--version"], ["-v"]):
        print(_version())
        return

    if "--concurrent" in args:
        args.remove("--concurrent")
        if not _has_option(args, "--port"):
            args.extend(["--port", "4001"])

    parser = argparse.ArgumentParser(prog="dbx-model-proxy", add_help=False)
    parser.add_argument("--profile")
    known, forwarded = parser.parse_known_args(args)
    if known.profile:
        os.environ["DATABRICKS_CONFIG_PROFILE"] = known.profile

    from litellm.proxy.proxy_cli import run_server

    from .models_api import install_models_api

    install_models_api()
    config = files("dbx_tools.model_proxy").joinpath("config.yaml")
    host = [] if "--host" in forwarded else ["--host", "127.0.0.1"]
    server = (
        []
        if any(
            option in forwarded for option in ("--run_gunicorn", "--run_hypercorn", "--run_granian")
        )
        else ["--run_hypercorn"]
    )
    run_server.main(
        args=["--config", str(config), *server, *host, *forwarded],
        prog_name="dbx-model-proxy",
    )


def _version() -> str:
    try:
        return version(_DISTRIBUTION)
    except PackageNotFoundError:
        return "0.0.0"


def _has_option(arguments: Sequence[str], name: str) -> bool:
    return name in arguments or any(argument.startswith(f"{name}=") for argument in arguments)
