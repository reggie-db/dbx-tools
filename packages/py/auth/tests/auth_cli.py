from __future__ import annotations

import argparse
import asyncio
import json
import os
from collections.abc import Mapping
from typing import Any

from dbx_tools.auth import create_databricks_cli_auth

PROFILE_ENVIRONMENT_KEYS = (
    "DATABRICKS_CONFIG_PROFILE",
    "DATABRICKS_CONFIG_FILE",
    "DATABRICKS_AUTH_TYPE",
    "DATABRICKS_HOST",
    "DATABRICKS_CLIENT_ID",
    "DATABRICKS_CLIENT_SECRET",
    "DATABRICKS_TOKEN",
    "DATABRICKS_CLI_PATH",
)
SECRET_ENVIRONMENT_KEYS = {
    "DATABRICKS_CLIENT_SECRET",
    "DATABRICKS_TOKEN",
}


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect dbx-tools-auth token and request-header resolution.",
    )
    parser.add_argument("command", choices=("token", "authenticate", "both"))
    parser.add_argument(
        "--login",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Allow the auth lifecycle to run an interactive Databricks CLI login.",
    )
    parser.add_argument(
        "--show-sensitive",
        action="store_true",
        help="Print complete access tokens and authorization headers.",
    )
    return parser.parse_args()


def _redact(value: str, show_sensitive: bool) -> str:
    if show_sensitive or not value:
        return value
    if len(value) <= 8:
        return f"<redacted:{len(value)}>"
    return f"{value[:4]}...{value[-4:]}<{len(value)}>"


def _environment(environment: Mapping[str, str], show_sensitive: bool) -> dict[str, object]:
    return {
        key: (
            _redact(environment[key], show_sensitive)
            if key in SECRET_ENVIRONMENT_KEYS
            else environment[key]
        )
        for key in PROFILE_ENVIRONMENT_KEYS
        if key in environment
    }


async def _main() -> None:
    arguments = _arguments()
    environment = dict(os.environ)
    auth = await create_databricks_cli_auth(environment=environment)
    output: dict[str, Any] = {
        "command": arguments.command,
        "login": arguments.login,
        "environment": _environment(environment, arguments.show_sensitive),
        "resolved": {
            "profile": auth.status().profile,
            "host": auth.status().host,
            "workspaceId": auth.workspace_id(),
            "storage": auth.status().storage,
            "authKind": auth.auth_kind(),
            "principal": auth.principal(),
        },
    }
    if arguments.command in {"token", "both"}:
        token = await auth.token(arguments.login)
        output["token"] = {
            **token,
            "accessToken": _redact(token["accessToken"], arguments.show_sensitive),
        }
    if arguments.command in {"authenticate", "both"}:
        headers = await auth.authenticate(arguments.login)
        output["authenticate"] = {
            name: (
                value
                if arguments.show_sensitive or name.lower() != "authorization"
                else f"Bearer {_redact(value.removeprefix('Bearer '), False)}"
            )
            for name, value in headers.items()
        }
    print(json.dumps(output, indent=2, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(_main())
