from __future__ import annotations

from pathlib import Path

from dbx_tools.node_bindings import atomic_write_json, read_json


async def test_atomic_json_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "state.json"

    await atomic_write_json(path, {"ready": True})

    assert await read_json(path) == {"ready": True}
    assert path.stat().st_mode & 0o777 == 0o600
