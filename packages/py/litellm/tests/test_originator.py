from dbx_tools.litellm.originator import (
    forward_codex_originator,
    is_codex_originator,
    is_codex_request,
    request_originator,
)


def test_identifies_codex_originators() -> None:
    for value in ("codex_cli_rs", "codex_vscode", "Codex SDK"):
        assert is_codex_originator(value)

    for value in (None, "", "openai-python", "cursor"):
        assert not is_codex_originator(value)


def test_reads_originator_from_proxy_request_headers() -> None:
    data = {
        "proxy_server_request": {
            "headers": {
                "Originator": "codex_cli_rs",
            }
        }
    }

    assert request_originator(data) == "codex_cli_rs"
    assert is_codex_request(data)


def test_reads_originator_from_nested_litellm_metadata() -> None:
    data = {
        "litellm_params": {
            "proxy_server_request": {
                "headers": {
                    "originator": "openai-python",
                }
            }
        }
    }

    assert request_originator(data) == "openai-python"
    assert not is_codex_request(data)


def test_forwards_only_codex_originator_header() -> None:
    codex = {
        "proxy_server_request": {
            "headers": {
                "originator": "codex_cli_rs",
            }
        },
        "extra_headers": {
            "x-client-request-id": "request-1",
        },
    }
    standard = {
        "proxy_server_request": {
            "headers": {
                "originator": "openai-python",
            }
        }
    }

    forward_codex_originator(codex)
    forward_codex_originator(standard)

    assert codex["extra_headers"] == {
        "originator": "codex_cli_rs",
        "x-client-request-id": "request-1",
    }
    assert "extra_headers" not in standard
