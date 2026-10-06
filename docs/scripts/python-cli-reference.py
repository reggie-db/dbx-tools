"""Render Graphiti command references from Cyclopts command metadata."""

from __future__ import annotations

import json

from dbx_tools.graphiti.cli import _APP

_APP.help_flags = ()


def _cell(value: object) -> str:
    return str(value or "").replace("|", "\\|").replace("\n", " ").strip()


def _term(value: object) -> str:
    escaped = _cell(value).replace("`", "\\`")
    return f"`{escaped}`"


def _table(headers: list[str], rows: list[list[str]]) -> str:
    formatted = [
        [_term(cell) if index == 0 else _cell(cell) for index, cell in enumerate(row)]
        for row in rows
    ]
    body = [headers, ["---"] * len(headers), *formatted]
    return "\n".join(f"| {' | '.join(row)} |" for row in body)


def _visible_commands(app) -> list[str]:
    return [name for name in app if not name.startswith("-") and app[name].show]


def _option_rows(app) -> list[list[str]]:
    if app.default_command is None:
        return []
    rows: list[list[str]] = []
    for argument in app.assemble_argument_collection():
        if not argument.show:
            continue
        extras: list[str] = []
        if argument.parameter.env_var:
            extras.append(f"env: {', '.join(argument.parameter.env_var)}")
        description = argument.parameter.help or ""
        if extras:
            description = f"{description} ({', '.join(extras)})" if description else f"({', '.join(extras)})"
        rows.append([", ".join(argument.names), description])
    return rows


def command_reference(app, heading: str, usage: str) -> str:
    parts = [f"{heading} `{usage}`"]
    help_text = (app.help or "").strip()
    if help_text:
        parts.append(help_text)
    parts.append(f"```sh\n{usage}\n```")
    commands = _visible_commands(app)
    if commands:
        parts.extend(
            [
                "#### Commands",
                _table(
                    ["Command", "Description"],
                    [[name, (app[name].help or "").strip()] for name in commands],
                ),
            ]
        )
    options = _option_rows(app)
    if options:
        parts.extend(["#### Options", _table(["Option", "Description"], options)])
    return "\n\n".join(parts)


commands = _visible_commands(_APP)
full = command_reference(_APP, "###", "python -m dbx_tools.graphiti")
full += "\n\n" + "\n\n".join(
    command_reference(_APP[name], "###", f"python -m dbx_tools.graphiti {name}") for name in commands
)
start = command_reference(_APP["start"], "####", "dbx graphiti [ARGS]")

print(json.dumps({"full": full, "start": start}))
