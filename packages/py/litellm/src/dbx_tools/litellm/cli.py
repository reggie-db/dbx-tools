"""Profile-pinned launcher for the LiteLLM proxy."""

from __future__ import annotations

import json
import logging
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from importlib import resources
from typing import Annotated, Any

from cyclopts import App, Parameter

from .backend import (
    DATABRICKS_PROFILE_ENV,
    require_profile,
)

_COMMANDS = frozenset({"lookup", "models"})
logger = logging.getLogger(__name__)


class OutputFormat(str, Enum):
    """Stdout encoding for inspection commands."""

    TEXT = "text"
    JSON = "json"


@dataclass(kw_only=True)
class ProfileOptions:
    """Databricks profile shared by LiteLLM commands."""

    profile: Annotated[
        str | None,
        Parameter(name="--profile", env_var=DATABRICKS_PROFILE_ENV),
    ] = None


@dataclass
class CliOptions(ProfileOptions):
    """dbx-tools options parsed before forwarding the remaining LiteLLM args."""

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


@dataclass
class Models(ProfileOptions):
    """List models advertised by GET /v1/models without starting the proxy."""

    extended: Annotated[
        bool,
        Parameter(name=("--extended", "--all")),
    ] = False
    output: Annotated[
        OutputFormat,
        Parameter(name="--output"),
    ] = OutputFormat.TEXT

    def __call__(self) -> None:
        """Print the `/v1/models` payload as a table or JSON."""
        payload = _models_payload(self.profile)
        if self.output is OutputFormat.JSON:
            print(json.dumps(payload, indent=2))
            return
        print(_format_models_text(payload, extended=self.extended))


@dataclass
class Lookup(ProfileOptions):
    """Rank live models for a keyword using standard model resolution."""

    keyword: Annotated[str, Parameter(help="Model keyword to rank, such as gpt.")]
    output: Annotated[
        OutputFormat,
        Parameter(name="--output"),
    ] = OutputFormat.TEXT

    def __call__(self) -> None:
        """Print ranked model matches and their fuzzy-match scores."""
        ranked = _lookup_models(self.keyword, self.profile)
        if self.output is OutputFormat.JSON:
            print(json.dumps(ranked, indent=2))
            return
        print(_format_lookup_text(ranked))


_APP = App(
    name="dbx-litellm",
    help=(
        "Run LiteLLM with live Databricks endpoint resolution, "
        "or list advertised models. Additional options on the default "
        "command are forwarded to the LiteLLM proxy."
    ),
    default_command=CliOptions,
)
_APP.command(Models, name="models")
_APP.command(Lookup, name="lookup")


def main(argv: Sequence[str] | None = None) -> None:
    """Start LiteLLM with a resolved Databricks profile, or run a subcommand."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    command, remaining = _extract_command(arguments)
    if command is not None:
        options = _parse_options([command, *remaining])
        if options is None:
            return
        options()
        return

    options_tokens, proxy_args = _split_options(arguments)
    options = _parse_options(options_tokens)
    if options is None:
        return
    options.proxy_args.extend(proxy_args)
    options()


def _parse_options(arguments: list[str]) -> object | None:
    command, bound, _ = _APP.parse_args(arguments)
    return command(*bound.args, **bound.kwargs)


def _extract_command(arguments: list[str]) -> tuple[str | None, list[str]]:
    """Pull a registered subcommand out of argv, leaving profile flags in place."""
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument in {"--help", "-h"}:
            index += 1
            continue
        if argument == "--profile":
            index += 2
            continue
        if argument.startswith("--profile="):
            index += 1
            continue
        if argument in _COMMANDS:
            return argument, arguments[:index] + arguments[index + 1 :]
        return None, arguments
    return None, arguments


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


def _models_payload(profile: str | None) -> Any:
    """Discover endpoints and build the same envelope as GET /v1/models."""
    from .models_api import list_models_payload

    return list_models_payload(_discover_endpoints(profile))


def _lookup_models(keyword: str, profile: str | None) -> list[dict[str, object]]:
    """Rank live endpoints using the shared model package's standard policy."""
    from dbx_tools.model import lookup_models

    endpoints = _discover_endpoints(profile)
    if endpoints is None:
        return []
    return lookup_models(endpoints, {"search": keyword})


def _discover_endpoints(profile: str | None) -> Sequence[Any] | None:
    """Load live endpoints while preserving the model-list registry fallback."""
    from databricks.sdk.errors import DatabricksError

    from .backend import DatabricksLiteLLMBackend

    backend = DatabricksLiteLLMBackend(profile=profile)
    try:
        return backend.catalogue().endpoints
    except (DatabricksError, OSError, RuntimeError, ValueError) as error:
        logger.warning("Live model discovery failed: %s", error)
        return None


def _format_models_text(payload: Mapping[str, Any], *, extended: bool = False) -> str:
    """Render advertised models with optional capability details."""
    data = payload.get("data")
    items = data if isinstance(data, Sequence) and not isinstance(data, (str, bytes)) else ()
    reasoning_by_id = _reasoning_by_id(payload)
    rows = [_model_row(item, reasoning_by_id) for item in items if isinstance(item, Mapping)]
    headers = ("NAME", "ID", "OWNER", "CONTEXT", "REASONING")
    if not extended:
        headers = headers[:2]
        rows = [row[:2] for row in rows]
    return _format_table(headers, rows, empty="No models found.")


def _model_row(
    item: Mapping[str, Any],
    reasoning_by_id: Mapping[str, str],
) -> tuple[str, str, str, str, str]:
    model_id = _text(item.get("id"))
    context = item.get("context_window")
    if not isinstance(context, int):
        context = item.get("max_input_tokens")
    return (
        _text(item.get("name")),
        model_id,
        _text(item.get("owned_by")),
        f"{context:,}" if isinstance(context, int) and context > 0 else "",
        reasoning_by_id.get(model_id, ""),
    )


def _format_lookup_text(ranked: Sequence[Mapping[str, Any]]) -> str:
    """Render ranked model matches with lower-is-better scores."""
    rows: list[tuple[str, str, str]] = []
    for match in ranked:
        endpoint = match.get("endpoint")
        if not isinstance(endpoint, Mapping):
            continue
        score = match.get("score")
        rows.append(
            (
                _text(endpoint.get("displayName")) or _text(endpoint.get("name")),
                _text(endpoint.get("name")),
                f"{score:.3f}" if isinstance(score, (int, float)) else "",
            )
        )
    return _format_table(("NAME", "ID", "SCORE"), rows, empty="No matching models found.")


def _format_table(
    headers: Sequence[str],
    rows: Sequence[Sequence[str]],
    *,
    empty: str,
) -> str:
    """Render a fixed-width plain-text table."""
    if not rows:
        return empty
    widths = [
        max(len(header), max(len(row[index]) for row in rows))
        for index, header in enumerate(headers)
    ]
    lines = [
        "  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)),
        "  ".join("-" * width for width in widths),
    ]
    lines.extend(
        "  ".join(column.ljust(widths[index]) for index, column in enumerate(row)) for row in rows
    )
    return "\n".join(lines)


def _reasoning_by_id(payload: Mapping[str, Any]) -> dict[str, str]:
    models = payload.get("models")
    if not isinstance(models, Sequence) or isinstance(models, (str, bytes)):
        return {}
    result: dict[str, str] = {}
    for item in models:
        if not isinstance(item, Mapping):
            continue
        slug = item.get("slug")
        if not isinstance(slug, str) or not slug:
            continue
        efforts = item.get("supported_reasoning_levels")
        if not isinstance(efforts, Sequence) or isinstance(efforts, (str, bytes)):
            continue
        names = [
            effort.get("effort")
            for effort in efforts
            if isinstance(effort, Mapping) and isinstance(effort.get("effort"), str)
        ]
        if names:
            result[slug] = ", ".join(names)
    return result


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _run_proxy(arguments: Sequence[str]) -> None:
    from litellm.proxy.proxy_cli import run_server

    from .models_api import install_models_compatibility_middleware
    from .patches import apply_litellm_patches

    apply_litellm_patches()
    install_models_compatibility_middleware()
    run_server.main(args=list(arguments), prog_name="dbx-litellm")
