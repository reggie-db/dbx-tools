use crate::{Error, Result};
pub use dbx_tools_auth::{CredentialStore, FileStore, MemoryStore, StorageLock, StoreBackend};
use directories::UserDirs;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Debug, Default)]
pub struct StoreOptions {
    pub backend: Option<StoreBackend>,
    pub cache_dir: Option<PathBuf>,
}

pub async fn open_store(options: StoreOptions) -> Result<Arc<dyn CredentialStore>> {
    let directory = match options.cache_dir {
        Some(directory) => directory,
        None => default_cache_dir()?,
    };
    let backend = options.backend.unwrap_or_default();
    dbx_tools_auth::open_store(backend, directory, dbx_tools_auth::FileLayout::Single).await
}

fn default_cache_dir() -> Result<PathBuf> {
    UserDirs::new()
        .map(|dirs| dirs.home_dir().join(".databricks"))
        .ok_or_else(|| Error::Config("could not resolve the user home directory".into()))
}
