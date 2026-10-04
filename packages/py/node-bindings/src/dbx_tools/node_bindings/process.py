from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import TypedDict

from dbx_tools.core.bin import execute


class ProcessResult(TypedDict, total=False):
    exitCode: int
    stdout: str
    stderr: str


async def run_process(
    command: str,
    args: Sequence[str] = (),
    *,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    input: str | None = None,
    timeout_ms: int | None = None,
) -> ProcessResult:
    """Run a process and return a portable completion record."""
    if not command.strip():
        raise ValueError("Process command must not be empty")
    process = await execute(
        command,
        *args,
        cwd=cwd,
        env={**os.environ, **env} if env else None,
        stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    communication = process.communicate(input.encode() if input is not None else None)
    try:
        stdout, stderr = await (
            asyncio.wait_for(communication, timeout_ms / 1000)
            if timeout_ms is not None
            else communication
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    stdout_text = (stdout or b"").decode(errors="replace").strip() or None
    stderr_text = (stderr or b"").decode(errors="replace").strip() or None
    return {
        "exitCode": process.returncode,
        **({"stdout": stdout_text} if stdout_text else {}),
        **({"stderr": stderr_text} if stderr_text else {}),
    }
