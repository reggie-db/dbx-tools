from __future__ import annotations

import pytest
from dbx_tools.databricks import is_databricks_app

_ENVIRONMENT_KEYS = (
    "DBX_TOOLS_DATABRICKS_APP_ENV",
    "DATABRICKS_APP_NAME",
    "DATABRICKS_HOST",
    "DATABRICKS_APP_PORT",
)


@pytest.mark.parametrize(
    ("environment", "expected"),
    [
        (
            {
                "DATABRICKS_APP_NAME": "example",
                "DATABRICKS_HOST": "https://example.cloud.databricks.com",
                "DATABRICKS_APP_PORT": "8000",
            },
            True,
        ),
        (
            {
                "DBX_TOOLS_DATABRICKS_APP_ENV": "false",
                "DATABRICKS_APP_NAME": "example",
                "DATABRICKS_HOST": "https://example.cloud.databricks.com",
                "DATABRICKS_APP_PORT": "8000",
            },
            False,
        ),
        (
            {
                "DATABRICKS_APP_NAME": "example",
                "DATABRICKS_HOST": "https://example.cloud.databricks.com",
                "DATABRICKS_APP_PORT": "70000",
            },
            False,
        ),
    ],
)
def test_detects_databricks_app_environment(
    monkeypatch: pytest.MonkeyPatch,
    environment: dict[str, str],
    expected: bool,
) -> None:
    for key in _ENVIRONMENT_KEYS:
        monkeypatch.delenv(key, raising=False)
    for key, value in environment.items():
        monkeypatch.setenv(key, value)

    assert is_databricks_app() is expected
