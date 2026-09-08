//! Cross-process exclusive file locks with bounded acquisition.

use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    time::{Duration, Instant},
};

use fs4::fs_std::FileExt;

pub struct FileLock(File);

impl FileLock {
    pub async fn acquire(
        path: impl Into<PathBuf>,
        timeout: Duration,
    ) -> Result<Self, FileLockError> {
        let path = path.into();
        tokio::task::spawn_blocking(move || {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let file = OpenOptions::new()
                .create(true)
                .read(true)
                .truncate(false)
                .write(true)
                .open(&path)?;
            let deadline = Instant::now() + timeout;
            loop {
                if file.try_lock_exclusive()? {
                    return Ok(Self(file));
                }
                if Instant::now() >= deadline {
                    return Err(FileLockError::LockTimeout(path));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })
        .await?
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FileLockError {
    #[error("timed out waiting for file lock {0}")]
    LockTimeout(PathBuf),
    #[error("file lock I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("file lock task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}
