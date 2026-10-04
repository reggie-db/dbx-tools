from dbx_tools.auth.node_bindings import normalize_host


async def test_generated_function_wrapper_calls_embedded_runtime() -> None:
    assert await normalize_host("https://example.cloud.databricks.com/") == (
        "https://example.cloud.databricks.com"
    )
