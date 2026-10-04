from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

import pytest
from dbx_tools.model_proxy import cli, models_api


def test_cli_sets_profile_and_forwards_litellm_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []
    proxy_cli = ModuleType("litellm.proxy.proxy_cli")
    proxy_cli.run_server = SimpleNamespace(
        main=lambda *, args, prog_name: calls.append([prog_name, *args])
    )
    monkeypatch.setitem(sys.modules, "litellm.proxy.proxy_cli", proxy_cli)
    monkeypatch.setattr(models_api, "install_models_api", lambda: None)
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)

    cli.main(["--profile", "fevm", "--port", "4100"])

    assert calls[0][:2] == ["dbx-model-proxy", "--config"]
    assert calls[0][3:] == [
        "--host",
        "127.0.0.1",
        "--port",
        "4100",
    ]
    assert calls[0][2].endswith("dbx_tools/model_proxy/config.yaml")
    assert cli.os.environ["DATABRICKS_CONFIG_PROFILE"] == "fevm"
