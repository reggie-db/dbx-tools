from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from dbx_tools.node_bindings import FileLeaseLocks, MemoryLeaseLocks


@pytest.mark.parametrize("kind", ["memory", "file"])
async def test_lease_blocks_same_key(tmp_path: Path, kind: str) -> None:
    locks = MemoryLeaseLocks() if kind == "memory" else FileLeaseLocks(tmp_path)
    lease = await locks.acquire("profile", 100)

    with pytest.raises((TimeoutError, asyncio.TimeoutError)):
        await locks.acquire("profile", 10)

    await locks.release(lease)
    replacement = await locks.acquire("profile", 100)
    await locks.release(replacement)
