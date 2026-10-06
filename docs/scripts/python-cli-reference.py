"""Render Graphiti command references using Cyclopts' native Markdown generator."""

from __future__ import annotations

import json
from io import StringIO

from dbx_tools.graphiti.cli import _APP
from rich.console import Console

_APP.help_flags = ()
_APP.help_formatter = "plain"
output = StringIO()
_APP.help_print(console=Console(file=output, width=100, color_system=None, force_terminal=False))
commands = [name for name in _APP if not name.startswith("-") and _APP[name].show]
full = "### Python Graphiti Commands\n\n```text\n" + output.getvalue().rstrip() + "\n```\n\n"
full += "\n\n".join(
    _APP[name]
    .generate_docs(
        heading_level=3,
        usage_name=f"python -m dbx_tools.graphiti {name}",
    )
    .strip()
    for name in commands
)

print(
    json.dumps(
        {
            "full": full,
            "start": _APP["start"].generate_docs(
                heading_level=4,
                usage_name="dbx graphiti",
            ),
        }
    )
)
