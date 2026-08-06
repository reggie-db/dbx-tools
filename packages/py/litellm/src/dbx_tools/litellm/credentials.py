"""Process-wide Databricks credentials with proactive background refresh.

LiteLLM's built-in Databricks provider builds a fresh ``WorkspaceClient`` on
every request, so each call re-reads ``.databrickscfg`` and mints a new
one-hour token that is used once and discarded. Holding one client here and
handing LiteLLM an explicit ``api_key``/``api_base`` keeps that provider on its
short-circuit path, where a supplied key is used verbatim.
"""

from __future__ import annotations

import datetime as dt
import threading
from dataclasses import dataclass

from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config

# Refresh this far ahead of expiry so a request never waits on a token mint.
# Databricks OAuth tokens live for an hour; the SDK's own staleness cap is 20
# minutes, and staying inside it keeps both refresh paths in agreement.
REFRESH_LEAD = dt.timedelta(minutes=10)

# Fallback lifetime for auth types that expose no expiry (notably PAT, where the
# token is static and re-reading it is still cheap).
DEFAULT_LIFETIME = dt.timedelta(minutes=30)

_AUTHORIZATION = "Authorization"
_BEARER_PREFIX = "Bearer "


@dataclass(frozen=True)
class Credentials:
    """A bearer token and the serving base URL it authenticates against."""

    token: str
    api_base: str


class DatabricksCredentials:
    """Serve one cached token per profile, refreshed before it expires.

    ``authenticate()`` is the only supported way to read credentials off an SDK
    config: it covers every auth type and returns whatever header the resolved
    strategy produces. ``oauth_token()`` is consulted purely as an expiry hint
    and only when the SDK has already resolved an OAuth strategy, because on a
    PAT or metadata-backed profile it can block on network probing.
    """

    def __init__(self, *, profile: str) -> None:
        self.profile = profile
        # disable_async_token_refresh must be passed on Config; WorkspaceClient
        # does not accept it, and its env var is parsed as a string (so any
        # value, including "false", is truthy). With it off, the SDK also
        # refreshes in the background once a token goes stale.
        self._client = WorkspaceClient(
            config=Config(profile=profile, disable_async_token_refresh=False)
        )
        self._api_base = f"{self._client.config.host.rstrip('/')}/serving-endpoints"
        self._lock = threading.RLock()
        self._cached: Credentials | None = None
        self._renew_at = dt.datetime.min.replace(tzinfo=dt.timezone.utc)

    @property
    def client(self) -> WorkspaceClient:
        """The shared SDK client, reused for endpoint discovery as well."""
        return self._client

    @property
    def api_base(self) -> str:
        return self._api_base

    def current(self) -> Credentials:
        """Return cached credentials, minting a new token only once stale."""
        with self._lock:
            if self._cached is None or _utcnow() >= self._renew_at:
                self._cached = self._mint()
            return self._cached

    def invalidate(self) -> None:
        """Drop the cached token so the next read re-authenticates."""
        with self._lock:
            self._cached = None
            self._renew_at = dt.datetime.min.replace(tzinfo=dt.timezone.utc)

    def _mint(self) -> Credentials:
        headers = self._client.config.authenticate()
        authorization = headers.get(_AUTHORIZATION, "")
        if not authorization.startswith(_BEARER_PREFIX):
            raise RuntimeError(
                f"Databricks profile {self.profile!r} produced a non-bearer "
                f"{_AUTHORIZATION} header; cannot forward it as an api_key."
            )
        self._renew_at = self._next_renewal()
        return Credentials(
            token=authorization[len(_BEARER_PREFIX) :],
            api_base=self._api_base,
        )

    def _next_renewal(self) -> dt.datetime:
        """Choose when to re-mint, preferring the token's own expiry."""
        now = _utcnow()
        expiry = self._expiry()
        if expiry is None:
            return now + DEFAULT_LIFETIME
        # Never return a renewal in the past: a token already inside the lead
        # window would otherwise be re-minted on every single request.
        return max(expiry - REFRESH_LEAD, now + REFRESH_LEAD)

    def _expiry(self) -> dt.datetime | None:
        """Read the OAuth expiry when one is cheaply available."""
        try:
            expiry = self._client.config.oauth_token().expiry
        except Exception:  # noqa: BLE001
            # PAT and metadata-backed strategies raise here rather than
            # exposing an expiry; fall back to a fixed lifetime instead of
            # branching on auth type.
            return None
        if expiry is None:
            return None
        # The SDK reports a naive expiry in LOCAL time. Attaching UTC to it
        # directly would shift it by the local offset and look long expired.
        return expiry.astimezone(dt.timezone.utc) if expiry.tzinfo else expiry.astimezone()


def _utcnow() -> dt.datetime:
    return dt.datetime.now(tz=dt.timezone.utc)
