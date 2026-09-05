use std::{path::PathBuf, time::Duration};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::Entry;

use super::{CredentialStore, FileStore, StorageLock};
use crate::{Error, Result, Token};

const PROBE_ACCOUNT_PREFIX: &str = "__probe_";
const GO_KEYRING_BASE64_PREFIX: &str = "go-keyring-base64:";
const GO_KEYRING_HEX_PREFIX: &str = "go-keyring-encoded:";

#[derive(serde::Serialize, serde::Deserialize)]
struct KeyringEntry {
    token: Token,
}

pub struct KeyringStore {
    lock_store: FileStore,
    service: String,
}

impl KeyringStore {
    fn new(cache_dir: PathBuf, service: String) -> Result<Self> {
        Ok(Self {
            lock_store: FileStore::new(cache_dir.join("locks"))?,
            service,
        })
    }

    pub async fn open_for_service(cache_dir: PathBuf, service: String) -> Result<Self> {
        let store = Self::new(cache_dir, service.clone())?;
        let account = format!("{PROBE_ACCOUNT_PREFIX}{}", uuid::Uuid::new_v4());
        tokio::task::spawn_blocking(move || {
            match Self::entry(&service, &account)?.get_password() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(keyring_error(error)),
            }
        })
        .await
        .map_err(|error| Error::Storage(format!("keyring read probe task failed: {error}")))??;
        Ok(store)
    }

    async fn prepare_write_probe(&self) -> Result<()> {
        let service = self.service.clone();
        let account = format!("{PROBE_ACCOUNT_PREFIX}{}", uuid::Uuid::new_v4());
        tokio::task::spawn_blocking(move || {
            let entry = Entry::new(&service, &account).map_err(keyring_error)?;
            entry.set_password("probe").map_err(keyring_error)?;
            entry.delete_credential().map_err(keyring_error)?;
            Ok::<_, Error>(())
        })
        .await
        .map_err(|error| Error::Storage(format!("keyring probe task failed: {error}")))??;
        Ok(())
    }

    fn entry(service: &str, profile: &str) -> Result<Entry> {
        Entry::new(service, profile).map_err(keyring_error)
    }
}

fn decode_keyring_value(raw: &str) -> Result<String> {
    if let Some(value) = raw.strip_prefix(GO_KEYRING_BASE64_PREFIX) {
        return STANDARD
            .decode(value)
            .map_err(|error| Error::Storage(format!("invalid keyring base64: {error}")))
            .and_then(|value| {
                String::from_utf8(value)
                    .map_err(|error| Error::Storage(format!("invalid keyring UTF-8: {error}")))
            });
    }
    if let Some(value) = raw.strip_prefix(GO_KEYRING_HEX_PREFIX) {
        if value.len() % 2 != 0 {
            return Err(Error::Storage("invalid keyring hex: odd length".into()));
        }
        let bytes = (0..value.len())
            .step_by(2)
            .map(|index| {
                u8::from_str_radix(&value[index..index + 2], 16)
                    .map_err(|error| Error::Storage(format!("invalid keyring hex: {error}")))
            })
            .collect::<Result<Vec<_>>>()?;
        return String::from_utf8(bytes)
            .map_err(|error| Error::Storage(format!("invalid keyring UTF-8: {error}")));
    }
    Ok(raw.to_owned())
}

#[async_trait]
impl CredentialStore for KeyringStore {
    async fn load(&self, profile: &str) -> Result<Option<Token>> {
        let service = self.service.clone();
        let profile = profile.to_owned();
        tokio::task::spawn_blocking(
            move || match Self::entry(&service, &profile)?.get_password() {
                Ok(raw) => {
                    let raw = decode_keyring_value(&raw)?;
                    Ok(Some(serde_json::from_str::<KeyringEntry>(&raw)?.token))
                }
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(keyring_error(error)),
            },
        )
        .await
        .map_err(|error| Error::Storage(format!("keyring read task failed: {error}")))?
    }

    async fn prepare_write(&self) -> Result<()> {
        self.prepare_write_probe().await
    }

    async fn save(&self, profile: &str, token: &Token) -> Result<()> {
        let service = self.service.clone();
        let profile = profile.to_owned();
        let raw = serde_json::to_string(&KeyringEntry {
            token: token.clone(),
        })?;
        tokio::task::spawn_blocking(move || {
            Self::entry(&service, &profile)?
                .set_password(&raw)
                .map_err(keyring_error)
        })
        .await
        .map_err(|error| Error::Storage(format!("keyring write task failed: {error}")))?
    }

    async fn delete(&self, profile: &str) -> Result<()> {
        let service = self.service.clone();
        let profile = profile.to_owned();
        tokio::task::spawn_blocking(move || {
            match Self::entry(&service, &profile)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(keyring_error(error)),
            }
        })
        .await
        .map_err(|error| Error::Storage(format!("keyring delete task failed: {error}")))?
    }

    async fn lock(&self, profile: &str, timeout: Duration) -> Result<Box<dyn StorageLock>> {
        Ok(Box::new(
            self.lock_store
                .acquire_file_lock(&format!("{}\0{profile}", self.service), timeout)
                .await?,
        ))
    }

    fn name(&self) -> &'static str {
        "keyring"
    }
}

fn keyring_error(error: keyring::Error) -> Error {
    Error::Storage(format!("OS keyring: {error}"))
}

#[cfg(test)]
mod tests {
    use super::decode_keyring_value;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn decodes_go_keyring_base64_values() {
        let json = r#"{"token":{"access_token":"value"}}"#;
        let encoded = format!("go-keyring-base64:{}", STANDARD.encode(json));
        assert_eq!(decode_keyring_value(&encoded).unwrap(), json);
    }

    #[test]
    fn decodes_go_keyring_hex_values() {
        assert_eq!(
            decode_keyring_value("go-keyring-encoded:7b22746f6b656e223a7b7d7d").unwrap(),
            r#"{"token":{}}"#
        );
    }

    #[test]
    fn leaves_native_keyring_values_unchanged() {
        let json = r#"{"token":{"access_token":"value"}}"#;
        assert_eq!(decode_keyring_value(json).unwrap(), json);
    }
}
