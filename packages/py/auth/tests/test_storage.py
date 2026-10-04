from __future__ import annotations

import asyncio
import json
from pathlib import Path

from dbx_tools.auth import FileCredentialStore
from dbx_tools.auth.client import javascript_runtime
from dbx_tools.auth.javascript import construct, invoke


async def test_file_store_preserves_unrelated_cache_entries(tmp_path: Path) -> None:
    cache = tmp_path / "token-cache.json"
    cache.write_text(
        json.dumps({"version": 1, "tokens": {"unrelated": {"custom": True}}}),
        encoding="utf-8",
    )
    store = FileCredentialStore(tmp_path)

    await store.save(
        "profile",
        {"accessToken": "stored", "tokenType": "Bearer", "scopes": ["all-apis"]},
    )

    saved = json.loads(cache.read_text(encoding="utf-8"))
    assert saved["tokens"]["unrelated"] == {"custom": True}
    assert saved["tokens"]["profile"]["access_token"] == "stored"
    loaded = await store.load("profile")
    assert loaded and loaded["accessToken"] == "stored"


async def test_javascript_file_store_uses_proper_lockfile(tmp_path: Path) -> None:
    runtime = javascript_runtime()
    left = construct(runtime["FileCredentialStore"], str(tmp_path))
    right = construct(runtime["FileCredentialStore"], str(tmp_path))

    await asyncio.gather(
        invoke(
            left,
            "save",
            "left",
            {"accessToken": "left-token", "tokenType": "Bearer", "scopes": []},
        ),
        invoke(
            right,
            "save",
            "right",
            {"accessToken": "right-token", "tokenType": "Bearer", "scopes": []},
        ),
    )

    cache = json.loads((tmp_path / "token-cache.json").read_text(encoding="utf-8"))
    assert sorted(cache["tokens"]) == ["left", "right"]
    assert list((tmp_path / "locks").iterdir()) == []
