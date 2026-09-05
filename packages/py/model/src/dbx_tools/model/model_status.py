from __future__ import annotations

import ast
import hashlib
import json
import logging
import os
import traceback
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup
from bs4.exceptions import ParserRejectedMarkup
from cachetools.func import ttl_cache
from dbx_tools.core.cache import check_lock_check, platform_cache_root

"""Daily Databricks model-retirement discovery with a generated fallback."""

RETIRED_MODELS_URL = "https://docs.databricks.com/aws/en/machine-learning/retired-models-policy"
RETIRED_MODELS_TTL = timedelta(days=1)

_CACHE_NAME = "retired_models.cache"
_LOGGER = logging.getLogger(__name__)
_MODEL_PREFIXES = {"ai", "anthropic", "databricks", "dbx", "google", "meta", "openai", "system"}
_RETIREMENT_HEADERS = {"open model", "partner model"}


@dataclass(frozen=True, slots=True)
class ModelStatus:
    """Status flags associated with one serving model."""

    deprecated: bool = False


def parse_retired_models(html: str) -> tuple[str, ...]:
    """Parse Foundation Model API model names from the retirement page."""
    document = BeautifulSoup(html, "html5lib")
    names: set[str] = set()
    for table in document.find_all("table"):
        rows = table.find_all("tr")
        if not rows:
            continue
        header = rows[0].find(["th", "td"])
        if header is None or _collapse_text(header.get_text(" ", strip=True)).casefold() not in (
            _RETIREMENT_HEADERS
        ):
            continue
        for row in rows[1:]:
            cell = row.find(["th", "td"])
            if cell is not None:
                names.update(_split_model_names(_collapse_text(cell.get_text(" ", strip=True))))
    models = tuple(sorted(names, key=str.casefold))
    if not models:
        raise ValueError("Databricks retirement tables contained no model names")
    return models


@ttl_cache(maxsize=1, ttl=RETIRED_MODELS_TTL.total_seconds())
def retired_model_names() -> frozenset[str]:
    """Return live retired-model names, or the generated fallback after an error."""
    return _load_retired_model_names(_default_cache_path())


def get(identities: Iterable[str], retired: frozenset[str] | None = None) -> ModelStatus:
    """Return the centralized status for a serving model's known identities."""
    names = retired_model_names() if retired is None else retired
    keys = tuple(_model_key(name) for name in names)
    return ModelStatus(
        deprecated=any(
            candidate == key or candidate.startswith(f"{key}-")
            for identity in identities
            if (candidate := _model_key(identity))
            for key in keys
            if key
        )
    )


def generate_retired_models(output: Path, now: datetime | None = None) -> bool:
    """Refresh the generated fallback when its embedded timestamp is at least one day old."""
    checked_at = _utc_now() if now is None else now.astimezone(timezone.utc)
    digest = hashlib.sha256(str(output.resolve()).encode()).hexdigest()
    lock_path = platform_cache_root() / "dbx-tools" / "model" / f"{digest}.lock"
    return check_lock_check(
        lock_path,
        lambda: False if _generated_is_fresh(output, checked_at) else None,
        lambda: _refresh_generated(output, checked_at),
    )


def _load_retired_model_names(cache_path: Path) -> frozenset[str]:
    """Load the daily disk cache once across threads and processes."""
    fallback = _generated_retired_models()
    lock_path = cache_path.with_suffix(f"{cache_path.suffix}.lock")
    return check_lock_check(
        lock_path,
        lambda: _load_fresh_cache(cache_path, fallback),
        lambda: _refresh_cache(cache_path, fallback),
    )


def _load_fresh_cache(cache_path: Path, fallback: frozenset[str]) -> frozenset[str] | None:
    """Return a usable fresh cache value, or signal that a refresh is required."""
    cached = _read_cache(cache_path)
    return None if cached is None else _fresh_cache_models(cached, _utc_now(), fallback)


def _refresh_cache(cache_path: Path, fallback: frozenset[str]) -> frozenset[str]:
    """Refresh the disk cache and preserve diagnostics when the refresh fails."""
    now = _utc_now()
    html = ""
    try:
        html = _download_html()
        models = frozenset(parse_retired_models(html))
        _write_cache(cache_path, _cache_payload(now, html))
        return models
    except (OSError, UnicodeError, ValueError, ParserRejectedMarkup) as error:
        detail = traceback.format_exc()
        try:
            _write_cache(cache_path, _cache_payload(now, html, error, detail))
        except OSError as cache_error:
            _LOGGER.warning("Could not write Databricks retired-model cache: %s", cache_error)
        _warn_using_fallback("Could not refresh Databricks retired models", error)
        return fallback


def _refresh_generated(output: Path, now: datetime) -> bool:
    """Fetch and persist one generated fallback snapshot."""
    html = _download_html()
    names = parse_retired_models(html)
    _write_generated(output, names, now)
    return True


def _download_html() -> str:
    """Download the Databricks model-maintenance policy HTML."""
    request = Request(RETIRED_MODELS_URL, headers={"User-Agent": "dbx-tools-model-status/1"})
    with urlopen(request, timeout=15) as response:
        return response.read().decode("utf-8")


def _fresh_cache_models(
    cached: dict[str, Any],
    now: datetime,
    fallback: frozenset[str],
) -> frozenset[str] | None:
    """Parse a fresh successful cache or return its generated fallback."""
    if not _cache_is_fresh(cached, now):
        return None
    if cached.get("error") is not None:
        _warn_using_fallback(
            "Databricks retired-model refresh is cached as failed",
            cached["error"],
        )
        return fallback
    data = cached.get("data")
    try:
        return frozenset(parse_retired_models(data if isinstance(data, str) else ""))
    except ValueError as error:
        _LOGGER.warning("Cached Databricks retired-model HTML is invalid: %s. Refreshing.", error)
        return None


def _generated_retired_models() -> frozenset[str]:
    """Load the committed retirement snapshot generated by post-synth."""
    from ._retired_models import RETIRED_MODEL_NAMES

    return frozenset(RETIRED_MODEL_NAMES)


def _default_cache_path() -> Path:
    """Return the runtime retirement-cache path."""
    return platform_cache_root() / "dbx-tools" / "model" / _CACHE_NAME


def _cache_payload(
    now: datetime,
    html: str,
    error: Exception | None = None,
    detail: str | None = None,
) -> dict[str, str | None]:
    """Build the persisted cache envelope."""
    return {
        "updatedAt": now.isoformat(),
        "data": html,
        "error": str(error) if error is not None else None,
        "errorDetail": detail,
    }


def _read_cache(path: Path) -> dict[str, Any] | None:
    """Read a cache envelope and log malformed or inaccessible state."""
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as error:
        _LOGGER.warning("Could not read Databricks retired-model cache %s: %s", path, error)
        return None
    if not isinstance(value, dict):
        _LOGGER.warning("Databricks retired-model cache %s is not a JSON object", path)
        return None
    return value


def _write_cache(path: Path, payload: dict[str, str | None]) -> None:
    """Atomically persist a cache envelope."""
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, f"{json.dumps(payload, ensure_ascii=False)}\n")


def _cache_is_fresh(payload: dict[str, Any], now: datetime) -> bool:
    """Return whether a cache envelope remains inside the daily TTL."""
    updated_at = payload.get("updatedAt")
    if not isinstance(updated_at, str):
        return False
    try:
        updated = datetime.fromisoformat(updated_at).astimezone(timezone.utc)
    except ValueError as error:
        _LOGGER.warning("Databricks retired-model cache has an invalid timestamp: %s", error)
        return False
    return now - updated < RETIRED_MODELS_TTL


def _generated_is_fresh(path: Path, now: datetime) -> bool:
    """Read the generated module timestamp without importing it."""
    try:
        tree = ast.parse(path.read_text())
    except FileNotFoundError:
        return False
    except (OSError, SyntaxError) as error:
        _LOGGER.warning("Could not inspect generated retired models at %s: %s", path, error)
        return False
    generated_at = next(
        (
            node.value.value
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "GENERATED_AT"
                for target in node.targets
            )
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ),
        None,
    )
    if generated_at is None:
        _LOGGER.warning("Generated retired models at %s have no GENERATED_AT value", path)
        return False
    try:
        generated = datetime.fromisoformat(generated_at).astimezone(timezone.utc)
    except ValueError as error:
        _LOGGER.warning("Generated retired models have an invalid timestamp: %s", error)
        return False
    return now - generated < RETIRED_MODELS_TTL


def _write_generated(path: Path, names: tuple[str, ...], now: datetime) -> None:
    """Atomically write and protect the generated fallback module."""
    values = "".join(f"    {name!r},\n" for name in names)
    content = (
        "# GENERATED by projen post-synth from the Databricks retired models policy - "
        "DO NOT EDIT.\n"
        "# Hand edits are overwritten when the daily source snapshot refreshes.\n\n"
        f'GENERATED_AT = "{now.isoformat()}"\n\n'
        "RETIRED_MODEL_NAMES = (\n"
        f"{values}"
        ")\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.chmod(0o644)
    _atomic_write(path, content)
    path.chmod(0o444)


def _atomic_write(path: Path, content: str) -> None:
    """Replace a file atomically from a sibling temporary file."""
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _split_model_names(value: str) -> list[str]:
    """Split slash-delimited aliases from one policy-table cell."""
    return [part.strip() for part in value.split("/") if part.strip()]


def _collapse_text(value: str) -> str:
    """Collapse HTML text fragments to one space between tokens."""
    return " ".join(value.split())


def _warn_using_fallback(message: str, error: object) -> None:
    """Log a concise fallback warning without attaching a traceback."""
    _LOGGER.warning("%s: %s. Using generated fallback.", message, error)


def _model_key(value: str) -> str:
    """Normalize policy and endpoint names for conservative prefix matching."""
    normalized = "".join(
        character if character.isalnum() else " " for character in value.casefold()
    )
    tokens = normalized.split()
    while tokens and tokens[0] in _MODEL_PREFIXES:
        tokens.pop(0)
    return "-".join(tokens)


def _utc_now() -> datetime:
    """Return an aware UTC timestamp."""
    return datetime.now(timezone.utc)
