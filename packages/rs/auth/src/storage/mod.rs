mod file;
#[cfg(feature = "keyring")]
mod keyring;
mod memory;

#[cfg(not(feature = "keyring"))]
use crate::Error;
use crate::{Result, Token};
use async_trait::async_trait;
use std::{path::PathBuf, sync::Arc, time::Duration};

pub use file::FileStore;
#[cfg(feature = "keyring")]
pub use keyring::KeyringStore;
pub use memory::MemoryStore;

#[async_trait]
pub trait StorageLock: Send + Sync {
    async fn release(self: Box<Self>) -> Result<()> {
        Ok(())
    }
}

#[async_trait]
pub trait CredentialStore: Send + Sync {
    async fn load(&self, key: &str) -> Result<Option<Token>>;
    async fn prepare_write(&self) -> Result<()> {
        Ok(())
    }
    async fn save(&self, key: &str, token: &Token) -> Result<()>;
    async fn delete(&self, key: &str) -> Result<()>;
    async fn lock(&self, key: &str, timeout: Duration) -> Result<Box<dyn StorageLock>>;
    fn name(&self) -> &'static str;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, uniffi::Enum)]
pub enum Storage {
    #[default]
    Auto,
    Memory,
    File,
    Keyring,
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
    service: String,
    layout: FileLayout,
) -> Result<Arc<dyn CredentialStore>> {
    match backend {
        Storage::Memory => Ok(Arc::new(MemoryStore::new(directory.join("memory-locks"))?)),
        Storage::File => Ok(Arc::new(FileStore::with_layout(directory, layout)?)),
        Storage::Auto | Storage::Keyring => {
            #[cfg(feature = "keyring")]
            match KeyringStore::open_for_service(directory.clone(), service).await {
                Ok(store) => return Ok(Arc::new(store)),
                Err(error) if backend == Storage::Keyring => return Err(error),
                Err(_) => (),
            }
            #[cfg(not(feature = "keyring"))]
            {
                let _ = service;
                if backend == Storage::Keyring {
                    return Err(Error::Config("keyring support was not compiled in".into()));
                }
            }
            Ok(Arc::new(FileStore::with_layout(directory, layout)?))
        }
    }
}
