use crate::{CredentialStore, Error, Result, StorageLock, Token};
use std::{sync::Arc, time::Duration};

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
/// Foreign-language persistence contract; implement every method in Node or Python.
///
/// UniFFI callback interfaces do not inherit Rust default method bodies. A store
/// must explicitly implement locking and may implement `prepare_write` as a no-op
/// when writes need no preflight. Credential JSON can contain refresh tokens.
pub trait StorageAdapter: Send + Sync {
    /// Load credential JSON, returning None when the key does not exist.
    async fn load(&self, profile: String) -> BindingResult<Option<String>>;
    /// Check write readiness before a provider rotates a refresh token.
    async fn prepare_write(&self) -> BindingResult<()>;
    /// Persist credential JSON without discarding unrelated keys.
    async fn save(&self, profile: String, token: String) -> BindingResult<()>;
    /// Delete only the specified credential.
    async fn remove(&self, profile: String) -> BindingResult<()>;
    /// Acquire an exclusive refresh lease or fail within the timeout.
    async fn acquire_lock(&self, profile: String, timeout_millis: u64) -> BindingResult<String>;
    /// Release the lease returned by `acquire_lock`.
    async fn release_lock(&self, lease: String) -> BindingResult<()>;
    /// Return a human-readable backend identifier.
    fn name(&self) -> String;
}

/// Public credential result; deliberately excludes the refresh token.
#[derive(Clone, uniffi::Record)]
pub struct AccessToken {
    pub access_token: String,
    pub token_type: String,
    pub expiry: Option<String>,
    pub scopes: Vec<String>,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum AuthError {
    #[error("{message}")]
    Failure { message: String },
}

impl From<uniffi::UnexpectedUniFFICallbackError> for AuthError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Failure {
            message: error.to_string(),
        }
    }
}

pub type BindingResult<T> = std::result::Result<T, AuthError>;

pub struct ForeignStore {
    pub storage: Arc<dyn StorageAdapter>,
}

#[derive(uniffi::Object)]
/// Keeps storage callbacks in the native library that owns their converters.
pub struct StorageHandle {
    pub store: Arc<dyn CredentialStore>,
}

#[uniffi::export]
/// Wrap custom storage before passing it into another provider's native library.
pub fn create_storage_handle(storage: Arc<dyn StorageAdapter>) -> Arc<StorageHandle> {
    Arc::new(StorageHandle {
        store: Arc::new(ForeignStore { storage }),
    })
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
