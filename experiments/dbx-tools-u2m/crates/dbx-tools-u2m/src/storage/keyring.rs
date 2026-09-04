use std::{path::PathBuf, time::Duration};

use async_trait::async_trait;
use keyring::Entry;

use super::{CredentialStore, FileStore, StorageLock};
use crate::{Error, Result, Token};

const SERVICE: &str = "databricks-cli";

#[derive(serde::Serialize, serde::Deserialize)]
struct KeyringEntry {
    token: Token,
}

pub struct KeyringStore {
    lock_store: FileStore,
}

impl KeyringStore {
    pub async fn probe(cache_dir: PathBuf) -> Result<Self> {
        let store = Self {
            lock_store: FileStore::new(cache_dir.join("locks"))?,
        };
        let account = format!("probe-{}", uuid::Uuid::new_v4());
        tokio::task::spawn_blocking(move || {
            let entry = Entry::new(SERVICE, &account).map_err(keyring_error)?;
            entry.set_password("probe").map_err(keyring_error)?;
            entry.delete_credential().map_err(keyring_error)?;
            Ok::<_, Error>(())
        })
        .await
        .map_err(|error| Error::Storage(format!("keyring probe task failed: {error}")))??;
        Ok(store)
    }

    fn entry(profile: &str) -> Result<Entry> {
        Entry::new(SERVICE, profile).map_err(keyring_error)
    }
}

#[async_trait]
impl CredentialStore for KeyringStore {
    async fn load(&self, profile: &str) -> Result<Option<Token>> {
        let profile = profile.to_owned();
        tokio::task::spawn_blocking(move || match Self::entry(&profile)?.get_password() {
            Ok(raw) => Ok(Some(serde_json::from_str::<KeyringEntry>(&raw)?.token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keyring_error(error)),
        })
        .await
        .map_err(|error| Error::Storage(format!("keyring read task failed: {error}")))?
    }

    async fn save(&self, profile: &str, token: &Token) -> Result<()> {
        let profile = profile.to_owned();
        let raw = serde_json::to_string(&KeyringEntry {
            token: token.clone(),
        })?;
        tokio::task::spawn_blocking(move || {
            Self::entry(&profile)?
                .set_password(&raw)
                .map_err(keyring_error)
        })
        .await
        .map_err(|error| Error::Storage(format!("keyring write task failed: {error}")))?
    }

    async fn delete(&self, profile: &str) -> Result<()> {
        let profile = profile.to_owned();
        tokio::task::spawn_blocking(move || match Self::entry(&profile)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keyring_error(error)),
        })
        .await
        .map_err(|error| Error::Storage(format!("keyring delete task failed: {error}")))?
    }

    async fn lock(&self, profile: &str, timeout: Duration) -> Result<Box<dyn StorageLock>> {
        Ok(Box::new(
            self.lock_store.acquire_file_lock(profile, timeout).await?,
        ))
    }

    fn name(&self) -> &'static str {
        "keyring"
    }
}

fn keyring_error(error: keyring::Error) -> Error {
    Error::Storage(format!("OS keyring: {error}"))
}
