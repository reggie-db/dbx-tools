from __future__ import annotations

import datetime as dt
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from dbx_tools.litellm.credentials import (
    DEFAULT_LIFETIME,
    REFRESH_LEAD,
    DatabricksCredentials,
)

UTC = dt.timezone.utc
HOST = "https://example.cloud.databricks.com"


class FakeToken:
    def __init__(self, expiry: dt.datetime | None) -> None:
        self.expiry = expiry


class FakeConfig:
    """Stand in for databricks.sdk Config, counting authenticate() calls."""

    def __init__(self, *, expiry: dt.datetime | None, oauth_error: Exception | None = None) -> None:
        self.host = HOST
        self.authenticate_count = 0
        self._expiry = expiry
        self._oauth_error = oauth_error

    def authenticate(self) -> dict[str, str]:
        self.authenticate_count += 1
        return {"Authorization": f"Bearer token-{self.authenticate_count}"}

    def oauth_token(self) -> FakeToken:
        if self._oauth_error is not None:
            raise self._oauth_error
        return FakeToken(self._expiry)


class FakeClient:
    def __init__(self, config: FakeConfig) -> None:
        self.config = config


def build(config: FakeConfig) -> DatabricksCredentials:
    """Construct the cache around a fake client, bypassing SDK/network setup."""
    credentials = DatabricksCredentials.__new__(DatabricksCredentials)
    credentials.profile = "TEST"
    credentials._client = FakeClient(config)
    credentials._api_base = f"{HOST}/serving-endpoints"
    credentials._lock = threading.RLock()
    credentials._cached = None
    credentials._renew_at = dt.datetime.min.replace(tzinfo=UTC)
    return credentials


def naive_local_expiry(delta: dt.timedelta) -> dt.datetime:
    """Mimic the SDK, which reports a timezone-naive expiry in local time."""
    return (dt.datetime.now(tz=UTC) + delta).astimezone().replace(tzinfo=None)


def test_token_is_minted_once_and_reused() -> None:
    config = FakeConfig(expiry=naive_local_expiry(dt.timedelta(hours=1)))
    credentials = build(config)

    tokens = {credentials.current().token for _ in range(10)}

    assert tokens == {"token-1"}
    assert config.authenticate_count == 1


def test_api_base_targets_serving_endpoints() -> None:
    credentials = build(FakeConfig(expiry=naive_local_expiry(dt.timedelta(hours=1))))

    assert credentials.current().api_base == f"{HOST}/serving-endpoints"


def test_renewal_is_scheduled_ahead_of_expiry() -> None:
    expiry = naive_local_expiry(dt.timedelta(hours=1))
    credentials = build(FakeConfig(expiry=expiry))

    credentials.current()

    # The naive local expiry must be read as local time, not stamped as UTC;
    # doing the latter would place renewal in the past and re-mint every call.
    aware_expiry = expiry.astimezone()
    assert credentials._renew_at == aware_expiry - REFRESH_LEAD
    assert credentials._renew_at > dt.datetime.now(tz=UTC)


def test_stale_token_is_reminted() -> None:
    config = FakeConfig(expiry=naive_local_expiry(dt.timedelta(hours=1)))
    credentials = build(config)

    first = credentials.current().token
    credentials._renew_at = dt.datetime.now(tz=UTC) - dt.timedelta(seconds=1)
    second = credentials.current().token

    assert first != second
    assert config.authenticate_count == 2


def test_concurrent_stale_reads_share_one_refresh() -> None:
    started = threading.Event()
    release = threading.Event()
    second_entered = threading.Event()

    class SlowConfig(FakeConfig):
        def authenticate(self) -> dict[str, str]:
            started.set()
            assert release.wait(timeout=5)
            return super().authenticate()

    config = SlowConfig(expiry=naive_local_expiry(dt.timedelta(hours=1)))
    credentials = build(config)

    def second_read() -> str:
        second_entered.set()
        return credentials.current().token

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(lambda: credentials.current().token)
        assert started.wait(timeout=5)
        second = executor.submit(second_read)
        assert second_entered.wait(timeout=5)
        release.set()

    assert first.result() == "token-1"
    assert second.result() == "token-1"
    assert config.authenticate_count == 1


def test_expiry_inside_lead_window_still_renews_in_future() -> None:
    # A token already within the refresh lead must not pin renewal to the past.
    config = FakeConfig(expiry=naive_local_expiry(dt.timedelta(minutes=2)))
    credentials = build(config)

    credentials.current()

    assert credentials._renew_at > dt.datetime.now(tz=UTC)


def test_missing_oauth_expiry_falls_back_to_default_lifetime() -> None:
    # PAT profiles raise instead of exposing an expiry.
    error = ValueError("OAuth tokens are not available for pat authentication.")
    credentials = build(FakeConfig(expiry=None, oauth_error=error))

    credentials.current()

    expected = dt.datetime.now(tz=UTC) + DEFAULT_LIFETIME
    assert abs((credentials._renew_at - expected).total_seconds()) < 5


def test_invalidate_forces_reauthentication() -> None:
    config = FakeConfig(expiry=naive_local_expiry(dt.timedelta(hours=1)))
    credentials = build(config)

    credentials.current()
    credentials.invalidate()
    credentials.current()

    assert config.authenticate_count == 2


def test_non_bearer_authorization_is_rejected() -> None:
    config = FakeConfig(expiry=None)
    config.authenticate = lambda: {"Authorization": "Basic abc123"}  # type: ignore[method-assign]
    credentials = build(config)

    with pytest.raises(RuntimeError, match="non-bearer"):
        credentials.current()
