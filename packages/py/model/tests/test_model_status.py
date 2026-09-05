from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from dbx_tools.model import model_status

_RETIREMENT_HTML = """
<html>
  <table>
    <tr><th>Partner model</th><th>Retirement date</th></tr>
    <tr><td>Gemini <strong>2.5</strong> Pro</td><td>October 2, 2026</td></tr>
  </table>
  <table>
    <tr><th>Open model</th><th>Retirement date</th></tr>
    <tr><td>DBRX / DBRX Instruct</td><td>April 30, 2025</td></tr>
  </table>
  <table>
    <tr><th>Model family</th><th>Retirement date</th></tr>
    <tr><td>Fine-tuning only</td><td>April 30, 2025</td></tr>
  </table>
</html>
"""


def test_parse_retired_models_selects_foundation_api_tables() -> None:
    assert model_status.parse_retired_models(_RETIREMENT_HTML) == (
        "DBRX",
        "DBRX Instruct",
        "Gemini 2.5 Pro",
    )


def test_get_matches_endpoint_and_entity_names() -> None:
    assert model_status.get(
        ["custom-endpoint", "system.ai.gemini-2-5-pro"],
        frozenset({"Gemini 2.5 Pro"}),
    ).deprecated
    assert model_status.get(
        ["databricks-meta-llama-3-70b-instruct"],
        frozenset({"Meta Llama 3 (70B)"}),
    ).deprecated
    assert not model_status.get(
        ["databricks-gemini-3-1-pro"],
        frozenset({"Gemini 3 Pro"}),
    ).deprecated


def test_generator_rechecks_freshness_after_lock(monkeypatch, tmp_path: Path) -> None:
    checks = iter([False, True])
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(model_status, "_generated_is_fresh", lambda *_: next(checks))
    monkeypatch.setattr(
        model_status,
        "_download_html",
        lambda: (_ for _ in ()).throw(AssertionError("unexpected download")),
    )

    assert (
        model_status.generate_retired_models(
            tmp_path / "_retired_models.py",
            datetime(2026, 9, 5, tzinfo=timezone.utc),
        )
        is False
    )


def test_fresh_disk_cache_is_authoritative(monkeypatch, tmp_path: Path) -> None:
    cache = tmp_path / "retired_models.cache"
    now = datetime(2026, 9, 5, tzinfo=timezone.utc)
    cache.write_text(
        json.dumps(
            {
                "updatedAt": now.isoformat(),
                "data": _RETIREMENT_HTML,
                "error": None,
                "errorDetail": None,
            }
        )
    )
    monkeypatch.setattr(model_status, "_utc_now", lambda: now)
    monkeypatch.setattr(
        model_status,
        "_download_html",
        lambda: (_ for _ in ()).throw(AssertionError("unexpected download")),
    )
    monkeypatch.setattr(
        model_status,
        "_generated_retired_models",
        lambda: frozenset({"Generated fallback"}),
    )

    assert model_status._load_retired_model_names(cache) == frozenset(
        {"DBRX", "DBRX Instruct", "Gemini 2.5 Pro"}
    )


def test_refresh_error_is_cached_with_detail_and_uses_fallback(
    monkeypatch,
    tmp_path: Path,
    caplog,
) -> None:
    cache = tmp_path / "retired_models.cache"
    now = datetime(2026, 9, 5, tzinfo=timezone.utc)
    fallback = frozenset({"Generated fallback"})
    monkeypatch.setattr(model_status, "_utc_now", lambda: now)
    monkeypatch.setattr(
        model_status,
        "_download_html",
        lambda: (_ for _ in ()).throw(OSError("network unavailable")),
    )
    monkeypatch.setattr(model_status, "_generated_retired_models", lambda: fallback)

    with caplog.at_level(logging.WARNING):
        assert model_status._load_retired_model_names(cache) == fallback

    payload = json.loads(cache.read_text())
    assert payload["data"] == ""
    assert payload["error"] == "network unavailable"
    assert "Traceback" in payload["errorDetail"]
    assert caplog.messages == [
        (
            "Could not refresh Databricks retired models: network unavailable. "
            "Using generated fallback."
        )
    ]
