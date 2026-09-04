mod file;
mod memory;

#[cfg(feature = "keyring")]
mod keyring;

use std::{path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use directories::UserDirs;

use crate::{profile::configured_auth_storage, resolve_config_file, Error, Result, Token};

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
    async fn load(&self, profile: &str) -> Result<Option<Token>>;
    async fn prepare_write(&self) -> Result<()> {
        Ok(())
    }
    async fn save(&self, profile: &str, token: &Token) -> Result<()>;
    async fn delete(&self, profile: &str) -> Result<()>;
    async fn lock(&self, profile: &str, timeout: Duration) -> Result<Box<dyn StorageLock>>;
    fn name(&self) -> &'static str;
}

#[derive(Clone, Debug, Default)]
pub struct StoreOptions {
    pub backend: Option<StoreBackend>,
    pub cache_dir: Option<PathBuf>,
    pub config_file: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StoreBackend {
    #[default]
    Auto,
    Memory,
    File,
    Keyring,
}

pub async fn open_store(options: StoreOptions) -> Result<Arc<dyn CredentialStore>> {
    let cache_dir = options.cache_dir.unwrap_or_else(default_cache_dir);
    let backend = resolve_backend(options.backend, options.config_file.as_deref())?;
    match backend {
        StoreBackend::Memory => Ok(Arc::new(MemoryStore::new(cache_dir.join("memory-locks"))?)),
        StoreBackend::File => Ok(Arc::new(FileStore::new(cache_dir)?)),
        StoreBackend::Keyring => open_keyring_for_read(cache_dir).await,
        StoreBackend::Auto => {
            #[cfg(feature = "keyring")]
            {
                if let Ok(store) = KeyringStore::open_for_read(cache_dir.clone()).await {
                    return Ok(Arc::new(store));
                }
            }
            Ok(Arc::new(FileStore::new(cache_dir)?))
        }
    }
}

fn default_cache_dir() -> PathBuf {
    UserDirs::new()
        .map(|dirs| dirs.home_dir().join(".databricks"))
        .unwrap_or_else(|| PathBuf::from(".dbx-tools-auth-u2m"))
}

fn resolve_backend(
    explicit: Option<StoreBackend>,
    config_file: Option<&std::path::Path>,
) -> Result<StoreBackend> {
    if let Some(backend) = explicit.filter(|backend| *backend != StoreBackend::Auto) {
        return Ok(backend);
    }
    if let Ok(value) = std::env::var("DATABRICKS_AUTH_STORAGE") {
        if !value.trim().is_empty() {
            return parse_databricks_storage(&value, "DATABRICKS_AUTH_STORAGE");
        }
    }
    let path = resolve_config_file(config_file)?;
    if let Some(value) = configured_auth_storage(&path)? {
        return parse_databricks_storage(&value, "auth_storage");
    }
    Ok(StoreBackend::Auto)
}

fn parse_databricks_storage(value: &str, source: &str) -> Result<StoreBackend> {
    match value.trim().to_ascii_lowercase().as_str() {
        "secure" => Ok(StoreBackend::Keyring),
        "plaintext" => Ok(StoreBackend::File),
        value => Err(Error::Config(format!(
            "{source}: unknown storage mode {value:?} (want plaintext or secure)"
        ))),
    }
}

async fn open_keyring_for_read(cache_dir: PathBuf) -> Result<Arc<dyn CredentialStore>> {
    #[cfg(feature = "keyring")]
    {
        Ok(Arc::new(KeyringStore::open_for_read(cache_dir).await?))
    }
    #[cfg(not(feature = "keyring"))]
    {
        let _ = cache_dir;
        Err(crate::Error::Config(
            "keyring support was not compiled in".into(),
        ))
    }
}
