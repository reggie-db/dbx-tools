from __future__ import annotations

import os
from collections.abc import Mapping

"""Environment names shared by the launcher and Graphiti server process."""

UPSTREAM_MCP_PATH_ENV = "UPSTREAM_MCP_PATH"
PERSISTENCE_ENV = (
    "JOURNAL_DATABASE_URL",
    "LAKEBASE_ENDPOINT",
    "LAKEBASE_INSTANCE_NAME",
    "PGHOST",
)


def persistence_configured(environ: Mapping[str, str] | None = None) -> bool:
    """Return whether the environment selects a Postgres write journal."""
    env = os.environ if environ is None else environ
    return any(env.get(name, "").strip() for name in PERSISTENCE_ENV)
