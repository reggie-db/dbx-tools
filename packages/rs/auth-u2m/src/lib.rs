mod client;
mod error;
mod oauth;
mod oauth_template;
mod profile;
mod storage;
mod token;

pub use client::{AuthClient, AuthOptions};
pub use error::{Error, Result};
pub use oauth::OAuthFlow;
pub use oauth_template::{default_callback_image_src, OAuthTemplate, OAuthTemplateContext};
pub use profile::{
    resolve_config_file, Profile, ProfileOptions, TargetKind, DEFAULT_ACCOUNTS_HOST,
    DEFAULT_CLIENT_ID, DEFAULT_CONFIG_FILE,
};
use std::{path::PathBuf, sync::Arc, time::Duration};
#[cfg(feature = "keyring")]
pub use storage::KeyringStore;
pub use storage::{
    open_store, CredentialStore, FileStore, MemoryStore, StorageLock, StoreBackend, StoreOptions,
};
pub use token::Token;

use time::Duration as TimeDuration;

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait StorageAdapter: Send + Sync {
    async fn load(&self, profile: String) -> BindingResult<Option<String>>;
    async fn prepare_write(&self) -> BindingResult<()>;
    async fn save(&self, profile: String, token: String) -> BindingResult<()>;
    async fn remove(&self, profile: String) -> BindingResult<()>;
    async fn acquire_lock(&self, profile: String, timeout_millis: u64) -> BindingResult<String>;
    async fn release_lock(&self, lease: String) -> BindingResult<()>;
    fn name(&self) -> String;
}

#[derive(Clone, Default, uniffi::Record)]
pub struct U2mOptions {
    #[uniffi(default = None)]
    pub profile: Option<String>,
    #[uniffi(default = None)]
    pub host: Option<String>,
    #[uniffi(default = None)]
    pub account_id: Option<String>,
    #[uniffi(default = None)]
    pub workspace_id: Option<String>,
    #[uniffi(default = None)]
    pub config_file: Option<String>,
    #[uniffi(default = None)]
    pub client_id: Option<String>,
    #[uniffi(default = None)]
    pub scopes: Option<Vec<String>>,
    #[uniffi(default = None)]
    pub target: Option<String>,
    #[uniffi(default = None)]
    pub cache_dir: Option<String>,
    /// Logo URL or data URI displayed by the browser callback page.
    #[uniffi(default = None)]
    pub callback_image_src: Option<String>,
    #[uniffi(default = 30)]
    pub lock_timeout_seconds: u64,
    #[uniffi(default = 3600)]
    pub login_timeout_seconds: u64,
    #[uniffi(default = 300)]
    pub refresh_buffer_seconds: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Storage {
    Auto,
    Memory,
    File,
    Keyring,
}

#[derive(Clone, uniffi::Record)]
pub struct AccessToken {
    pub access_token: String,
    pub token_type: String,
    pub expiry: Option<String>,
    pub scopes: Vec<String>,
}

#[derive(Clone, uniffi::Record)]
pub struct U2mStatus {
    pub profile: String,
    pub host: String,
    pub storage: Storage,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum U2mError {
    #[error("{message}")]
    Failure { message: String },
}

impl From<uniffi::UnexpectedUniFFICallbackError> for U2mError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Failure {
            message: error.to_string(),
        }
    }
}

type BindingResult<T> = std::result::Result<T, U2mError>;

#[derive(uniffi::Object)]
pub struct PersistentAuth {
    inner: AuthClient,
}

#[uniffi::export(async_runtime = "tokio", default(storage = None))]
pub async fn create_persistent_auth(
    options: U2mOptions,
    storage: Option<Storage>,
) -> BindingResult<Arc<PersistentAuth>> {
    let store = open_binding_store(&options, storage).await?;
    create_persistent_auth_with_store(options, store).await
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn create_persistent_auth_with_storage(
    options: U2mOptions,
    storage: Arc<dyn StorageAdapter>,
) -> BindingResult<Arc<PersistentAuth>> {
    create_persistent_auth_with_store(options, Arc::new(ForeignStore { storage })).await
}

async fn create_persistent_auth_with_store(
    options: U2mOptions,
    store: Arc<dyn CredentialStore>,
) -> BindingResult<Arc<PersistentAuth>> {
    let profile = Profile::from_sources(ProfileOptions {
        profile: options.profile.clone(),
        host: options.host.clone(),
        account_id: options.account_id.clone(),
        workspace_id: options.workspace_id.clone(),
        client_id: options.client_id.clone(),
        scopes: options.scopes.clone(),
        target: options.target.as_deref().map(parse_target).transpose()?,
        config_file: options.config_file.as_deref().map(PathBuf::from),
    })
    .map_err(binding_error)?;
    let inner = AuthClient::new(
        profile,
        store,
        AuthOptions {
            refresh_buffer: TimeDuration::seconds(options.refresh_buffer_seconds),
            lock_timeout: Duration::from_secs(options.lock_timeout_seconds),
            login_timeout: Duration::from_secs(options.login_timeout_seconds),
            callback_image_src: options.callback_image_src.clone(),
        },
    )
    .map_err(binding_error)?;
    Ok(Arc::new(PersistentAuth { inner }))
}

struct ForeignStore {
    storage: Arc<dyn StorageAdapter>,
}

struct ForeignLock {
    storage: Arc<dyn StorageAdapter>,
    lease: String,
}

#[async_trait::async_trait]
impl StorageLock for ForeignLock {
    async fn release(self: Box<Self>) -> Result<()> {
        self.storage
            .release_lock(self.lease)
            .await
            .map_err(|error| Error::Storage(error.to_string()))
    }
}

#[async_trait::async_trait]
impl CredentialStore for ForeignStore {
    async fn load(&self, profile: &str) -> Result<Option<Token>> {
        self.storage
            .load(profile.to_owned())
            .await
            .map_err(|error| Error::Storage(error.to_string()))?
            .map(|token| serde_json::from_str(&token).map_err(Into::into))
            .transpose()
    }

    async fn prepare_write(&self) -> Result<()> {
        self.storage
            .prepare_write()
            .await
            .map_err(|error| Error::Storage(error.to_string()))
    }

    async fn save(&self, profile: &str, token: &Token) -> Result<()> {
        self.storage
            .save(profile.to_owned(), serde_json::to_string(token)?)
            .await
            .map_err(|error| Error::Storage(error.to_string()))
    }

    async fn delete(&self, profile: &str) -> Result<()> {
        self.storage
            .remove(profile.to_owned())
            .await
            .map_err(|error| Error::Storage(error.to_string()))
    }

    async fn lock(&self, profile: &str, timeout: Duration) -> Result<Box<dyn StorageLock>> {
        let timeout_millis = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
        let lease = self
            .storage
            .acquire_lock(profile.to_owned(), timeout_millis)
            .await
            .map_err(|error| Error::Storage(error.to_string()))?;
        Ok(Box::new(ForeignLock {
            storage: Arc::clone(&self.storage),
            lease,
        }))
    }

    fn name(&self) -> &'static str {
        "custom"
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl PersistentAuth {
    pub async fn challenge(&self) -> BindingResult<()> {
        self.inner.login().await.map(|_| ()).map_err(binding_error)
    }

    #[uniffi::method(default(login = None))]
    pub async fn token(&self, login: Option<bool>) -> BindingResult<AccessToken> {
        let token = match login {
            Some(true) => self.inner.login().await,
            None => self.inner.token_or_login().await,
            Some(false) => self.inner.token().await,
        };
        token.map(Into::into).map_err(binding_error)
    }

    pub async fn force_refresh_token(&self) -> BindingResult<AccessToken> {
        self.inner
            .force_refresh()
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    pub async fn logout(&self) -> BindingResult<()> {
        self.inner.logout().await.map_err(binding_error)
    }

    pub fn status(&self) -> U2mStatus {
        U2mStatus {
            profile: self.inner.profile().name.clone(),
            host: self.inner.profile().host.to_string(),
            storage: storage_from_name(self.inner.store_name()),
        }
    }
}

impl From<Token> for AccessToken {
    fn from(token: Token) -> Self {
        Self {
            access_token: token.access_token,
            token_type: token.token_type,
            expiry: token.expires_at.map(|value| value.to_string()),
            scopes: token.scopes,
        }
    }
}

async fn open_binding_store(
    options: &U2mOptions,
    storage: Option<Storage>,
) -> BindingResult<Arc<dyn CredentialStore>> {
    open_store(StoreOptions {
        backend: storage.map(Into::into),
        cache_dir: options.cache_dir.as_deref().map(PathBuf::from),
        config_file: options.config_file.as_deref().map(PathBuf::from),
    })
    .await
    .map_err(binding_error)
}

fn parse_target(value: &str) -> BindingResult<TargetKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "workspace" => Ok(TargetKind::Workspace),
        "account" => Ok(TargetKind::Account),
        "unified" => Ok(TargetKind::Unified),
        _ => Err(U2mError::Failure {
            message: "target must be workspace, account, or unified".into(),
        }),
    }
}

impl From<Storage> for StoreBackend {
    fn from(storage: Storage) -> Self {
        match storage {
            Storage::Auto => Self::Auto,
            Storage::Memory => Self::Memory,
            Storage::File => Self::File,
            Storage::Keyring => Self::Keyring,
        }
    }
}

fn storage_from_name(name: &str) -> Storage {
    match name {
        "memory" => Storage::Memory,
        "keyring" => Storage::Keyring,
        _ => Storage::File,
    }
}

fn binding_error(error: impl std::fmt::Display) -> U2mError {
    U2mError::Failure {
        message: error.to_string(),
    }
}

uniffi::setup_scaffolding!();
