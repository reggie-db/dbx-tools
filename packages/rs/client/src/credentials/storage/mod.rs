mod file;
mod memory;

use crate::{Result, Token};
use async_trait::async_trait;
use std::{path::PathBuf, sync::Arc, time::Duration};

pub use file::FileStore;
pub use memory::MemoryStore;

#[async_trait]
/// Exclusive refresh lease; RAII locks can use the default consuming release.
pub trait StorageLock: Send + Sync {
    /// Release explicitly; dropping the consumed lock also releases RAII resources.
    async fn release(self: Box<Self>) -> Result<()> {
        Ok(())
    }
}

#[async_trait]
/// Credential persistence with exclusive refresh coordination.
pub trait CredentialStore: Send + Sync {
    /// Load the credential for exactly one key.
    async fn load(&self, key: &str) -> Result<Option<Token>>;
    /// Preflight writes before token rotation; stores needing no probe inherit the no-op.
    async fn prepare_write(&self) -> Result<()> {
        Ok(())
    }
    /// Persist a credential while preserving unrelated keys.
    async fn save(&self, key: &str, token: &Token) -> Result<()>;
    /// Delete a credential, succeeding if it is already absent.
    async fn delete(&self, key: &str) -> Result<()>;
    /// Acquire an exclusive refresh lease or fail within the timeout.
    async fn lock(&self, key: &str, timeout: Duration) -> Result<Box<dyn StorageLock>>;
    /// Return the backend identifier used by session status.
    fn name(&self) -> &'static str;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, uniffi::Enum)]
pub enum Storage {
    #[default]
    Auto,
    Memory,
    File,
}

pub type StoreBackend = Storage;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, uniffi::Enum)]
pub enum FileLayout {
    #[default]
    Single,
    PerCredential,
}

pub async fn open_store(
    backend: Storage,
    directory: PathBuf,
    layout: FileLayout,
) -> Result<Arc<dyn CredentialStore>> {
    match backend {
        Storage::Memory => Ok(Arc::new(MemoryStore::new())),
        Storage::Auto | Storage::File => Ok(Arc::new(FileStore::with_layout(directory, layout)?)),
    }
}
