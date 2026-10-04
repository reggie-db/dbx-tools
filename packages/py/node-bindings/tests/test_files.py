from __future__ import annotations

from pathlib import Path

from dbx_tools.node_bindings import atomic_write_text, read_text


async def test_atomic_text_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "state.json"

    await atomic_write_text(path, "ready\n")

    assert await read_text(path) == "ready\n"
    assert path.stat().st_mode & 0o777 == 0o600
