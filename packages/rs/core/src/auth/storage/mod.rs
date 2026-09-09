use crate::{CredentialStore, Error, FileLayout, Result, StoreBackend};
use directories::UserDirs;
use std::{path::PathBuf, sync::Arc};

/// Options for the Databricks credential store.
#[derive(Clone, Debug, Default)]
pub struct StoreOptions {
    /// Storage backend, defaulting to automatic file storage.
    pub backend: Option<StoreBackend>,
    /// Directory containing the shared token cache.
    pub cache_dir: Option<PathBuf>,
}

/// Open a memory or shared-file credential store for Databricks authentication.
pub async fn open_databricks_store(options: StoreOptions) -> Result<Arc<dyn CredentialStore>> {
    let directory = match options.cache_dir {
        Some(directory) => directory,
        None => default_cache_dir()?,
    };
    let backend = options.backend.unwrap_or_default();
    crate::open_store(backend, directory, FileLayout::Single).await
}

fn default_cache_dir() -> Result<PathBuf> {
    UserDirs::new()
        .map(|dirs| dirs.home_dir().join(".databricks"))
        .ok_or_else(|| Error::Config("could not resolve the user home directory".into()))
}
