use crate::{CredentialStore, Error, Result, StorageLock, Token};
use std::{sync::Arc, time::Duration};

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
pub struct StorageHandle {
    pub store: Arc<dyn CredentialStore>,
}

#[uniffi::export]
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
