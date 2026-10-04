from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from dbx_tools.node_bindings import FileLeaseLocks, MemoryLeaseLocks, with_file_lock


@pytest.mark.parametrize("kind", ["memory", "file"])
async def test_lease_blocks_same_key(tmp_path: Path, kind: str) -> None:
    locks = MemoryLeaseLocks() if kind == "memory" else FileLeaseLocks(tmp_path)
    lease = await locks.acquire("profile", 100)

    with pytest.raises((TimeoutError, asyncio.TimeoutError)):
        await locks.acquire("profile", 10)

    await locks.release(lease)
    replacement = await locks.acquire("profile", 100)
    await locks.release(replacement)


async def test_with_file_lock_runs_callback(tmp_path: Path) -> None:
    called = False

    async def action() -> str:
        nonlocal called
        called = True
        return "ready"

    assert await with_file_lock(tmp_path / "state.json", action) == "ready"
    assert called is True
