mod client;
mod databricks_cli;
mod m2m;
mod oauth;
mod oauth_endpoints;
mod profile;
mod storage;

pub use client::{AuthClient, AuthOptions};
pub use databricks_cli::databricks_cli_available;
pub use dbx_tools_auth::AuthSession;
pub use dbx_tools_auth::{default_callback_image_src, OAuthTemplate, OAuthTemplateContext};
pub use dbx_tools_auth::{
    AccessToken, AuthError as DatabricksAuthError, Storage, StorageAdapter, Token,
};
use dbx_tools_auth::{BindingResult, StorageHandle};
pub use dbx_tools_auth::{Error, Result};
pub use m2m::MachineToMachineFlow;
pub use oauth::OAuthFlow;
pub use profile::{
    resolve_config_file, AuthKind, Profile, ProfileOptions, TargetKind, DEFAULT_ACCOUNTS_HOST,
    DEFAULT_CLIENT_ID, DEFAULT_CONFIG_FILE,
};
use std::{path::PathBuf, sync::Arc};
pub use storage::{
    open_store, CredentialStore, FileStore, MemoryStore, StorageLock, StoreBackend, StoreOptions,
};

/// Configuration shared by the generated Node and Python auth bindings.
#[derive(Clone, uniffi::Record)]
pub struct DatabricksAuthOptions {
    /// Explicit profile name; explicit choices are never remapped to another profile.
    #[uniffi(default = None)]
    pub profile: Option<String>,
    /// Override the workspace or account host.
    #[uniffi(default = None)]
    pub host: Option<String>,
    /// Account identifier for account-scoped authentication.
    #[uniffi(default = None)]
    pub account_id: Option<String>,
    /// Workspace identifier for unified authentication.
    #[uniffi(default = None)]
    pub workspace_id: Option<String>,
    /// Override the Databricks CLI configuration file.
    #[uniffi(default = None)]
    pub config_file: Option<String>,
    /// Override the OAuth application identifier.
    #[uniffi(default = None)]
    pub client_id: Option<String>,
    /// Optional group role requested by M2M token generation.
    #[uniffi(default = None)]
    pub group_id: Option<String>,
    /// Explicit Databricks authentication strategy.
    #[uniffi(default = None)]
    pub auth_type: Option<String>,
    /// Override profile scopes; omission preserves profile/default scope resolution.
    #[uniffi(default = None)]
    pub scopes: Option<Vec<String>>,
    /// Target kind: workspace, account, or unified.
    #[uniffi(default = None)]
    pub target: Option<String>,
    /// Override the directory containing the shared CLI token cache.
    #[uniffi(default = None)]
    pub cache_dir: Option<String>,
    /// Shared lifecycle configuration; omission uses `AuthOptions::default()`.
    #[uniffi(default = None)]
    pub auth: Option<AuthOptions>,
    /// Whether implicit M2M defaults should select one matching U2M profile.
    #[uniffi(default = true)]
    pub prefer_user_to_machine: bool,
}

impl Default for DatabricksAuthOptions {
    fn default() -> Self {
        Self {
            profile: None,
            host: None,
            account_id: None,
            workspace_id: None,
            config_file: None,
            client_id: None,
            group_id: None,
            auth_type: None,
            scopes: None,
            target: None,
            cache_dir: None,
            auth: None,
            prefer_user_to_machine: true,
        }
    }
}

#[derive(Clone, uniffi::Record)]
/// Resolved Databricks identity and active storage backend.
pub struct DatabricksAuthStatus {
    pub profile: String,
    pub host: String,
    pub storage: Storage,
}

#[derive(uniffi::Object)]
/// Databricks binding facade over the shared persistent authentication lifecycle.
pub struct PersistentAuth {
    inner: AuthClient,
}

#[uniffi::export(async_runtime = "tokio", default(storage = None))]
/// Resolve a Databricks profile and open built-in credential storage.
pub async fn create_persistent_auth(
    options: DatabricksAuthOptions,
    storage: Option<Storage>,
) -> BindingResult<Arc<PersistentAuth>> {
    let profile = resolve_profile(&options)?;
    let use_databricks_cli =
        should_use_databricks_cli(profile.auth_kind, storage, databricks_cli_available());
    let backend = storage_backend(storage);
    let store = open_binding_store(&options, backend).await?;
    create_persistent_auth_with_store(options, profile, store, use_databricks_cli).await
}

#[uniffi::export(async_runtime = "tokio")]
/// Resolve a Databricks profile using a shared owning-library storage handle.
pub async fn create_persistent_auth_with_storage(
    options: DatabricksAuthOptions,
    storage: Arc<StorageHandle>,
) -> BindingResult<Arc<PersistentAuth>> {
    let profile = resolve_profile(&options)?;
    create_persistent_auth_with_store(options, profile, storage.store.clone(), false).await
}

async fn create_persistent_auth_with_store(
    options: DatabricksAuthOptions,
    profile: Profile,
    store: Arc<dyn CredentialStore>,
    use_databricks_cli: bool,
) -> BindingResult<Arc<PersistentAuth>> {
    let inner = AuthClient::new(
        profile,
        store,
        options.auth.unwrap_or_default(),
        use_databricks_cli,
    )
    .map_err(binding_error)?;
    Ok(Arc::new(PersistentAuth { inner }))
}

fn should_use_databricks_cli(
    auth_kind: AuthKind,
    storage: Option<Storage>,
    available: bool,
) -> bool {
    auth_kind == AuthKind::UserToMachine
        && available
        && storage.is_none_or(|storage| storage == Storage::Auto)
}

fn storage_backend(storage: Option<Storage>) -> Storage {
    match storage {
        Some(Storage::Memory) => Storage::Memory,
        Some(Storage::File) | Some(Storage::Auto) | None => Storage::File,
    }
}

fn resolve_profile(options: &DatabricksAuthOptions) -> BindingResult<Profile> {
    Profile::from_sources(ProfileOptions {
        profile: options.profile.clone(),
        host: options.host.clone(),
        account_id: options.account_id.clone(),
        workspace_id: options.workspace_id.clone(),
        client_id: options.client_id.clone(),
        client_secret: None,
        group_id: options.group_id.clone(),
        auth_type: options.auth_type.clone(),
        scopes: options.scopes.clone(),
        target: options.target.as_deref().map(parse_target).transpose()?,
        config_file: options.config_file.as_deref().map(PathBuf::from),
        prefer_user_to_machine: options.prefer_user_to_machine,
    })
    .map_err(binding_error)
}

#[uniffi::export(async_runtime = "tokio")]
impl PersistentAuth {
    /// Start an explicit login and persist the resulting credential.
    pub async fn challenge(&self) -> BindingResult<()> {
        self.inner.login().await.map(|_| ()).map_err(binding_error)
    }

    /// True forces login, false forbids interactive login, and omission permits missing-token login.
    #[uniffi::method(default(login = None))]
    pub async fn token(&self, login: Option<bool>) -> BindingResult<AccessToken> {
        self.inner
            .token_with_login(login)
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    /// Renew the stored credential even before its refresh window.
    pub async fn force_refresh_token(&self) -> BindingResult<AccessToken> {
        self.inner
            .force_refresh()
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    /// Reuse another caller's replacement or renew the rejected token.
    pub async fn refresh_rejected_token(
        &self,
        stale_access_token: String,
    ) -> BindingResult<AccessToken> {
        self.inner
            .refresh_rejected_token(&stale_access_token)
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    /// Delete the credential while holding the store's refresh lock.
    pub async fn logout(&self) -> BindingResult<()> {
        self.inner.logout().await.map_err(binding_error)
    }

    /// Return the resolved identity and active built-in storage backend.
    pub fn status(&self) -> DatabricksAuthStatus {
        DatabricksAuthStatus {
            profile: self.inner.profile().name.clone(),
            host: self.inner.profile().host.to_string(),
            storage: storage_from_name(self.inner.store_name()),
        }
    }
}

async fn open_binding_store(
    options: &DatabricksAuthOptions,
    storage: Storage,
) -> BindingResult<Arc<dyn CredentialStore>> {
    open_store(StoreOptions {
        backend: Some(storage),
        cache_dir: options.cache_dir.as_deref().map(PathBuf::from),
    })
    .await
    .map_err(binding_error)
}

fn parse_target(value: &str) -> BindingResult<TargetKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "workspace" => Ok(TargetKind::Workspace),
        "account" => Ok(TargetKind::Account),
        "unified" => Ok(TargetKind::Unified),
        _ => Err(DatabricksAuthError::Failure {
            message: "target must be workspace, account, or unified".into(),
        }),
    }
}

fn storage_from_name(name: &str) -> Storage {
    match name {
        "memory" => Storage::Memory,
        _ => Storage::File,
    }
}

fn binding_error(error: impl std::fmt::Display) -> DatabricksAuthError {
    DatabricksAuthError::Failure {
        message: error.to_string(),
    }
}

uniffi::setup_scaffolding!();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_refresh_requires_available_automatic_u2m() {
        assert!(should_use_databricks_cli(
            AuthKind::UserToMachine,
            None,
            true
        ));
        assert!(should_use_databricks_cli(
            AuthKind::UserToMachine,
            Some(Storage::Auto),
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::UserToMachine,
            Some(Storage::File),
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::UserToMachine,
            Some(Storage::Memory),
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::MachineToMachine,
            None,
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::UserToMachine,
            None,
            false
        ));
    }

    #[test]
    fn automatic_storage_is_file_and_memory_stays_memory() {
        assert_eq!(storage_backend(None), Storage::File);
        assert_eq!(storage_backend(Some(Storage::Auto)), Storage::File);
        assert_eq!(storage_backend(Some(Storage::File)), Storage::File);
        assert_eq!(storage_backend(Some(Storage::Memory)), Storage::Memory);
    }
}
