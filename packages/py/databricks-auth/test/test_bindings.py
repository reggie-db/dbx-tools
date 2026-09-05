from dbx_tools.auth import StorageAdapter, create_storage_handle
from dbx_tools.databricks_auth import (
    DatabricksAuthOptions,
    create_persistent_auth_with_storage,
)


async def test_shared_adapter_crosses_native_library_boundary():
    calls = []

    class Store(StorageAdapter):
        async def load(self, profile):
            return '{"access_token":"cached","token_type":"Bearer","expiry":"2099-01-01T00:00:00Z"}'

        async def prepare_write(self):
            pass

        async def save(self, profile, token):
            pass

        async def remove(self, profile):
            calls.append(profile)

        async def acquire_lock(self, profile, timeout_millis):
            return "lease"

        async def release_lock(self, lease):
            calls.append(lease)

        def name(self):
            return "test"

    auth = await create_persistent_auth_with_storage(
        DatabricksAuthOptions(
            profile="ISOLATED",
            host="https://example.invalid",
            config_file="/nonexistent/auth-test-config",
            auth_type="databricks-cli",
        ),
        create_storage_handle(Store()),
    )
    assert (await auth.token(False)).access_token == "cached"
    await auth.logout()
    assert calls == ["ISOLATED", "lease"]
