from dbx_tools.auth import (
    AuthOptions,
    ProviderOptions,
    StorageAdapter,
    create_provider_auth_with_storage,
    create_storage_handle,
)
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
            assert timeout_millis == 7000
            return "lease"

        async def release_lock(self, lease):
            calls.append(lease)

        def name(self):
            return "test"

    storage = create_storage_handle(Store())
    auth = await create_persistent_auth_with_storage(
        DatabricksAuthOptions(
            profile="ISOLATED",
            host="https://example.invalid",
            config_file="/nonexistent/auth-test-config",
            auth_type="databricks-cli",
            auth=AuthOptions(lock_timeout_seconds=7),
        ),
        storage,
    )
    assert (await auth.token(False)).access_token == "cached"
    await auth.logout()
    assert calls == ["ISOLATED", "lease"]
    provider = await create_provider_auth_with_storage(
        ProviderOptions(
            provider="example",
            client_id="client",
            token_endpoint="https://example.invalid/token",
            authorization_endpoint="https://example.invalid/authorize",
            auth=AuthOptions(lock_timeout_seconds=7),
        ),
        storage,
    )
    assert (await provider.token(False)).access_token == "cached"
    await provider.logout()
    assert len(calls) == 4
    assert calls[3] == "lease"


def test_shared_lifecycle_record_composes_in_both_providers():
    auth = AuthOptions(refresh_buffer_seconds=-5)
    provider = ProviderOptions(
        provider="example",
        client_id="client",
        token_endpoint="https://example.invalid/token",
        auth=auth,
    )
    databricks = DatabricksAuthOptions(auth=auth)
    assert provider.auth is auth
    assert databricks.auth is auth
    assert auth.lock_timeout_seconds == 30
    assert auth.login_timeout_seconds == 3600
    assert AuthOptions().refresh_buffer_seconds == 300
    assert DatabricksAuthOptions().auth is None
