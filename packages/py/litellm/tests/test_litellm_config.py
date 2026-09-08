from importlib import import_module
from pathlib import Path

"""Tests for the packaged LiteLLM proxy configuration."""

yaml = import_module("yaml")


def test_config_uses_only_native_databricks_routing() -> None:
    config_path = Path(__file__).parents[1] / "src" / "dbx_tools" / "litellm" / "config.yaml"
    config = yaml.safe_load(config_path.read_text())

    assert config == {
        "model_list": [
            {
                "model_name": "*",
                "litellm_params": {
                    "model": "databricks/*",
                },
            }
        ],
        "litellm_settings": {
            "callbacks": [
                "config_provider.dbx_model_router",
                "config_provider.dbx_access_logger",
            ]
        },
    }
