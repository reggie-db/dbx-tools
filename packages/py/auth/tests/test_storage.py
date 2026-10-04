from __future__ import annotations

import json
from pathlib import Path

from dbx_tools.auth import FileCredentialStore


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
