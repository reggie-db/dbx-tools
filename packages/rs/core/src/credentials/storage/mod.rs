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
/// Built-in credential storage backend.
pub enum Storage {
    /// Select file storage.
    #[default]
    Auto,
    /// Keep credentials in process memory.
    Memory,
    /// Persist credentials in the configured directory.
    File,
}

/// Compatibility name for the built-in storage selection.
pub type StoreBackend = Storage;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, uniffi::Enum)]
/// File organization used by the persistent credential store.
pub enum FileLayout {
    /// Store all credentials in one token cache.
    #[default]
    Single,
    /// Store each credential in an independent hashed directory.
    PerCredential,
}

/// Open a built-in credential store.
///
/// Automatic storage resolves to file storage. File initialization fails when
/// the directory cannot be created or, on Unix, assigned owner-only permissions.
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
