"""Profile-pinned launcher for the LiteLLM proxy."""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from importlib import resources
from typing import Annotated

from cyclopts import App, Parameter

from .backend import DATABRICKS_PROFILE_ENV, require_profile


@dataclass
class CliOptions:
    """dbx-tools options parsed before forwarding the remaining LiteLLM args."""

    profile: Annotated[
        str | None,
        Parameter(name="--profile", env_var=DATABRICKS_PROFILE_ENV),
    ] = None
    proxy_args: list[str] = field(default_factory=list, init=False)

    def __call__(self) -> None:
        """Resolve authentication and run LiteLLM with forwarded arguments."""
        profile = require_profile(self.profile)
        if profile:
            os.environ[DATABRICKS_PROFILE_ENV] = profile
        if not os.getenv("HOST") and not _has_option(self.proxy_args, "--host"):
            self.proxy_args.extend(["--host", "127.0.0.1"])

        if _has_config_argument(self.proxy_args):
            _run_proxy(self.proxy_args)
            return

        config = resources.files("dbx_tools.litellm").joinpath("config.yaml")
        with resources.as_file(config) as config_path:
            _run_proxy([*self.proxy_args, "--config", str(config_path)])


_APP = App(
    name="dbx-litellm",
    help=(
        "Run LiteLLM with live Databricks endpoint resolution. "
        "Additional options are forwarded to the LiteLLM proxy."
    ),
    default_command=CliOptions,
)


def main(argv: Sequence[str] | None = None) -> None:
    """Start LiteLLM with a resolved Databricks profile and default config."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    options_tokens, proxy_args = _split_options(arguments)
    command, bound, _ = _APP.parse_args(options_tokens)
    options = command(*bound.args, **bound.kwargs)
    if options is None:
        return
    options.proxy_args.extend(proxy_args)
    options()


def _split_options(arguments: list[str]) -> tuple[list[str], list[str]]:
    """Split dbx-tools profile options from LiteLLM proxy arguments."""
    options: list[str] = []
    proxy: list[str] = []
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--profile":
            options.extend(arguments[index : index + 2])
            index += 2
        elif argument.startswith("--profile=") or argument in {"--help", "-h"}:
            options.append(argument)
            index += 1
        else:
            proxy.append(argument)
            index += 1
    return options, proxy


def _has_config_argument(arguments: Sequence[str]) -> bool:
    return _has_option(arguments, "--config", "-c")


def _has_option(arguments: Sequence[str], *names: str) -> bool:
    return any(
        argument in names or any(argument.startswith(f"{name}=") for name in names)
        for argument in arguments
    )


def _run_proxy(arguments: Sequence[str]) -> None:
    from litellm.proxy.proxy_cli import run_server

    from .models_api import install_models_compatibility_middleware
    from .patches import apply_litellm_patches

    apply_litellm_patches()
    install_models_compatibility_middleware()
    run_server.main(args=list(arguments), prog_name="dbx-litellm")
