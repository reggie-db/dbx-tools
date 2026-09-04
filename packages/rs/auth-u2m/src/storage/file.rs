use std::{
    collections::HashMap,
    fs::OpenOptions,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::{CredentialStore, StorageLock};
use crate::{Error, Result, Token};

const TOKEN_CACHE_VERSION: u8 = 1;

#[derive(Serialize, Deserialize)]
struct TokenCache {
    version: u8,
    #[serde(default)]
    tokens: HashMap<String, Token>,
}

impl Default for TokenCache {
    fn default() -> Self {
        Self {
            version: TOKEN_CACHE_VERSION,
            tokens: HashMap::new(),
        }
    }
}

pub struct FileStore {
    root: PathBuf,
    token_cache: PathBuf,
}

impl FileStore {
    pub fn new(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root)?;
        set_private_directory(&root)?;
        Ok(Self {
            token_cache: root.join("token-cache.json"),
            root,
        })
    }

    fn lock_path(&self, profile: &str) -> PathBuf {
        self.root
            .join("locks")
            .join(format!("{}.lock", key_hash(profile)))
    }

    fn cache_lock_path(&self) -> PathBuf {
        self.root.join("token-cache.lock")
    }

    pub(crate) async fn acquire_file_lock(
        &self,
        profile: &str,
        timeout: Duration,
    ) -> Result<FileLock> {
        acquire_lock(self.lock_path(profile), profile.to_owned(), timeout).await
    }

    async fn acquire_cache_lock(&self) -> Result<FileLock> {
        acquire_lock(
            self.cache_lock_path(),
            "token-cache.json".to_owned(),
            Duration::from_secs(30),
        )
        .await
    }

    async fn read_cache(&self) -> Result<TokenCache> {
        match tokio::fs::read(&self.token_cache).await {
            Ok(raw) => {
                let cache: TokenCache = serde_json::from_slice(&raw)?;
                if cache.version != TOKEN_CACHE_VERSION {
                    return Err(Error::Storage(format!(
                        "token cache needs version {TOKEN_CACHE_VERSION}, got {}",
                        cache.version
                    )));
                }
                Ok(cache)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TokenCache::default()),
            Err(error) => Err(error.into()),
        }
    }

    async fn write_cache(&self, cache: &TokenCache) -> Result<()> {
        let temporary = self
            .root
            .join(format!(".token-cache-{}.tmp", uuid::Uuid::new_v4()));
        let raw = serde_json::to_vec_pretty(cache)?;
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        file.write_all(&raw).await?;
        file.sync_all().await?;
        drop(file);
        set_private_file(&temporary)?;
        tokio::fs::rename(&temporary, &self.token_cache).await?;
        Ok(())
    }
}

async fn acquire_lock(path: PathBuf, name: String, timeout: Duration) -> Result<FileLock> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        set_private_directory(parent)?;
    }
    tokio::task::spawn_blocking(move || {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let deadline = Instant::now() + timeout;
        loop {
            if file.try_lock_exclusive()? {
                return Ok(FileLock(file));
            }
            if Instant::now() >= deadline {
                return Err(Error::LockTimeout(name));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    })
    .await
    .map_err(|error| Error::Storage(format!("file lock task failed: {error}")))?
}

pub(crate) struct FileLock(std::fs::File);
impl StorageLock for FileLock {}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = fs4::fs_std::FileExt::unlock(&self.0);
    }
}

#[async_trait]
impl CredentialStore for FileStore {
    async fn load(&self, profile: &str) -> Result<Option<Token>> {
        let _lock = self.acquire_cache_lock().await?;
        Ok(self.read_cache().await?.tokens.remove(profile))
    }

    async fn save(&self, profile: &str, token: &Token) -> Result<()> {
        let _lock = self.acquire_cache_lock().await?;
        let mut cache = self.read_cache().await?;
        cache.tokens.insert(profile.to_owned(), token.clone());
        self.write_cache(&cache).await
    }

    async fn delete(&self, profile: &str) -> Result<()> {
        let _lock = self.acquire_cache_lock().await?;
        let mut cache = self.read_cache().await?;
        cache.tokens.remove(profile);
        self.write_cache(&cache).await
    }

    async fn lock(&self, profile: &str, timeout: Duration) -> Result<Box<dyn StorageLock>> {
        Ok(Box::new(self.acquire_file_lock(profile, timeout).await?))
    }

    fn name(&self) -> &'static str {
        "file"
    }
}

fn key_hash(profile: &str) -> String {
    format!("{:x}", Sha256::digest(profile.as_bytes()))
}

#[cfg(unix)]
fn set_private_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> Result<()> {
    Ok(())
}
