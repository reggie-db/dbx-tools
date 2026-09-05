use crate::{profile::configured_auth_storage, resolve_config_file, Error, Result};
#[cfg(feature = "keyring")]
pub use dbx_tools_auth::KeyringStore;
pub use dbx_tools_auth::{CredentialStore, FileStore, MemoryStore, StorageLock, StoreBackend};
use directories::UserDirs;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Debug, Default)]
pub struct StoreOptions {
    pub backend: Option<StoreBackend>,
    pub cache_dir: Option<PathBuf>,
    pub config_file: Option<PathBuf>,
}

pub async fn open_store(options: StoreOptions) -> Result<Arc<dyn CredentialStore>> {
    let directory = match options.cache_dir {
        Some(directory) => directory,
        None => default_cache_dir()?,
    };
    let backend = resolve_backend(options.backend, options.config_file.as_deref())?;
    dbx_tools_auth::open_store(
        backend,
        directory,
        "databricks-cli".into(),
        dbx_tools_auth::FileLayout::Single,
    )
    .await
}

fn default_cache_dir() -> Result<PathBuf> {
    UserDirs::new()
        .map(|dirs| dirs.home_dir().join(".databricks"))
        .ok_or_else(|| Error::Config("could not resolve the user home directory".into()))
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
