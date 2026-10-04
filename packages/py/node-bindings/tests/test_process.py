from __future__ import annotations

import sys

from dbx_tools.node_bindings import run_process, runProcess


async def test_process_binding_runs_and_aliases() -> None:
    result = await run_process(
        sys.executable,
        ["-c", "import sys; sys.stdout.write('ok'); sys.stderr.write('note')"],
    )

    assert result == {"exitCode": 0, "stdout": "ok", "stderr": "note"}
    assert runProcess is run_process
