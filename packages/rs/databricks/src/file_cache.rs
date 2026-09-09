//! File-backed TTL caching with a cross-process check-lock-check load sequence.

use std::{
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use directories::BaseDirs;
use serde::{de::DeserializeOwned, Serialize};

use crate::{FileLock, FileLockError};

/// JSON file cache with a time-to-live and cross-process refresh lock.
#[derive(Clone, Debug)]
pub struct FileCache {
    path: PathBuf,
    lock_path: PathBuf,
    ttl: Duration,
    lock_timeout: Duration,
}

impl FileCache {
    /// Create a cache at `path` with the supplied freshness duration.
    pub fn new(path: impl Into<PathBuf>, ttl: Duration) -> Self {
        let path = path.into();
        let lock_path = path.with_extension(format!(
            "{}lock",
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| format!("{extension}."))
                .unwrap_or_default()
        ));
        Self {
            path,
            lock_path,
            ttl,
            lock_timeout: Duration::from_secs(30),
        }
    }

    /// Override the maximum wait for the cross-process refresh lock.
    pub fn with_lock_timeout(mut self, timeout: Duration) -> Self {
        self.lock_timeout = timeout;
        self
    }

    /// Return the cache file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read a fresh value or load and persist it under a check-lock-check sequence.
    pub async fn get_or_try_init<T, E, Load, Fut>(&self, load: Load) -> Result<T, E>
    where
        T: Clone + DeserializeOwned + Serialize + Send + 'static,
        E: From<FileCacheError>,
        Load: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        if let Some(value) = self.read_fresh::<T>().await.map_err(E::from)? {
            return Ok(value);
        }
        let _lock = FileLock::acquire(self.lock_path.clone(), self.lock_timeout)
            .await
            .map_err(|error| E::from(FileCacheError::from(error)))?;
        if let Some(value) = self.read_fresh::<T>().await.map_err(E::from)? {
            return Ok(value);
        }
        let value = load().await?;
        self.write(&value).await.map_err(E::from)?;
        Ok(value)
    }

    /// Replace the cached value while holding the cross-process lock.
    pub async fn refresh<T, E, Load, Fut>(&self, load: Load) -> Result<T, E>
    where
        T: Clone + DeserializeOwned + Serialize + Send + 'static,
        E: From<FileCacheError>,
        Load: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let _lock = FileLock::acquire(self.lock_path.clone(), self.lock_timeout)
            .await
            .map_err(|error| E::from(FileCacheError::from(error)))?;
        let value = load().await?;
        self.write(&value).await.map_err(E::from)?;
        Ok(value)
    }

    async fn read_fresh<T>(&self) -> Result<Option<T>, FileCacheError>
    where
        T: DeserializeOwned + Send + 'static,
    {
        let path = self.path.clone();
        let ttl = self.ttl;
        tokio::task::spawn_blocking(move || {
            let metadata = match path.metadata() {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            let modified = metadata.modified()?;
            if SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default()
                >= ttl
            {
                return Ok(None);
            }
            let value = serde_json::from_slice(&std::fs::read(path)?)?;
            Ok(Some(value))
        })
        .await?
    }

    async fn write<T>(&self, value: &T) -> Result<(), FileCacheError>
    where
        T: Serialize,
    {
        let path = self.path.clone();
        let bytes = serde_json::to_vec(value)?;
        tokio::task::spawn_blocking(move || {
            let parent = path.parent().ok_or(FileCacheError::MissingParent)?;
            std::fs::create_dir_all(parent)?;
            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            temporary.write_all(&bytes)?;
            temporary.as_file().sync_all()?;
            temporary
                .persist(&path)
                .map_err(|error| FileCacheError::Io(error.error))?;
            Ok(())
        })
        .await?
    }
}

/// Return the current platform's user cache directory.
pub fn platform_cache_root() -> Result<PathBuf, FileCacheError> {
    BaseDirs::new()
        .map(|directories| directories.cache_dir().to_owned())
        .ok_or(FileCacheError::CacheDirectory)
}

#[derive(Debug, thiserror::Error)]
/// Errors returned by [`FileCache`].
pub enum FileCacheError {
    /// The operating system has no resolvable user cache directory.
    #[error("could not resolve the platform cache directory")]
    CacheDirectory,
    /// The configured cache path has no parent directory.
    #[error("cache path has no parent directory")]
    MissingParent,
    /// Acquiring the cache refresh lock failed.
    #[error(transparent)]
    Lock(#[from] FileLockError),
    /// Reading or writing cache files failed.
    #[error("cache I/O failed: {0}")]
    Io(#[from] std::io::Error),
    /// Serializing or deserializing the cached JSON failed.
    #[error("cache JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    /// A blocking cache task failed to complete.
    #[error("cache task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}
